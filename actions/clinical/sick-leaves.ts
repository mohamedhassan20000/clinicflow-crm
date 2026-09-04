"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  createSickLeaveMutation,
  transitionClinicalRecordMutation,
  updateSickLeaveMutation,
} from "@/lib/clinical/mutations";
import type { SickLeaveDraftInput } from "@/lib/validations/clinical";
import { requireMutationRole } from "@/lib/rbac";
import { getSickLeave as legacyGetSickLeave } from "@/actions/clinical/sick-leaves-legacy";
import {
  CLINICAL_PREPARER_ROLES,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

export async function createSickLeaveDraft(
  input: SickLeaveDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await createSickLeaveMutation(user, input);
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function updateSickLeaveDraft(
  id: string,
  input: SickLeaveDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await updateSickLeaveMutation(user, { id, draft: input });
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function finalizeSickLeave(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "sick_leaves",
    { id },
    "finalize",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "finalized" } };
}

export async function voidSickLeave(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "void" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "sick_leaves",
    { id },
    "void",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "void" } };
}

export async function getSickLeave(...args: Parameters<typeof legacyGetSickLeave>) {
  return legacyGetSickLeave(...args);
}
