"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

type FollowupOutcome = Database["public"]["Enums"]["follow_up_outcome"];

const VALID_OUTCOMES: FollowupOutcome[] = [
  "all_fine",
  "has_problem",
  "no_response",
];

export async function recordFollowup(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const appointmentId = String(formData.get("appointment_id") ?? "");
  const patientId = String(formData.get("patient_id") ?? "");
  const outcomeRaw = String(formData.get("outcome") ?? "");
  const notes = (String(formData.get("notes") ?? "").trim() || null) as
    | string
    | null;

  if (!appointmentId || !patientId) {
    return { error: "Missing appointment or patient." };
  }
  if (!VALID_OUTCOMES.includes(outcomeRaw as FollowupOutcome)) {
    return { error: "Pick an outcome." };
  }
  const outcome = outcomeRaw as FollowupOutcome;
  if (outcome === "has_problem" && !notes) {
    return {
      error: "Describe the problem in the notes when the patient reports one.",
    };
  }
  if (notes && notes.length > 1000) {
    return { error: "Note must be 1000 characters or less." };
  }

  const supabase = await createClient();

  // Confirm the appointment belongs to this clinic and is completed.
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, clinic_id, patient_id, status")
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: "Appointment not found." };
  if (appt.status !== "completed") {
    return { error: "Follow-ups can only be recorded for completed sessions." };
  }
  if (appt.patient_id !== patientId) {
    return { error: "Patient mismatch on appointment." };
  }

  const { error: insertError } = await supabase.from("follow_ups").insert({
    appointment_id: appointmentId,
    patient_id: patientId,
    clinic_id: user.clinicId,
    outcome,
    notes,
    recorded_by: user.id,
  });

  if (insertError) {
    if (insertError.code === "23505") {
      return { error: "A follow-up has already been recorded for this session." };
    }
    return { error: insertError.message || "Failed to save follow-up." };
  }

  revalidatePath("/followups");
  revalidatePath(`/patients/${patientId}`);
  return {};
}
