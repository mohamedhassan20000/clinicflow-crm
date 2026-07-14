"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  followup?: {
    id: string;
    appointment_id: string | null;
    patient_id: string;
    outcome: FollowupOutcome;
    notes: string | null;
  };
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
  const user = await requireMutationRole(["admin", "receptionist"]);

  const appointmentId = String(formData.get("appointment_id") ?? "");
  const patientId = String(formData.get("patient_id") ?? "");
  const outcomeRaw = String(formData.get("outcome") ?? "");
  const notes = (String(formData.get("notes") ?? "").trim() || null) as
    | string
    | null;

  if (!appointmentId || !patientId) {
    return { error: await actionError("followups.missingAppointmentOrPatient") };
  }
  if (!VALID_OUTCOMES.includes(outcomeRaw as FollowupOutcome)) {
    return { error: await actionError("followups.pickAnOutcome") };
  }
  const outcome = outcomeRaw as FollowupOutcome;
  if (outcome === "has_problem" && !notes) {
    return {
      error: await actionError("followups.describeTheProblemInTheNotesWhenThePatientReports"),
    };
  }
  if (notes && notes.length > 1000) {
    return { error: await actionError("followups.noteMustBe1000CharactersOrLess") };
  }

  const supabase = await createClient();

  // Confirm the appointment belongs to this clinic and is completed.
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, clinic_id, patient_id, status")
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .single();

  if (!appt) return { error: await actionError("followups.appointmentNotFound") };
  if (appt.status !== "completed") {
    return { error: await actionError("followups.followUpsCanOnlyBeRecordedForCompletedSessions") };
  }
  if (appt.patient_id !== patientId) {
    return { error: await actionError("followups.patientMismatchOnAppointment") };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("follow_ups")
    .insert({
      appointment_id: appointmentId,
      patient_id: patientId,
      clinic_id: user.clinicId,
      outcome,
      notes,
      recorded_by: user.id,
    })
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return { error: await actionError("followups.aFollowUpHasAlreadyBeenRecordedForThisSession") };
    }
    return { error: await actionError("followups.failedToSaveFollowUp") };
  }

  revalidatePath("/followups");
  revalidatePath(`/patients/${patientId}`);
  return { followup: inserted ?? undefined };
}

export async function updateFollowup(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const followupId = String(formData.get("followup_id") ?? "");
  const patientId = String(formData.get("patient_id") ?? "");
  const outcomeRaw = String(formData.get("outcome") ?? "");
  const notes = (String(formData.get("notes") ?? "").trim() || null) as
    | string
    | null;

  if (!followupId || !patientId) return { error: await actionError("followups.missingFollowUp") };
  if (!VALID_OUTCOMES.includes(outcomeRaw as FollowupOutcome)) {
    return { error: await actionError("followups.pickAnOutcome") };
  }
  const outcome = outcomeRaw as FollowupOutcome;
  if (outcome === "has_problem" && !notes) {
    return { error: await actionError("followups.describeTheProblemInTheNotesWhenThePatientReports") };
  }
  if (notes && notes.length > 1000) {
    return { error: await actionError("followups.noteMustBe1000CharactersOrLess") };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("follow_ups")
    .update({ outcome, notes, recorded_by: user.id })
    .eq("id", followupId)
    .eq("patient_id", patientId)
    .eq("clinic_id", user.clinicId)
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();

  if (error || !data) return { error: await actionError("followups.failedToUpdateFollowUp") };

  revalidatePath("/followups");
  revalidatePath(`/patients/${patientId}`);
  return { followup: data };
}

export async function deleteFollowup(followupId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("follow_ups")
    .delete()
    .eq("id", followupId)
    .eq("clinic_id", user.clinicId)
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();

  if (error || !data) return { error: await actionError("followups.failedToDeleteFollowUp") };

  revalidatePath("/followups");
  revalidatePath(`/patients/${data.patient_id}`);
  return { followup: data };
}

export async function restoreFollowup(
  data: NonNullable<ActionResult["followup"]>,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("follow_ups")
    .upsert({
      id: data.id,
      appointment_id: data.appointment_id,
      patient_id: data.patient_id,
      clinic_id: user.clinicId,
      outcome: data.outcome,
      notes: data.notes,
      recorded_by: user.id,
    })
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();

  if (error || !inserted) return { error: await actionError("followups.failedToRestoreFollowUp") };

  revalidatePath("/followups");
  revalidatePath(`/patients/${data.patient_id}`);
  return { followup: inserted };
}
