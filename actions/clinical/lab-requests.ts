"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import {
  clinicalRecordIdSchema,
  labRequestDraftSchema,
  type LabRequestDraftInput,
} from "@/lib/validations/clinical";
import {
  finalizeClinicalRecord,
  hydrateLabRequestTests,
  mutationFailure,
  recordLocked,
  requireClinicalMutation,
  requireClinicalRead,
  validationFailure,
  voidClinicalRecord,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

function refreshLabRequestPaths(clinicId: string) {
  revalidateTag(`clinical:lab-requests:${clinicId}`, {});
  revalidatePath("/patients");
  revalidatePath("/documents");
}

export async function createLabRequestDraft(
  input: LabRequestDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const parsed = labRequestDraftSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  let tests;
  try {
    tests = await hydrateLabRequestTests(user, parsed.data.responsible_doctor_id, parsed.data.tests);
  } catch {
    return mutationFailure();
  }
  if (!tests) return mutationFailure();

  const supabase = await createClient();
  const header = {
    responsible_doctor_id: parsed.data.responsible_doctor_id,
    appointment_id: parsed.data.appointment_id ?? null,
    patient_id: parsed.data.patient_id ?? null,
    subject_full_name: parsed.data.subject_full_name ?? null,
    subject_dob: parsed.data.subject_dob ?? null,
    subject_national_id: parsed.data.subject_national_id ?? null,
    priority: parsed.data.priority,
    laboratory_name: parsed.data.laboratory_name ?? null,
    clinical_context: parsed.data.clinical_context ?? null,
    instructions: parsed.data.instructions ?? null,
  };
  const { data: request, error } = await supabase
    .from("lab_requests")
    .insert({ ...header, clinic_id: user.clinicId, created_by: user.id, status: "draft" })
    .select("id")
    .single();
  if (error || !request) return mutationFailure();
  const inserted = await supabase.from("lab_request_tests").insert(
    tests.map((item, index) => ({
      lab_request_id: request.id,
      lab_test_catalog_id: item.lab_test_catalog_id ?? null,
      test_name: item.test_name,
      notes: item.notes ?? null,
      sort_order: item.sort_order ?? index,
    })),
  );
  if (inserted.error) {
    await supabase.from("lab_requests").delete().eq("id", request.id);
    return mutationFailure();
  }
  refreshLabRequestPaths(user.clinicId);
  return { success: true, data: { id: request.id } };
}

export async function updateLabRequestDraft(
  id: string,
  input: LabRequestDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireClinicalMutation();
  const idResult = clinicalRecordIdSchema.safeParse(id);
  const parsed = labRequestDraftSchema.safeParse(input);
  if (!idResult.success) return validationFailure(idResult.error.issues);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  let tests;
  try {
    tests = await hydrateLabRequestTests(user, parsed.data.responsible_doctor_id, parsed.data.tests);
  } catch {
    return mutationFailure();
  }
  if (!tests) return mutationFailure();

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("lab_requests")
    .select("id, status, lab_request_tests(*)")
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
    priority: parsed.data.priority,
    laboratory_name: parsed.data.laboratory_name ?? null,
    clinical_context: parsed.data.clinical_context ?? null,
    instructions: parsed.data.instructions ?? null,
  };
  const updated = await supabase.from("lab_requests").update(header)
    .eq("id", id).eq("clinic_id", user.clinicId).eq("status", "draft");
  if (updated.error) return mutationFailure();
  const removed = await supabase.from("lab_request_tests").delete().eq("lab_request_id", id);
  if (removed.error) return mutationFailure();
  const inserted = await supabase.from("lab_request_tests").insert(
    tests.map((item, index) => ({
      lab_request_id: id,
      lab_test_catalog_id: item.lab_test_catalog_id ?? null,
      test_name: item.test_name,
      notes: item.notes ?? null,
      sort_order: item.sort_order ?? index,
    })),
  );
  if (inserted.error) {
    const previous = (existing.lab_request_tests ?? []).map((item) => ({
      lab_request_id: item.lab_request_id,
      lab_test_catalog_id: item.lab_test_catalog_id,
      test_name: item.test_name,
      notes: item.notes,
      sort_order: item.sort_order,
    }));
    if (previous.length > 0) await supabase.from("lab_request_tests").insert(previous);
    return mutationFailure();
  }
  refreshLabRequestPaths(user.clinicId);
  return { success: true, data: { id } };
}

export async function finalizeLabRequest(id: string) {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  await requireClinicalRead();
  const supabase = await createClient();
  const { count, error } = await supabase.from("lab_request_tests")
    .select("id", { count: "exact", head: true }).eq("lab_request_id", id);
  if (error || !count) return mutationFailure();
  const result = await finalizeClinicalRecord("lab_requests", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshLabRequestPaths(user.clinicId);
  }
  return result;
}

export async function voidLabRequest(id: string) {
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const result = await voidClinicalRecord("lab_requests", id);
  if (result.success) {
    const user = await requireClinicalRead();
    refreshLabRequestPaths(user.clinicId);
  }
  return result;
}

export async function getLabRequest(id: string) {
  const user = await requireClinicalRead();
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success) return { data: null, error: await actionError("clinical.invalidId") };
  const supabase = await createClient();
  const { data, error } = await supabase.from("lab_requests")
    .select("*, lab_request_tests(*)")
    .eq("id", id).eq("clinic_id", user.clinicId)
    .order("sort_order", { referencedTable: "lab_request_tests", ascending: true })
    .maybeSingle();
  return { data: data ?? null, error: error ? await actionError("clinical.readFailed") : null };
}
