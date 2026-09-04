"use server";

import { revalidatePath } from "next/cache";
import { requireMutationRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { approveAiPatientIntakeMutation } from "@/lib/patients/mutations";

export type AiIntakeReviewResult = {
  success?: boolean;
  error?: string;
  patientId?: string;
  appointmentId?: string | null;
};

export async function approveAiPatientIntake(
  intakeId: string,
): Promise<AiIntakeReviewResult> {
  const user = await requireMutationRole(["admin", "manager", "receptionist"]);
  const result = await approveAiPatientIntakeMutation(user, {
    intake_id: intakeId,
  });
  if (!result.ok) {
    return { error: "aiIntakeReviewFailed" };
  }
  return {
    success: true,
    patientId: result.data.patient_id,
    appointmentId: result.data.appointment_id,
  };
}

export async function rejectAiPatientIntake(
  intakeId: string,
  reason?: string,
): Promise<AiIntakeReviewResult> {
  const user = await requireMutationRole(["admin", "manager", "receptionist"]);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reject_ai_patient_intake", {
    p_intake_id: intakeId,
    p_actor_id: user.id,
    p_reason: reason?.trim() || undefined,
  });
  if (error || data !== true) return { error: "aiIntakeReviewFailed" };
  revalidatePath("/patients");
  revalidatePath("/dashboard");
  return { success: true };
}
