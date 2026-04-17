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
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: formData.get("blood_type") || null,
  };

  const parsed = patientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .insert({
      ...parsed.data,
      clinic_id: user.clinicId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { error: "A patient with this email already exists." };
    }
    return { error: "Failed to create patient. Please try again." };
  }

  revalidatePath("/patients");
  redirect(`/patients/${data.id}`);
}

export async function updatePatient(
  id: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const raw = {
    full_name: formData.get("full_name"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: formData.get("blood_type") || null,
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
