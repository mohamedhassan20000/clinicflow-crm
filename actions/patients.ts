"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { localizeZodFieldErrors } from "@/lib/validations/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole, requireRole, type AuthedUser } from "@/lib/rbac";
import { patientSchema, medicalNoteSchema } from "@/lib/validations/patient";
import { depositSchema } from "@/lib/validations/appointment";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  patientId?: string;
};

type SupabaseErrorDetails = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

function logSupabaseError(
  context: string,
  error: SupabaseErrorDetails | null | undefined,
  metadata: Record<string, string | null | undefined>,
) {
  if (!error) return;
  console.error(context, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
    ...metadata,
  });
}

async function getMedicalNoteForClinic(noteId: string, clinicId: string) {
  if (!noteId) return null;

  const adminClient = createClinicScopedAdminClient(clinicId);
  const { data: notes, error: noteError } = await adminClient
    .from("medical_notes")
    .select("id, patient_id, doctor_id, created_by, created_at, note, deleted_at")
    .eq("id", noteId)
    .is("deleted_at", null)
    .limit(1);

  if (noteError) throw new Error(noteError.message);

  const note = notes?.[0];
  if (!note) return null;

  const { data: patients, error: patientError } = await adminClient
    .from("patients")
    .select("id")
    .eq("id", note.patient_id)
    .eq("clinic_id", clinicId)
    .limit(1);

  if (patientError) throw new Error(patientError.message);
  if (!patients?.[0]) return null;

  return note;
}

async function canAccessPatientForMedicalNotes(
  patientId: string,
  user: AuthedUser,
): Promise<boolean> {
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { data: patient, error } = await adminClient
    .from("patients")
    .select("id, department_id, assigned_doctor_id")
    .eq("id", patientId)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .single();

  if (error || !patient) return false;
  if (user.role === "admin") return true;
  if (user.role !== "doctor") return false;

  return (
    patient.assigned_doctor_id === user.id ||
    (!!user.departmentId && patient.department_id === user.departmentId)
  );
}

function canMutateMedicalNote(
  note: { created_by: string | null } | null,
  user: AuthedUser,
): boolean {
  if (!note) return false;
  if (user.role === "admin") return true;
  return note.created_by === user.id;
}

function nullableFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return value && value !== "none" ? value : null;
}

async function validatePatientInsuranceProvider(
  insuranceProviderId: string | null | undefined,
  clinicId: string,
): Promise<ActionResult | null> {
  if (!insuranceProviderId) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("insurance_providers")
    .select("id")
    .eq("id", insuranceProviderId)
    .eq("clinic_id", clinicId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    return { error: await actionError("patients.failedToValidateInsuranceProviderPleaseTryAgain") };
  }

  if (!data) {
    return {
      fieldErrors: {
        insurance_provider_id: [await actionError("patients.selectAnActiveInsuranceProvider")],
      },
    };
  }

  return null;
}

export async function createPatient(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const raw = {
    full_name: formData.get("full_name"),
    national_id: formData.get("national_id"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: nullableFormValue(formData, "blood_type"),
    department_id: nullableFormValue(formData, "department_id"),
    assigned_doctor_id: nullableFormValue(formData, "assigned_doctor_id"),
    insurance_provider_id: nullableFormValue(formData, "insurance_provider_id"),
  };

  const parsed = patientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  const insuranceError = await validatePatientInsuranceProvider(
    parsed.data.insurance_provider_id,
    user.clinicId,
  );
  if (insuranceError) return insuranceError;

  const supabase = await createClient();

  // Generate next file number for this clinic: CF-NNNN (zero-padded, sequential).
  const fileNumber = await generateFileNumber(user.clinicId);

  // Try insert; on file_number collision (rare race), retry up to 3 times.
  let insertedId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate =
      attempt === 0 ? fileNumber : await generateFileNumber(user.clinicId);
    const { data, error } = await supabase
      .from("patients")
      .insert({
        ...parsed.data,
        file_number: candidate,
        clinic_id: user.clinicId,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (!error) {
      insertedId = data.id;
      break;
    }
    console.error("patient_create_attempt_failed", {
      attempt: attempt + 1,
      code: error.code,
      message: error.message,
    });
    if (error.code !== "23505") break;
    if (!error.message?.includes("patients_clinic_file_number_unique")) break;
  }

  if (!insertedId) {
    return { error: await actionError("patients.failedToCreatePatientPleaseTryAgain") };
  }

  revalidatePath("/patients");
  return { success: true, patientId: insertedId };
}

async function generateFileNumber(clinicId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("patients")
    .select("file_number")
    .eq("clinic_id", clinicId)
    .like("file_number", "CF-%")
    .order("file_number", { ascending: false })
    .limit(1);
  const last = data?.[0]?.file_number;
  const n =
    last && /^CF-\d+$/.test(last)
      ? parseInt(last.slice(3), 10) + 1
      : (data ? data.length : 0) + 1;
  return `CF-${String(n).padStart(4, "0")}`;
}

export async function updatePatient(
  id: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const raw = {
    full_name: formData.get("full_name"),
    national_id: formData.get("national_id"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: nullableFormValue(formData, "blood_type"),
    department_id: nullableFormValue(formData, "department_id"),
    assigned_doctor_id: nullableFormValue(formData, "assigned_doctor_id"),
    insurance_provider_id: nullableFormValue(formData, "insurance_provider_id"),
  };

  const parsed = patientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  const insuranceError = await validatePatientInsuranceProvider(
    parsed.data.insurance_provider_id,
    user.clinicId,
  );
  if (insuranceError) return insuranceError;

  const supabase = await createClient();
  const { error } = await supabase
    .from("patients")
    .update({ ...parsed.data, updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false);

  if (error) {
    return { error: await actionError("patients.failedToUpdatePatientPleaseTryAgain") };
  }

  revalidatePath(`/patients/${id}`);
  revalidatePath("/patients");
  redirect(`/patients/${id}`);
}

export async function softDeletePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("soft_delete_patient", {
    p_patient_id: id,
  });

  if (error) {
    logSupabaseError("patient_soft_delete_failed", error, {
      clinicId: user.clinicId,
      patientId: id,
    });
    return { error: await actionError("patients.failedToDeletePatient") };
  }

  if (data === false) {
    return { error: await actionError("patients.patientNotFound") };
  }

  // Stamp deleted_at so trash page can show age and enforce 30-day rule.
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  await adminClient
    .from("patients")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  revalidatePath("/patients");
  redirect("/patients");
}

export async function restorePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole("admin");

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { error } = await adminClient
    .from("patients")
    .update({
      is_deleted: false,
      is_archived: false,
      deleted_at: null,
      archived_at: null,
      updated_by: user.id,
    })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) {
    return { error: await actionError("patients.failedToRestorePatient") };
  }

  revalidatePath(`/patients/${id}`);
  revalidatePath("/patients");
  revalidatePath("/patients/trash");
  revalidatePath("/patients/archive");
  return {};
}

// ── Trash & Archive ───────────────────────────────────────────────────────────

export type PatientStub = {
  id: string;
  full_name: string;
  file_number: string;
  national_id: string;
  phone: string;
  department_id: string | null;
  deleted_at: string | null;
  archived_at: string | null;
  departments: { id: string; name: string; color: string | null } | null;
};

export async function getTrashPatients(): Promise<{ data?: PatientStub[]; error?: string }> {
  const user = await requireRole(["admin", "receptionist"]);
  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { data, error } = await adminClient
    .from("patients")
    .select("id, full_name, file_number, national_id, phone, department_id, deleted_at, archived_at, departments(id, name, color)")
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", true)
    .eq("is_archived", false)
    .order("deleted_at", { ascending: false });

  if (error) return { error: await actionError("patients.failedToLoadTrash") };
  return { data: (data ?? []) as PatientStub[] };
}

export async function getArchivePatients(): Promise<{ data?: PatientStub[]; error?: string }> {
  const user = await requireRole(["admin", "receptionist"]);
  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { data, error } = await adminClient
    .from("patients")
    .select("id, full_name, file_number, national_id, phone, department_id, deleted_at, archived_at, departments(id, name, color)")
    .eq("clinic_id", user.clinicId)
    .eq("is_archived", true)
    .order("archived_at", { ascending: false });

  if (error) return { error: await actionError("patients.failedToLoadArchive") };
  return { data: (data ?? []) as PatientStub[] };
}

export async function archivePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole("admin");
  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { error } = await adminClient
    .from("patients")
    .update({ is_archived: true, archived_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", true)
    .eq("is_archived", false);

  if (error) return { error: await actionError("patients.failedToArchivePatient") };

  revalidatePath("/patients/trash");
  revalidatePath("/patients/archive");
  return { success: true };
}

export async function archiveAllTrashPatients(olderThanDays?: number): Promise<ActionResult> {
  const user = await requireMutationRole("admin");
  const adminClient = createClinicScopedAdminClient(user.clinicId);

  let query = adminClient
    .from("patients")
    .update({ is_archived: true, archived_at: new Date().toISOString(), updated_by: user.id })
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", true)
    .eq("is_archived", false);

  if (olderThanDays != null) {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    query = query.lt("deleted_at", cutoff);
  }

  const { error } = await query;
  if (error) return { error: await actionError("patients.failedToArchivePatients") };

  revalidatePath("/patients/trash");
  revalidatePath("/patients/archive");
  return { success: true };
}

export async function restoreArchivedPatient(id: string): Promise<ActionResult> {
  return restorePatient(id);
}

export async function addMedicalNote(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);

  const raw = {
    patient_id: formData.get("patient_id"),
    appointment_id: formData.get("appointment_id") || null,
    note: formData.get("note"),
  };

  const parsed = medicalNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  if (!(await canAccessPatientForMedicalNotes(parsed.data.patient_id, user))) {
    return { error: await actionError("patients.patientNotFoundOrYouDoNotHavePermission") };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("medical_notes").insert({
    patient_id: parsed.data.patient_id,
    appointment_id: parsed.data.appointment_id ?? null,
    note: parsed.data.note,
    doctor_id: user.id,
    created_by: user.id,
  });

  if (error) {
    return { error: await actionError("patients.failedToSaveNotePleaseTryAgain") };
  }

  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return {};
}

export async function updateMedicalNote(
  noteId: string,
  note: string,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  const trimmed = note.trim();
  if (!trimmed) return { error: await actionError("patients.noteIsRequired") };
  if (trimmed.length > 5000) return { error: await actionError("patients.noteIsTooLong") };

  let existing: Awaited<ReturnType<typeof getMedicalNoteForClinic>>;
  try {
    existing = await getMedicalNoteForClinic(noteId, user.clinicId);
  } catch (error) {
    console.error("medical_note_lookup_failed", { noteId, error });
    return {
      error: await actionError("patients.failedToFindNote"),
    };
  }
  if (!existing) return { error: await actionError("patients.medicalNoteNotFound") };
  if (!canMutateMedicalNote(existing, user)) {
    return { error: await actionError("patients.youCanOnlyEditYourOwnMedicalNotes") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { error } = await adminClient
    .from("medical_notes")
    .update({ note: trimmed })
    .eq("id", existing.id);

  if (error) return { error: await actionError("patients.failedToUpdateNote") };

  revalidatePath(`/patients/${existing.patient_id}`);
  return {};
}

export async function deleteMedicalNote(noteId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  let existing: Awaited<ReturnType<typeof getMedicalNoteForClinic>>;
  try {
    existing = await getMedicalNoteForClinic(noteId, user.clinicId);
  } catch (error) {
    console.error("medical_note_lookup_failed", { noteId, error });
    return {
      error: await actionError("patients.failedToFindNote"),
    };
  }
  if (!existing) return { error: await actionError("patients.medicalNoteNotFound") };
  if (!canMutateMedicalNote(existing, user)) {
    return { error: await actionError("patients.youCanOnlyDeleteYourOwnMedicalNotes") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { error } = await adminClient
    .from("medical_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", existing.id);

  if (error) return { error: await actionError("patients.failedToDeleteNote") };

  revalidatePath(`/patients/${existing.patient_id}`);
  return { success: true };
}

export async function restoreMedicalNote(noteId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { data: notes, error: noteError } = await adminClient
    .from("medical_notes")
    .select("id, patient_id, doctor_id, created_by, deleted_at")
    .eq("id", noteId)
    .limit(1);

  if (noteError) return { error: await actionError("patients.failedToFindNote") };
  const note = notes?.[0];
  if (!note) return { error: await actionError("patients.medicalNoteNotFound") };

  const { data: patients, error: patientError } = await adminClient
    .from("patients")
    .select("id")
    .eq("id", note.patient_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .limit(1);

  if (patientError) return { error: await actionError("patients.failedToFindPatient") };
  if (!patients?.[0]) return { error: await actionError("patients.medicalNoteNotFound") };
  if (!canMutateMedicalNote(note, user)) {
    return { error: await actionError("patients.youCanOnlyRestoreYourOwnMedicalNotes") };
  }

  const { error } = await adminClient
    .from("medical_notes")
    .update({ deleted_at: null })
    .eq("id", note.id);

  if (error) return { error: await actionError("patients.failedToRestoreNote") };

  revalidatePath(`/patients/${note.patient_id}`);
  return { success: true };
}

const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
  "insurance",
] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Returns a patient's account balance — the un-spent portion of their deposits.
 * balance = sum(patient_deposits.amount) − sum(appointments.deposit_amount across all statuses)
 */
export async function getPatientAccountBalance(
  patientId: string,
  clinicId: string,
): Promise<number> {
  const supabase = await createClient();
  const [{ data: deposits }, { data: appts }] = await Promise.all([
    supabase
      .from("patient_deposits")
      .select("amount")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId),
    supabase
      .from("appointments")
      .select("deposit_amount")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId),
  ]);
  const totalDeposited = (deposits ?? []).reduce(
    (s, r) => s + Number(r.amount ?? 0),
    0,
  );
  const totalSpent = (appts ?? []).reduce(
    (s, r) => s + Number(r.deposit_amount ?? 0),
    0,
  );
  return Math.max(0, Number((totalDeposited - totalSpent).toFixed(2)));
}

export async function addPatientDeposit(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const raw = {
    patient_id: String(formData.get("patient_id") ?? ""),
    amount: Number(formData.get("amount") ?? 0),
    payment_method: String(formData.get("payment_method") ?? ""),
    note: (formData.get("note") as string | null)?.toString().trim() || null,
  };

  const parsed = depositSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("patient_deposits").insert({
    patient_id: parsed.data.patient_id,
    clinic_id: user.clinicId,
    amount: Number(parsed.data.amount.toFixed(2)),
    payment_method: parsed.data.payment_method,
    note: parsed.data.note ?? null,
    created_by: user.id,
  });

  if (error) return { error: await actionError("patients.failedToAddDeposit") };

  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return {};
}

export async function settleOutstanding(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireMutationRole(["admin", "receptionist"]);

  const patientId = String(formData.get("patient_id") ?? "");
  const appointmentId = String(formData.get("appointment_id") ?? "") || null;
  const amountRaw = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("payment_method") ?? "") as PaymentMethod;
  const secondaryAmountRaw = Number(formData.get("secondary_amount") ?? 0);
  const secondaryMethodRaw = String(
    formData.get("secondary_payment_method") ?? "",
  );
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!patientId) return { error: await actionError("patients.missingPatient") };
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { error: await actionError("patients.amountMustBeGreaterThanZero") };
  }
  if (!PAYMENT_METHODS.includes(method)) {
    return { error: await actionError("patients.selectAValidPaymentMethod") };
  }

  const hasSecondary =
    Number.isFinite(secondaryAmountRaw) &&
    secondaryAmountRaw > 0 &&
    PAYMENT_METHODS.includes(secondaryMethodRaw as PaymentMethod);
  const secondaryMethod = hasSecondary
    ? (secondaryMethodRaw as PaymentMethod)
    : null;
  if (hasSecondary && secondaryMethod === method) {
    return { error: await actionError("patients.splitMethodsMustDifferFromThePrimaryMethod") };
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("settle_patient_outstanding", {
    p_patient_id: patientId,
    p_appointment_id: appointmentId ?? undefined,
    p_amount: Number(amountRaw.toFixed(2)),
    p_payment_method: method,
    p_secondary_amount: hasSecondary
      ? Number(secondaryAmountRaw.toFixed(2))
      : 0,
    p_secondary_payment_method: hasSecondary
      ? (secondaryMethodRaw as PaymentMethod)
      : undefined,
    p_note: note ?? undefined,
  });

  if (error) {
    return { error: await actionError("patients.failedToSaveSettlement") };
  }

  revalidatePath(`/patients/${patientId}`);
  return {};
}
