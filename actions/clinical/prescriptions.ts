"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  createPrescriptionMutation,
  transitionClinicalRecordMutation,
  updatePrescriptionMutation,
} from "@/lib/clinical/mutations";
import type { PrescriptionDraftInput } from "@/lib/validations/clinical";
import { requireMutationRole } from "@/lib/rbac";
import {
  getPrescription as legacyGetPrescription,
} from "@/actions/clinical/prescriptions-legacy";
import {
  CLINICAL_PREPARER_ROLES,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

export async function createPrescriptionDraft(
  input: PrescriptionDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await createPrescriptionMutation(user, input);
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function updatePrescriptionDraft(
  id: string,
  input: PrescriptionDraftInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await updatePrescriptionMutation(user, { id, draft: input });
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id } };
}

export async function finalizePrescription(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "prescriptions",
    { id },
    "finalize",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "finalized" } };
}

export async function voidPrescription(
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "void" }>> {
  const user = await requireMutationRole([...CLINICAL_PREPARER_ROLES]);
  const result = await transitionClinicalRecordMutation(
    user,
    "prescriptions",
    { id },
    "void",
  );
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, data: { id: result.data.id, status: "void" } };
}

export async function getPrescription(...args: Parameters<typeof legacyGetPrescription>) {
  return legacyGetPrescription(...args);
}
