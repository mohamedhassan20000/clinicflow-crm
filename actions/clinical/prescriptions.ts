"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import {
  clinicalRecordIdSchema,
  prescriptionDraftSchema,
  type PrescriptionDraftInput,
} from "@/lib/validations/clinical";
import {
  finalizeClinicalRecord,
  hydratePrescriptionMedications,
  mutationFailure,
  recordLocked,
  requireClinicalMutation,
  requireClinicalRead,
  validationFailure,
  voidClinicalRecord,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

function refreshPrescriptionPaths(clinicId: string) {
  revalidateTag(`clinical:prescriptions:${clinicId}`, {});
  revalidatePath("/patients");
  revalidatePath("/documents");
}

export async function createPrescriptionDraft(
  input: PrescriptionDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const parsed = prescriptionDraftSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);

  let medications;
  try {
    medications = await hydratePrescriptionMedications(
      user,
      parsed.data.responsible_doctor_id,
      parsed.data.medications,
    );
  } catch {
    return mutationFailure();
  }
  if (!medications) return mutationFailure();

  const supabase = await createClient();
  const header = {
    responsible_doctor_id: parsed.data.responsible_doctor_id,
    appointment_id: parsed.data.appointment_id ?? null,
    patient_id: parsed.data.patient_id ?? null,
    subject_full_name: parsed.data.subject_full_name ?? null,
    subject_dob: parsed.data.subject_dob ?? null,
    subject_national_id: parsed.data.subject_national_id ?? null,
    valid_until: parsed.data.valid_until ?? null,
    notes: parsed.data.notes ?? null,
  };
  const { data: prescription, error } = await supabase
    .from("prescriptions")
    .insert({
      ...header,
      clinic_id: user.clinicId,
      created_by: user.id,
      status: "draft",
    })
    .select("id")
    .single();
  if (error || !prescription) return mutationFailure();

  const items = medications.map((item, index) => ({
    prescription_id: prescription.id,
    drug_catalog_id: item.drug_catalog_id ?? null,
    drug_name: item.drug_name,
    dose: item.dose ?? null,
    frequency: item.frequency ?? null,
    duration: item.duration ?? null,
    route: item.route ?? null,
    quantity: item.quantity ?? null,
    instructions: item.instructions ?? null,
    is_controlled_snapshot: item.is_controlled_snapshot,
    sort_order: item.sort_order ?? index,
  }));
  const inserted = await supabase.from("prescription_medications").insert(items);
  if (inserted.error) {
    await supabase.from("prescriptions").delete().eq("id", prescription.id);
    return mutationFailure();
  }

  refreshPrescriptionPaths(user.clinicId);
  return { success: true, data: { id: prescription.id } };
}

export async function updatePrescriptionDraft(
  id: string,
  input: PrescriptionDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const idResult = clinicalRecordIdSchema.safeParse(id);
  const parsed = prescriptionDraftSchema.safeParse(input);
  if (!idResult.success) return validationFailure(idResult.error.issues);
  if (!parsed.success) return validationFailure(parsed.error.issues);

  let medications;
  try {
    medications = await hydratePrescriptionMedications(
      user,
      parsed.data.responsible_doctor_id,
      parsed.data.medications,
    );
  } catch {
    return mutationFailure();
  }
  if (!medications) return mutationFailure();

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("prescriptions")
    .select("id, status, prescription_medications(*)")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (!existing || existing.status !== "draft") return recordLocked();

  const header = {
    responsible_doctor_id: parsed.data.responsible_doctor_id,
    appointment_id: parsed.data.appointment_id ?? null,
    patient_id: parsed.data.patient_id ?? null,
    subject_full_name: parsed.data.subject_full_name ?? null,
    subject_dob: parsed.data.subject_dob ?? null,
    subject_national_id: parsed.data.subject_national_id ?? null,
    valid_until: parsed.data.valid_until ?? null,
    notes: parsed.data.notes ?? null,
  };
  const updated = await supabase
    .from("prescriptions")
    .update(header)
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft");
  if (updated.error) return mutationFailure();

  const removed = await supabase
    .from("prescription_medications")
    .delete()
    .eq("prescription_id", id);
  if (removed.error) return mutationFailure();
  const replacement = medications.map((item, index) => ({
    prescription_id: id,
    drug_catalog_id: item.drug_catalog_id ?? null,
    drug_name: item.drug_name,
    dose: item.dose ?? null,
    frequency: item.frequency ?? null,
    duration: item.duration ?? null,
    route: item.route ?? null,
    quantity: item.quantity ?? null,
    instructions: item.instructions ?? null,
    is_controlled_snapshot: item.is_controlled_snapshot,
    sort_order: item.sort_order ?? index,
  }));
  const inserted = await supabase.from("prescription_medications").insert(replacement);
  if (inserted.error) {
    const previous = (existing.prescription_medications ?? []).map((item) => ({
      prescription_id: item.prescription_id,
      drug_catalog_id: item.drug_catalog_id,
      drug_name: item.drug_name,
      dose: item.dose,
      frequency: item.frequency,
      duration: item.duration,
      route: item.route,
      quantity: item.quantity,
      instructions: item.instructions,
      is_controlled_snapshot: item.is_controlled_snapshot,
      sort_order: item.sort_order,
    }));
    if (previous.length > 0) await supabase.from("prescription_medications").insert(previous);
    return mutationFailure();
  }

  refreshPrescriptionPaths(user.clinicId);
  return { success: true, data: { id } };
}

export async function finalizePrescription(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  await requireClinicalRead();
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("prescription_medications")
    .select("id", { count: "exact", head: true })
    .eq("prescription_id", id);
  if (error || !count) return mutationFailure();
  const result = await finalizeClinicalRecord("prescriptions", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshPrescriptionPaths(user.clinicId);
  }
  return result;
}

export async function voidPrescription(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "void" }>> {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const result = await voidClinicalRecord("prescriptions", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshPrescriptionPaths(user.clinicId);
  }
  return result;
}

export async function getPrescription(id: string) {
  const user = await requireClinicalRead();
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return { data: null, error: await actionError("clinical.invalidId") };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prescriptions")
    .select("*, prescription_medications(*)")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .order("sort_order", { referencedTable: "prescription_medications", ascending: true })
    .maybeSingle();
  return { data: data ?? null, error: error ? await actionError("clinical.readFailed") : null };
}
