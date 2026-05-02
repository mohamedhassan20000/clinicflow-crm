"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireUser } from "@/lib/rbac";
import { patientSchema, medicalNoteSchema } from "@/lib/validations/patient";
import { depositSchema } from "@/lib/validations/appointment";

export type ActionResult = { error?: string; fieldErrors?: Record<string, string[]> };

export async function createPatient(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const raw = {
    full_name: formData.get("full_name"),
    national_id: formData.get("national_id"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: formData.get("blood_type") || null,
    department_id: formData.get("department_id") || null,
    assigned_doctor_id: formData.get("assigned_doctor_id") || null,
  };

  const parsed = patientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();

  // Generate next file number for this clinic: CF-NNNN (zero-padded, sequential).
  const fileNumber = await generateFileNumber(user.clinicId);

  // Try insert; on file_number collision (rare race), retry up to 3 times.
  let lastError: { code?: string; message?: string } | null = null;
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
    lastError = error;
    if (error.code !== "23505") break;
    if (!error.message?.includes("patients_clinic_file_number_unique")) break;
  }

  if (!insertedId) {
    return { error: lastError?.message || "Failed to create patient. Please try again." };
  }

  revalidatePath("/patients");
  redirect(`/patients/${insertedId}`);
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
  const user = await requireUser();

  const raw = {
    full_name: formData.get("full_name"),
    national_id: formData.get("national_id"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: formData.get("blood_type") || null,
    department_id: formData.get("department_id") || null,
    assigned_doctor_id: formData.get("assigned_doctor_id") || null,
  };

  const parsed = patientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("patients")
    .update({ ...parsed.data, updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false);

  if (error) {
    return { error: "Failed to update patient. Please try again." };
  }

  revalidatePath(`/patients/${id}`);
  revalidatePath("/patients");
  redirect(`/patients/${id}`);
}

export async function softDeletePatient(id: string): Promise<ActionResult> {
  const user = await requireRole("admin");

  const supabase = await createClient();
  const { error } = await supabase
    .from("patients")
    .update({ is_deleted: true, updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) {
    return { error: "Failed to delete patient." };
  }

  revalidatePath("/patients");
  redirect("/patients");
}

export async function restorePatient(id: string): Promise<ActionResult> {
  const user = await requireRole("admin");

  const supabase = await createClient();
  const { error } = await supabase
    .from("patients")
    .update({ is_deleted: false, updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) {
    return { error: "Failed to restore patient." };
  }

  revalidatePath(`/patients/${id}`);
  revalidatePath("/patients");
  return {};
}

export async function addMedicalNote(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "doctor"]);

  const raw = {
    patient_id: formData.get("patient_id"),
    note: formData.get("note"),
  };

  const parsed = medicalNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("medical_notes").insert({
    patient_id: parsed.data.patient_id,
    note: parsed.data.note,
    doctor_id: user.id,
    created_by: user.id,
  });

  if (error) {
    return { error: "Failed to save note. Please try again." };
  }

  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return {};
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
  const user = await requireRole(["admin", "receptionist"]);

  const raw = {
    patient_id: String(formData.get("patient_id") ?? ""),
    amount: Number(formData.get("amount") ?? 0),
    payment_method: String(formData.get("payment_method") ?? ""),
    note: (formData.get("note") as string | null)?.toString().trim() || null,
  };

  const parsed = depositSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
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

  if (error) return { error: error.message || "Failed to add deposit." };

  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return {};
}

export async function settleOutstanding(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const patientId = String(formData.get("patient_id") ?? "");
  const appointmentId = String(formData.get("appointment_id") ?? "") || null;
  const amountRaw = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("payment_method") ?? "") as PaymentMethod;
  const secondaryAmountRaw = Number(formData.get("secondary_amount") ?? 0);
  const secondaryMethodRaw = String(
    formData.get("secondary_payment_method") ?? "",
  );
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!patientId) return { error: "Missing patient." };
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { error: "Amount must be greater than zero." };
  }
  if (!PAYMENT_METHODS.includes(method)) {
    return { error: "Select a valid payment method." };
  }

  const hasSecondary =
    Number.isFinite(secondaryAmountRaw) &&
    secondaryAmountRaw > 0 &&
    PAYMENT_METHODS.includes(secondaryMethodRaw as PaymentMethod);
  const secondaryMethod = hasSecondary
    ? (secondaryMethodRaw as PaymentMethod)
    : null;
  if (hasSecondary && secondaryMethod === method) {
    return { error: "Split methods must differ from the primary method." };
  }

  const supabase = await createClient();

  // If no specific appointment was requested, link this settlement to the
  // oldest still-outstanding appointment so the revenue settlements table can
  // surface the department + doctor it was paid against.
  let linkedAppointmentId = appointmentId;
  if (!linkedAppointmentId) {
    const { data: oldestDebt } = await supabase
      .from("appointments")
      .select("id")
      .eq("patient_id", patientId)
      .eq("clinic_id", user.clinicId)
      .gt("outstanding_amount", 0)
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    linkedAppointmentId = oldestDebt?.id ?? null;
  }

  // Insert one settlement row per method so the revenue settlements table
  // reflects each tender separately.
  const settlementRows = [
    {
      patient_id: patientId,
      appointment_id: linkedAppointmentId,
      clinic_id: user.clinicId,
      amount: Number(amountRaw.toFixed(2)),
      payment_method: method,
      note,
      created_by: user.id,
    },
    ...(hasSecondary
      ? [
          {
            patient_id: patientId,
            appointment_id: linkedAppointmentId,
            clinic_id: user.clinicId,
            amount: Number(secondaryAmountRaw.toFixed(2)),
            payment_method: secondaryMethod as PaymentMethod,
            note,
            created_by: user.id,
          },
        ]
      : []),
  ];

  const { error: insertError } = await supabase
    .from("outstanding_settlements")
    .insert(settlementRows);

  if (insertError) {
    return { error: insertError.message || "Failed to save settlement." };
  }

  // Deduct from appointments' outstanding_amount (oldest-first) until amount is exhausted.
  let remaining = Number(
    (amountRaw + (hasSecondary ? secondaryAmountRaw : 0)).toFixed(2),
  );
  const { data: debts } = await supabase
    .from("appointments")
    .select("id, outstanding_amount")
    .eq("patient_id", patientId)
    .eq("clinic_id", user.clinicId)
    .gt("outstanding_amount", 0)
    .order("scheduled_at", { ascending: true });

  for (const d of debts ?? []) {
    if (remaining <= 0) break;
    const owed = Number(d.outstanding_amount ?? 0);
    const applied = Math.min(owed, remaining);
    const next = Number((owed - applied).toFixed(2));
    await supabase
      .from("appointments")
      .update({ outstanding_amount: next })
      .eq("id", d.id)
      .eq("clinic_id", user.clinicId);
    remaining = Number((remaining - applied).toFixed(2));
  }

  revalidatePath(`/patients/${patientId}`);
  return {};
}
