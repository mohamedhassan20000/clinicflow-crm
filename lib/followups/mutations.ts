import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export type FollowupOutcome = Database["public"]["Enums"]["follow_up_outcome"];

export const FOLLOWUP_WRITE_ROLES = [
  "admin",
  "receptionist",
  "manager",
  "assistant",
] as const;
export const FOLLOWUP_DELETE_ROLES = [
  "admin",
  "receptionist",
  "manager",
] as const;

const followupOutcomeFields = {
  patient_id: z.string().uuid(),
  outcome: z.enum(["all_fine", "has_problem", "no_response"]),
  notes: z.string().trim().max(1000).nullable().optional(),
} as const;

function requireProblemNotes(
  value: { outcome: FollowupOutcome; notes?: string | null },
  context: z.RefinementCtx,
) {
    if (value.outcome === "has_problem" && !value.notes?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["notes"],
        message: "validation.required",
      });
    }
}

export const followupRecordSchema = z
  .object({
    appointment_id: z.string().uuid(),
    ...followupOutcomeFields,
  })
  .strict()
  .superRefine(requireProblemNotes);

export const followupUpdateSchema = z
  .object({
    followup_id: z.string().uuid(),
    ...followupOutcomeFields,
  })
  .strict()
  .superRefine(requireProblemNotes);

export const followupDeleteSchema = z
  .object({ followup_id: z.string().uuid() })
  .strict();

export const followupRestoreSchema = z
  .object({
    id: z.string().uuid(),
    appointment_id: z.string().uuid().nullable(),
    patient_id: z.string().uuid(),
    outcome: z.enum(["all_fine", "has_problem", "no_response"]),
    notes: z.string().max(1000).nullable(),
  })
  .strict();

export type FollowupRow = z.infer<typeof followupRestoreSchema>;

function refreshFollowupPaths(patientId: string) {
  revalidatePath("/followups");
  revalidatePath(`/patients/${patientId}`);
}

export async function recordFollowupMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<FollowupRow>> {
  assertDomainMutationRole(user, FOLLOWUP_WRITE_ROLES);
  const parsed = followupRecordSchema.safeParse(input);
  if (!parsed.success) {
    const problemNotesMissing =
      !!input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as { outcome?: unknown }).outcome === "has_problem" &&
      !(input as { notes?: unknown }).notes;
    return domainFailure("followups.missingAppointmentOrPatient", {
      validationError: parsed.error,
      ...(problemNotesMissing
        ? {
            fieldErrorCodes: {
              notes: [
                "followups.describeTheProblemInTheNotesWhenThePatientReports",
              ],
            },
          }
        : {}),
    });
  }

  const supabase = await createClient();
  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, patient_id, status")
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .maybeSingle();
  if (appointmentError || !appointment) {
    return domainFailure("followups.appointmentNotFound");
  }
  if (appointment.status !== "completed") {
    return domainFailure(
      "followups.followUpsCanOnlyBeRecordedForCompletedSessions",
    );
  }
  if (appointment.patient_id !== parsed.data.patient_id) {
    return domainFailure("followups.patientMismatchOnAppointment");
  }

  const next: FollowupRow = {
    id: "00000000-0000-0000-0000-000000000000",
    appointment_id: parsed.data.appointment_id,
    patient_id: parsed.data.patient_id,
    outcome: parsed.data.outcome,
    notes: parsed.data.notes?.trim() || null,
  };
  if (mode === "preview") {
    return domainSuccess(next, { targetTable: "follow_ups", after: next });
  }

  const { data, error } = await supabase
    .from("follow_ups")
    .insert({
      appointment_id: next.appointment_id,
      patient_id: next.patient_id,
      clinic_id: user.clinicId,
      outcome: next.outcome,
      notes: next.notes,
      recorded_by: user.id,
    })
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();
  if (error) {
    return domainFailure(
      error.code === "23505"
        ? "followups.aFollowUpHasAlreadyBeenRecordedForThisSession"
        : "followups.failedToSaveFollowUp",
    );
  }
  refreshFollowupPaths(data.patient_id);
  return domainSuccess(data, {
    targetTable: "follow_ups",
    targetRecordIds: [data.id],
    after: data,
  });
}

export async function updateFollowupMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<FollowupRow>> {
  assertDomainMutationRole(user, FOLLOWUP_WRITE_ROLES);
  const parsed = followupUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const problemNotesMissing =
      !!input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as { outcome?: unknown }).outcome === "has_problem" &&
      !(input as { notes?: unknown }).notes;
    return domainFailure("followups.missingFollowUp", {
      validationError: parsed.error,
      ...(problemNotesMissing
        ? {
            fieldErrorCodes: {
              notes: [
                "followups.describeTheProblemInTheNotesWhenThePatientReports",
              ],
            },
          }
        : {}),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from("follow_ups")
    .select("id, appointment_id, patient_id, outcome, notes")
    .eq("id", parsed.data.followup_id)
    .eq("patient_id", parsed.data.patient_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (readError || !existing) {
    return domainFailure("followups.failedToUpdateFollowUp");
  }
  const next: FollowupRow = {
    ...existing,
    outcome: parsed.data.outcome,
    notes: parsed.data.notes?.trim() || null,
  };
  if (mode === "preview") {
    return domainSuccess(next, {
      targetTable: "follow_ups",
      targetRecordIds: [existing.id],
      before: existing,
      after: next,
    });
  }
  const { data, error } = await supabase
    .from("follow_ups")
    .update({ outcome: next.outcome, notes: next.notes, recorded_by: user.id })
    .eq("id", existing.id)
    .eq("patient_id", existing.patient_id)
    .eq("clinic_id", user.clinicId)
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();
  if (error || !data) return domainFailure("followups.failedToUpdateFollowUp");
  refreshFollowupPaths(data.patient_id);
  return domainSuccess(data, {
    targetTable: "follow_ups",
    targetRecordIds: [data.id],
    before: existing,
    after: data,
  });
}

export async function deleteFollowupMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<FollowupRow>> {
  assertDomainMutationRole(user, FOLLOWUP_DELETE_ROLES);
  const parsed = followupDeleteSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("followups.missingFollowUp", {
      validationError: parsed.error,
    });
  }
  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from("follow_ups")
    .select("id, appointment_id, patient_id, outcome, notes")
    .eq("id", parsed.data.followup_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (readError || !existing) {
    return domainFailure("followups.failedToDeleteFollowUp");
  }
  if (mode === "preview") {
    return domainSuccess(existing, {
      targetTable: "follow_ups",
      targetRecordIds: [existing.id],
      before: existing,
      after: null,
    });
  }
  const { data, error } = await supabase
    .from("follow_ups")
    .delete()
    .eq("id", existing.id)
    .eq("clinic_id", user.clinicId)
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();
  if (error || !data) return domainFailure("followups.failedToDeleteFollowUp");
  refreshFollowupPaths(data.patient_id);
  return domainSuccess(data, {
    targetTable: "follow_ups",
    targetRecordIds: [data.id],
    before: data,
    after: null,
  });
}

export async function restoreFollowupMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<FollowupRow>> {
  assertDomainMutationRole(user, FOLLOWUP_DELETE_ROLES);
  const parsed = followupRestoreSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("followups.failedToRestoreFollowUp", {
      validationError: parsed.error,
    });
  }
  if (mode === "preview") {
    return domainSuccess(parsed.data, {
      targetTable: "follow_ups",
      targetRecordIds: [parsed.data.id],
      before: null,
      after: parsed.data,
    });
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("follow_ups")
    .upsert({
      ...parsed.data,
      clinic_id: user.clinicId,
      recorded_by: user.id,
    })
    .select("id, appointment_id, patient_id, outcome, notes")
    .single();
  if (error || !data) return domainFailure("followups.failedToRestoreFollowUp");
  refreshFollowupPaths(data.patient_id);
  return domainSuccess(data, {
    targetTable: "follow_ups",
    targetRecordIds: [data.id],
    before: null,
    after: data,
  });
}
