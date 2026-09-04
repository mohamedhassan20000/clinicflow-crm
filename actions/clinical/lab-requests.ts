"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  createLabRequestMutation,
  transitionClinicalRecordMutation,
  updateLabRequestMutation,
} from "@/lib/clinical/mutations";
import type { LabRequestDraftInput } from "@/lib/validations/clinical";
import { requireMutationRole } from "@/lib/rbac";
import { getLabRequest as legacyGetLabRequest } from "@/actions/clinical/lab-requests-legacy";
import {
  CLINICAL_PREPARER_ROLES,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

export async function createLabRequestDraft(
  input: LabRequestDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await createLabRequestMutation(user, input);
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function updateLabRequestDraft(
  id: string,
  input: LabRequestDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await updateLabRequestMutation(user, { id, draft: input });
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function finalizeLabRequest(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "lab_requests",
    { id },
    "finalize",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "finalized" } };
}

export async function voidLabRequest(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "void" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "lab_requests",
    { id },
    "void",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "void" } };
}

export async function getLabRequest(...args: Parameters<typeof legacyGetLabRequest>) {
  return legacyGetLabRequest(...args);
}
