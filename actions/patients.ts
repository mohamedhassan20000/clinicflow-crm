"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireUser } from "@/lib/rbac";
import { patientSchema, medicalNoteSchema } from "@/lib/validations/patient";

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
  const user = await requireRole("admin");

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
