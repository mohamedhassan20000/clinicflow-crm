"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  deleteFollowupMutation,
  recordFollowupMutation,
  restoreFollowupMutation,
  updateFollowupMutation,
  type FollowupRow,
} from "@/lib/followups/mutations";
import { requireMutationRole } from "@/lib/rbac";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  followup?: FollowupRow;
};

function nullableText(formData: FormData, key: string): string | null {
  return String(formData.get(key) ?? "").trim() || null;
}

export async function recordFollowup(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const result = await recordFollowupMutation(user, {
    appointment_id: String(formData.get("appointment_id") ?? ""),
    patient_id: String(formData.get("patient_id") ?? ""),
    outcome: String(formData.get("outcome") ?? ""),
    notes: nullableText(formData, "notes"),
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return { followup: result.data };
}

export async function updateFollowup(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const result = await updateFollowupMutation(user, {
    followup_id: String(formData.get("followup_id") ?? ""),
    patient_id: String(formData.get("patient_id") ?? ""),
    outcome: String(formData.get("outcome") ?? ""),
    notes: nullableText(formData, "notes"),
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return { followup: result.data };
}

export async function deleteFollowup(followupId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await deleteFollowupMutation(user, {
    followup_id: followupId,
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return { followup: result.data };
}

export async function restoreFollowup(data: FollowupRow): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await restoreFollowupMutation(user, data);
  if (!result.ok) return domainFailureToActionResult(result);
  return { followup: result.data };
}
