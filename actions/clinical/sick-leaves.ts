"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import {
  clinicalRecordIdSchema,
  sickLeaveDraftSchema,
  type SickLeaveDraftInput,
} from "@/lib/validations/clinical";
import {
  finalizeClinicalRecord,
  mutationFailure,
  recordLocked,
  requireClinicalMutation,
  requireClinicalRead,
  validationFailure,
  voidClinicalRecord,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

function refreshSickLeavePaths(clinicId: string) {
  revalidateTag(`clinical:sick-leaves:${clinicId}`, {});
  revalidatePath("/patients");
  revalidatePath("/documents");
}

export async function createSickLeaveDraft(
  input: SickLeaveDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const parsed = sickLeaveDraftSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const supabase = await createClient();
  const { data, error } = await supabase.from("sick_leaves").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
    created_by: user.id,
    status: "draft",
  }).select("id").single();
  if (error || !data) return mutationFailure();
  refreshSickLeavePaths(user.clinicId);
  return { success: true, data: { id: data.id } };
}

export async function updateSickLeaveDraft(
  id: string,
  input: SickLeaveDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const idResult = clinicalRecordIdSchema.safeParse(id);
  const parsed = sickLeaveDraftSchema.safeParse(input);
  if (!idResult.success) return validationFailure(idResult.error.issues);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const supabase = await createClient();
  const { data, error } = await supabase.from("sick_leaves")
    .update(parsed.data)
    .eq("id", id).eq("clinic_id", user.clinicId).eq("status", "draft")
    .select("id").maybeSingle();
  if (error) return mutationFailure();
  if (!data) return recordLocked();
  refreshSickLeavePaths(user.clinicId);
  return { success: true, data: { id } };
}

export async function finalizeSickLeave(id: string) {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const result = await finalizeClinicalRecord("sick_leaves", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshSickLeavePaths(user.clinicId);
  }
  return result;
}

export async function voidSickLeave(id: string) {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const result = await voidClinicalRecord("sick_leaves", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshSickLeavePaths(user.clinicId);
  }
  return result;
}

export async function getSickLeave(id: string) {
  const user = await requireClinicalRead();
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return { data: null, error: await actionError("clinical.invalidId") };
  const supabase = await createClient();
  const { data, error } = await supabase.from("sick_leaves").select("*")
    .eq("id", id).eq("clinic_id", user.clinicId).maybeSingle();
  return { data: data ?? null, error: error ? await actionError("clinical.readFailed") : null };
}
