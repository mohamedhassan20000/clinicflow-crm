import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  medicalNoteSchema,
  patientSchema,
} from "@/lib/validations/patient";

export const PATIENT_WRITE_ROLES = ["admin", "receptionist"] as const;
export const PATIENT_ADMIN_ROLES = ["admin"] as const;
export const MEDICAL_NOTE_WRITE_ROLES = ["admin", "doctor"] as const;
export const AI_INTAKE_REVIEW_ROLES = ["admin", "manager", "receptionist"] as const;

export const patientCreateSchema = patientSchema.strict();
export const patientUpdateSchema = patientSchema
  .extend({ patient_id: z.string().uuid() })
  .strict();
export const patientIdSchema = z
  .object({ patient_id: z.string().uuid() })
  .strict();
export const medicalNoteCreateSchema = medicalNoteSchema.strict();
export const medicalNoteUpdateSchema = z
  .object({
    note_id: z.string().uuid(),
    note: z.string().trim().min(1).max(5000),
  })
  .strict();
export const medicalNoteIdSchema = z
  .object({ note_id: z.string().uuid() })
  .strict();

type PatientMutationData = {
  patient_id: string;
  file_number?: string;
};
type MedicalNoteMutationData = {
  note_id: string;
  patient_id: string;
};
type AiIntakeApprovalMutationData = {
  patient_id: string;
  appointment_id: string | null;
  already_processed: boolean;
};

/**
 * Human approval deliberately enters through the same patientCreateSchema used
 * by the New Patient form. The RPC repeats every reference/duplicate check and
 * performs patient + conversation + appointment linking in one transaction;
 * this domain boundary prevents the review surface from becoming a second,
 * inconsistent patient schema before that transaction begins.
 */
export async function approveAiPatientIntakeMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AiIntakeApprovalMutationData>> {
  assertDomainMutationRole(user, AI_INTAKE_REVIEW_ROLES);
  const parsed = z.object({ intake_id: z.string().uuid() }).strict().safeParse(input);
  if (!parsed.success) {
    return domainFailure("patients.failedToCreatePatientPleaseTryAgain", {
      validationError: parsed.error,
    });
  }
  const supabase = await createClient();
  const { data: intake, error: intakeError } = await supabase
    .from("ai_patient_intakes")
    .select(
      "id, full_name, national_id, date_of_birth, phone, email, blood_type, department_id, doctor_id, review_status",
    )
    .eq("id", parsed.data.intake_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (intakeError || !intake) return domainFailure("patients.patientNotFound");

  const patientValues = patientCreateSchema.safeParse({
    full_name: intake.full_name,
    national_id: intake.national_id,
    date_of_birth: intake.date_of_birth,
    phone: intake.phone,
    email: intake.email,
    blood_type: intake.blood_type,
    department_id: intake.department_id,
    assigned_doctor_id: intake.doctor_id,
    insurance_provider_id: null,
  });
  if (!patientValues.success) {
    return domainFailure("patients.failedToCreatePatientPleaseTryAgain", {
      validationError: patientValues.error,
    });
  }
  if (mode === "preview") {
    return domainSuccess(
      {
        patient_id: "00000000-0000-0000-0000-000000000000",
        appointment_id: null,
        already_processed: intake.review_status === "approved",
      },
      { targetTable: "patients", after: patientValues.data },
    );
  }
  const { data, error } = await supabase.rpc("approve_ai_patient_intake", {
    p_intake_id: parsed.data.intake_id,
    p_actor_id: user.id,
  });
  const row = data?.[0];
  if (error || !row) return domainFailure("patients.failedToCreatePatientPleaseTryAgain");
  revalidatePath("/patients");
  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  return domainSuccess(
    {
      patient_id: row.patient_id,
      appointment_id: row.appointment_id,
      already_processed: row.already_processed,
    },
    {
      targetTable: "patients",
      targetRecordIds: [row.patient_id],
      after: patientValues.data,
    },
  );
}

async function validateInsurance(
  insuranceProviderId: string | null | undefined,
  clinicId: string,
) {
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
  if (error)
    return domainFailure(
      "patients.failedToValidateInsuranceProviderPleaseTryAgain",
    );
  if (!data)
    return domainFailure("patients.selectAnActiveInsuranceProvider", {
      fieldErrorCodes: {
        insurance_provider_id: ["patients.selectAnActiveInsuranceProvider"],
      },
    });
  return null;
}

/**
 * The next `CF-NNNN` for this clinic.
 *
 * Ordered on the *number*, not on the text. `order by file_number desc` is a
 * string sort: once `CF-10000` exists it still returns `CF-9999`, so the next
 * candidate is `CF-10000` again and every subsequent create fails the unique
 * index forever. Reading the whole prefixed set and taking a numeric maximum
 * costs one indexed scan and cannot hit that boundary. The caller's bounded
 * retry, and the advisory lock the WhatsApp registration RPC takes, are what
 * handle two allocators landing on the same number concurrently.
 */
async function nextFileNumber(clinicId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("patients")
    .select("file_number")
    .eq("clinic_id", clinicId)
    .like("file_number", "CF-%");
  let highest = 0;
  for (const row of data ?? []) {
    if (!/^CF-\d+$/.test(row.file_number)) continue;
    const value = Number.parseInt(row.file_number.slice(3), 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return `CF-${String(highest + 1).padStart(4, "0")}`;
}

export async function createPatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PatientMutationData>> {
  assertDomainMutationRole(user, PATIENT_WRITE_ROLES);
  const parsed = patientCreateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.failedToCreatePatientPleaseTryAgain", {
      validationError: parsed.error,
    });
  const insuranceError = await validateInsurance(
    parsed.data.insurance_provider_id,
    user.clinicId,
  );
  if (insuranceError) return insuranceError;
  const fileNumber = await nextFileNumber(user.clinicId);
  if (mode === "preview") {
    return domainSuccess(
      { patient_id: "00000000-0000-0000-0000-000000000000", file_number: fileNumber },
      { targetTable: "patients", after: { ...parsed.data, file_number: fileNumber } },
    );
  }
  const supabase = await createClient();
  let insertedId: string | null = null;
  let insertedFileNumber = fileNumber;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = attempt === 0 ? fileNumber : await nextFileNumber(user.clinicId);
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
      insertedFileNumber = candidate;
      break;
    }
    if (
      error.code !== "23505" ||
      !error.message?.includes("patients_clinic_file_number_unique")
    ) {
      break;
    }
  }
  if (!insertedId)
    return domainFailure("patients.failedToCreatePatientPleaseTryAgain");
  revalidatePath("/patients");
  return domainSuccess(
    { patient_id: insertedId, file_number: insertedFileNumber },
    {
      targetTable: "patients",
      targetRecordIds: [insertedId],
      after: { ...parsed.data, id: insertedId, file_number: insertedFileNumber },
    },
  );
}

export async function updatePatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PatientMutationData>> {
  assertDomainMutationRole(user, PATIENT_WRITE_ROLES);
  const parsed = patientUpdateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.failedToUpdatePatientPleaseTryAgain", {
      validationError: parsed.error,
    });
  const { patient_id: patientId, ...values } = parsed.data;
  const insuranceError = await validateInsurance(
    values.insurance_provider_id,
    user.clinicId,
  );
  if (insuranceError) return insuranceError;
  if (mode === "preview") {
    const supabase = await createClient();
    const { data: existing, error: readError } = await supabase
      .from("patients")
      .select(
        "id, full_name, national_id, date_of_birth, phone, email, blood_type, department_id, assigned_doctor_id, insurance_provider_id, file_number",
      )
      .eq("id", patientId)
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false)
      .maybeSingle();
    if (readError || !existing)
      return domainFailure("patients.patientNotFound");
    return domainSuccess(
      { patient_id: patientId, file_number: existing.file_number },
      {
        targetTable: "patients",
        targetRecordIds: [patientId],
        before: existing,
        after: { ...existing, ...values },
      },
    );
  }
  const supabase = await createClient();
  const updated = await supabase
    .from("patients")
    .update({ ...values, updated_by: user.id })
    .eq("id", patientId)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false);
  if (updated.error)
    return domainFailure("patients.failedToUpdatePatientPleaseTryAgain");
  revalidatePath(`/patients/${patientId}`);
  revalidatePath("/patients");
  return domainSuccess(
    { patient_id: patientId },
    {
      targetTable: "patients",
      targetRecordIds: [patientId],
      after: values,
    },
  );
}

async function mutatePatientLifecycle(
  user: AuthedUser,
  input: unknown,
  operation: "soft_delete" | "restore" | "archive",
  mode: DomainMutationMode,
): Promise<DomainMutationResult<PatientMutationData>> {
  assertDomainMutationRole(
    user,
    operation === "soft_delete" ? PATIENT_WRITE_ROLES : PATIENT_ADMIN_ROLES,
  );
  const parsed = patientIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.patientNotFound", {
      validationError: parsed.error,
    });
  const now = new Date().toISOString();
  const after =
    operation === "soft_delete"
      ? { is_deleted: true, deleted_at: now }
      : operation === "archive"
        ? { is_archived: true, archived_at: now }
        : {
            is_deleted: false,
            is_archived: false,
            deleted_at: null,
            archived_at: null,
          };
  if (mode === "preview") {
    const admin = createClinicScopedAdminClient(user.clinicId);
    let lookup = admin
      .from("patients")
      .select(
        "id, full_name, file_number, is_deleted, is_archived, deleted_at, archived_at",
      )
      .eq("id", parsed.data.patient_id)
      .eq("clinic_id", user.clinicId);
    if (operation === "soft_delete") {
      lookup = lookup.eq("is_deleted", false);
    } else if (operation === "archive") {
      lookup = lookup.eq("is_deleted", true).eq("is_archived", false);
    }
    const { data: existing, error: lookupError } = await lookup.maybeSingle();
    if (lookupError || !existing) {
      return domainFailure("patients.patientNotFound");
    }
    return domainSuccess(
      { patient_id: parsed.data.patient_id },
      {
        targetTable: "patients",
        targetRecordIds: [parsed.data.patient_id],
        before: existing,
        after: { ...existing, ...after },
      },
    );
  }
  const supabase = await createClient();
  if (operation === "soft_delete") {
    const deleted = await supabase.rpc("soft_delete_patient", {
      p_patient_id: parsed.data.patient_id,
    });
    if (deleted.error) {
      console.error("patient_soft_delete_failed", {
        patientId: parsed.data.patient_id,
        clinicId: user.clinicId,
        code: deleted.error.code ?? null,
        message: deleted.error.message,
        details: deleted.error.details ?? null,
        hint: deleted.error.hint ?? null,
      });
      return domainFailure("patients.failedToDeletePatient");
    }
    if (deleted.data === false) return domainFailure("patients.patientNotFound");
    const stamped = await supabase
      .from("patients")
      .update({ deleted_at: now })
      .eq("id", parsed.data.patient_id)
      .eq("clinic_id", user.clinicId);
    if (stamped.error) return domainFailure("patients.failedToDeletePatient");
  } else {
    let query = supabase
      .from("patients")
      .update({ ...after, updated_by: user.id })
      .eq("id", parsed.data.patient_id)
      .eq("clinic_id", user.clinicId);
    if (operation === "archive") {
      query = query.eq("is_deleted", true).eq("is_archived", false);
    }
    const updated = await query;
    if (updated.error)
      return domainFailure(
        operation === "archive"
          ? "patients.failedToArchivePatient"
          : "patients.failedToRestorePatient",
      );
  }
  revalidatePath(`/patients/${parsed.data.patient_id}`);
  revalidatePath("/patients");
  revalidatePath("/patients/trash");
  revalidatePath("/patients/archive");
  return domainSuccess(
    { patient_id: parsed.data.patient_id },
    {
      targetTable: "patients",
      targetRecordIds: [parsed.data.patient_id],
      after,
    },
  );
}

export function softDeletePatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
) {
  return mutatePatientLifecycle(user, input, "soft_delete", mode);
}

export function restorePatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
) {
  return mutatePatientLifecycle(user, input, "restore", mode);
}

export function archivePatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
) {
  return mutatePatientLifecycle(user, input, "archive", mode);
}

async function activeMedicalNote(user: AuthedUser, noteId: string) {
  const supabase = await createClient();
  const result = await supabase
    .from("medical_notes")
    .select("id, patient_id, doctor_id, created_by, note, deleted_at")
    .eq("id", noteId)
    .is("deleted_at", null)
    .maybeSingle();
  return {
    supabase,
    ...result,
    data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
  };
}

function mayMutateNote(user: AuthedUser, createdBy: string | null) {
  return user.role === "admin" || createdBy === user.id;
}

export async function addMedicalNoteMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<MedicalNoteMutationData>> {
  assertDomainMutationRole(user, MEDICAL_NOTE_WRITE_ROLES);
  const parsed = medicalNoteCreateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.failedToSaveNotePleaseTryAgain", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const patient = await supabase
    .from("patients")
    .select("id, department_id, assigned_doctor_id")
    .eq("id", parsed.data.patient_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (patient.error || !patient.data)
    return domainFailure("patients.patientNotFoundOrYouDoNotHavePermission");
  if (
    user.role === "doctor" &&
    patient.data.assigned_doctor_id !== user.id &&
    (!user.departmentId || patient.data.department_id !== user.departmentId)
  ) {
    return domainFailure("patients.patientNotFoundOrYouDoNotHavePermission");
  }
  const next = {
    patient_id: parsed.data.patient_id,
    appointment_id: parsed.data.appointment_id ?? null,
    note: parsed.data.note,
    doctor_id: user.id,
    created_by: user.id,
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        note_id: "00000000-0000-0000-0000-000000000000",
        patient_id: parsed.data.patient_id,
      },
      { targetTable: "medical_notes", after: next },
    );
  }
  const noteId = crypto.randomUUID();
  const inserted = await supabase
    .from("medical_notes")
    .insert({ id: noteId, ...next });
  if (inserted.error)
    return domainFailure("patients.failedToSaveNotePleaseTryAgain");
  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return domainSuccess(
    { note_id: noteId, patient_id: parsed.data.patient_id },
    {
      targetTable: "medical_notes",
      targetRecordIds: [noteId],
      after: { ...next, id: noteId },
    },
  );
}

export async function updateMedicalNoteMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<MedicalNoteMutationData>> {
  assertDomainMutationRole(user, MEDICAL_NOTE_WRITE_ROLES);
  const parsed = medicalNoteUpdateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.noteIsRequired", {
      validationError: parsed.error,
    });
  const { supabase, data: existing, error } = await activeMedicalNote(
    user,
    parsed.data.note_id,
  );
  if (error) return domainFailure("patients.failedToFindNote");
  if (!existing) return domainFailure("patients.medicalNoteNotFound");
  if (!mayMutateNote(user, existing.created_by))
    return domainFailure("patients.youCanOnlyEditYourOwnMedicalNotes");
  if (mode === "preview") {
    return domainSuccess(
      { note_id: existing.id, patient_id: existing.patient_id },
      {
        targetTable: "medical_notes",
        targetRecordIds: [existing.id],
        before: existing,
        after: { ...existing, note: parsed.data.note },
      },
    );
  }
  const updated = await supabase
    .from("medical_notes")
    .update({ note: parsed.data.note })
    .eq("id", existing.id);
  if (updated.error) return domainFailure("patients.failedToUpdateNote");
  revalidatePath(`/patients/${existing.patient_id}`);
  return domainSuccess(
    { note_id: existing.id, patient_id: existing.patient_id },
    {
      targetTable: "medical_notes",
      targetRecordIds: [existing.id],
      before: existing,
      after: { ...existing, note: parsed.data.note },
    },
  );
}

export async function deleteMedicalNoteMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<MedicalNoteMutationData>> {
  assertDomainMutationRole(user, MEDICAL_NOTE_WRITE_ROLES);
  const parsed = medicalNoteIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.medicalNoteNotFound", {
      validationError: parsed.error,
    });
  const { supabase, data: existing, error } = await activeMedicalNote(
    user,
    parsed.data.note_id,
  );
  if (error) return domainFailure("patients.failedToFindNote");
  if (!existing) return domainFailure("patients.medicalNoteNotFound");
  if (!mayMutateNote(user, existing.created_by))
    return domainFailure("patients.youCanOnlyDeleteYourOwnMedicalNotes");
  const deletedAt = new Date().toISOString();
  if (mode === "preview") {
    return domainSuccess(
      { note_id: existing.id, patient_id: existing.patient_id },
      {
        targetTable: "medical_notes",
        targetRecordIds: [existing.id],
        before: existing,
        after: { ...existing, deleted_at: deletedAt },
      },
    );
  }
  const updated = await supabase
    .from("medical_notes")
    .update({ deleted_at: deletedAt })
    .eq("id", existing.id);
  if (updated.error) return domainFailure("patients.failedToDeleteNote");
  revalidatePath(`/patients/${existing.patient_id}`);
  return domainSuccess(
    { note_id: existing.id, patient_id: existing.patient_id },
    {
      targetTable: "medical_notes",
      targetRecordIds: [existing.id],
      before: existing,
      after: { ...existing, deleted_at: deletedAt },
    },
  );
}

export async function restoreMedicalNoteMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<MedicalNoteMutationData>> {
  assertDomainMutationRole(user, MEDICAL_NOTE_WRITE_ROLES);
  const parsed = medicalNoteIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.medicalNoteNotFound", {
      validationError: parsed.error,
    });
  // Soft-deleted notes are intentionally absent from the session client's
  // SELECT policy. Use the same tenant-bound admin lookup as the legacy action,
  // then re-apply the original patient and author checks before preview or write.
  const admin = createClinicScopedAdminClient(user.clinicId);
  const notes = await admin
    .from("medical_notes")
    .select("id, patient_id, doctor_id, created_by, note, deleted_at")
    .eq("id", parsed.data.note_id)
    .limit(1);
  if (notes.error) return domainFailure("patients.failedToFindNote");
  const note = notes.data?.[0];
  if (!note) return domainFailure("patients.medicalNoteNotFound");
  const patient = await admin
    .from("patients")
    .select("id")
    .eq("id", note.patient_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .limit(1);
  if (patient.error) return domainFailure("patients.failedToFindPatient");
  if (!patient.data?.[0]) return domainFailure("patients.medicalNoteNotFound");
  if (!mayMutateNote(user, note.created_by))
    return domainFailure("patients.youCanOnlyRestoreYourOwnMedicalNotes");
  if (mode === "preview") {
    return domainSuccess(
      { note_id: note.id, patient_id: note.patient_id },
      {
        targetTable: "medical_notes",
        targetRecordIds: [note.id],
        before: note,
        after: { ...note, deleted_at: null },
      },
    );
  }
  const restored = await admin
    .from("medical_notes")
    .update({ deleted_at: null })
    .eq("id", note.id)
    .select("id");
  if (restored.error) return domainFailure("patients.failedToRestoreNote");
  if (restored.data?.length !== 1)
    return domainFailure("patients.medicalNoteNotFound");
  revalidatePath(`/patients/${note.patient_id}`);
  return domainSuccess(
    { note_id: note.id, patient_id: note.patient_id },
    {
      targetTable: "medical_notes",
      targetRecordIds: [note.id],
      before: note,
      after: { ...note, deleted_at: null },
    },
  );
}
