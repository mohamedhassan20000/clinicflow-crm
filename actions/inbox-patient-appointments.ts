"use server";

import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { overduePendingThreshold } from "@/lib/appointments/overdue-pending";
import { authorizeAccountScopedConversation } from "@/lib/messaging/conversation-scope";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * P12 — a conversation's patient history, for the Inbox.
 *
 * ### Why this exists
 *
 * A receptionist answering "when did I last come in?" had to leave the thread,
 * open Appointments, search the patient, read the answer, and come back to a
 * conversation they had lost their place in. The answer is four columns wide
 * and the Inbox already knows who it is talking to.
 *
 * ### Why it is a read of its own and not the follow-ups dashboard RPC
 *
 * `get_followups_dashboard` answers a different question — every clinic
 * appointment in a date range, filtered by department and doctor and outcome —
 * and it refuses managers outright. This one is scoped to a single patient
 * reached through a single conversation, has no date range at all, and returns
 * the whole recent history rather than only the rows still awaiting a call.
 * Reusing it would mean asking for the clinic's entire window and discarding
 * almost all of it.
 *
 * Nothing here is new state: appointments and their follow-ups are existing
 * rows read through the caller's own RLS-scoped client, so a row this staff
 * member cannot see in Appointments is a row they cannot see here either.
 *
 * ### Why the conversation is authorized somewhere else
 *
 * The conversation link is the one thing that *cannot* be read that way. A
 * direct `from("conversations")` read as `authenticated` is filtered by the
 * restrictive `whatsapp_account_isolation_conversations` policy, whose account
 * branch is chosen by probing `clinic_channels` — a table that is deny-all for
 * staff. The probe fails, the predicate falls back to "legacy NULL scope only",
 * and every thread on the clinic's live linked account reads as missing. The
 * Inbox list is unaffected because it comes from a security-definer RPC, so the
 * conversation is on screen while this action calls it not found. So the
 * ownership proof goes through {@link authorizeAccountScopedConversation},
 * exactly as the thread read does, and it proves *more* than RLS did: clinic,
 * channel, and current WhatsApp account.
 *
 * ### What "past" means here
 *
 * The scheduled *end* has passed — `scheduled_at + duration_minutes`, the same
 * threshold `isOverduePending` uses — and the appointment is not deleted.
 * Status is deliberately not part of it. A booking still `pending` after its
 * slot has gone by is an overdue pending appointment: the lifecycle keeps it
 * `pending` on purpose, it is the visit the patient is most likely messaging
 * about, and hiding it would hide the reason for the call. A `pending`
 * appointment still in the future is not past and never appears. Whether a
 * *follow-up* can be recorded is a narrower question, answered below.
 */

const inputSchema = z.object({
  conversationId: z.string().uuid(),
});

/** How much history is useful in a side panel. Beyond this, Appointments. */
const HISTORY_LIMIT = 25;

/**
 * Past means the slot is over, whatever the appointment's status says.
 *
 * The end, not the start: an appointment the patient is sitting in right now is
 * not history yet, and `overduePendingThreshold` is already the clinic's answer
 * for where a slot ends — start plus its stored duration, and the start alone
 * when no usable duration was ever recorded.
 */
function isPast(
  row: { scheduled_at: string; duration_minutes: number | null },
  now: Date,
): boolean {
  const threshold = overduePendingThreshold(row);
  return threshold !== null && threshold < now.valueOf();
}

export type InboxAppointmentFollowup = {
  id: string;
  outcome: Database["public"]["Enums"]["follow_up_outcome"];
  notes: string | null;
  recordedAt: string;
};

export type InboxPastAppointment = {
  id: string;
  scheduledAt: string;
  status: Database["public"]["Enums"]["appointment_status"];
  doctorName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  departmentColor: string | null;
  doctorId: string | null;
  paidAt: string | null;
  totalAmount: number | null;
  paymentNote: string | null;
  /** The follow-up already recorded against this appointment, if there is one. */
  followup: InboxAppointmentFollowup | null;
  /**
   * True when this appointment is one the follow-ups dashboard would list as
   * pending: completed, not deleted, and with no follow-up recorded yet. The
   * same three conditions as `pending_scope` in `get_followups_dashboard`, so
   * the Inbox never offers a follow-up the Follow-ups page would not. An
   * overdue *pending* appointment is therefore never offered one: nobody has
   * yet said the visit happened.
   */
  followupPending: boolean;
};

export type InboxPatientAppointmentsResult = {
  error?: string;
  patient?: {
    id: string;
    fullName: string;
    phone: string;
    fileNumber: string | null;
    nationalId: string | null;
    departmentId: string | null;
  };
  appointments?: InboxPastAppointment[];
};

export async function listConversationPatientAppointments(
  input: unknown,
): Promise<InboxPatientAppointmentsResult> {
  // The same gate as the Inbox page itself: this shows nothing a viewer of the
  // Inbox could not already reach, and nothing to anyone who cannot reach it.
  const user = await requireRole(["admin", "receptionist"]);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("messaging.invalidConversationUpdate") };
  }

  const { conversation } = await authorizeAccountScopedConversation({
    clinicId: user.clinicId,
    conversationId: parsed.data.conversationId,
  });

  if (!conversation) {
    return { error: await actionError("messaging.conversationNotFound") };
  }
  /*
   * The authoritative link, and the only thing that opens this door. An
   * unlinked thread — a NEW_CONTACT — has no history to show, and guessing one
   * from a phone number is how a stranger gets shown somebody else's visits.
   */
  if (!conversation.patient_id) {
    return { error: await actionError("messaging.conversationNotLinked") };
  }

  const patientId = conversation.patient_id;
  const now = new Date();
  const supabase = await createClient();
  const [
    { data: patient, error: patientError },
    { data: appointments, error: appointmentsError },
  ] = await Promise.all([
      supabase
        .from("patients")
        .select("id, full_name, phone, file_number, national_id, department_id")
        .eq("id", patientId)
        .eq("clinic_id", user.clinicId)
        .maybeSingle(),
      supabase
        .from("appointments")
        .select(
          "id, scheduled_at, duration_minutes, status, doctor_id, department_id, paid_at, total_amount, payment_note, profiles!doctor_id(full_name), departments(name, color), follow_ups(id, outcome, notes, recorded_at)",
        )
        .eq("clinic_id", user.clinicId)
        .eq("patient_id", patientId)
        .is("deleted_at", null)
        // A start already gone by is the bounded superset of an end already
        // gone by, so the exact end-time test below never has to page past a
        // patient's future bookings to find their history.
        .lt("scheduled_at", now.toISOString())
        .order("scheduled_at", { ascending: false })
        .limit(HISTORY_LIMIT),
    ]);

  /*
   * Not "Conversation not found". The conversation was already proved to exist
   * and to belong to this clinic and account a few lines above; what failed
   * here is a read of appointment or patient rows. Reporting that as a missing
   * conversation sent staff to look for a thread that is on their screen, and
   * hid a database failure behind a data-shaped answer. A read failure gets the
   * generic, retryable loading error instead.
   *
   * `!patient` is grouped with it deliberately: the conversation carries a
   * `patient_id`, so a patient row that does not come back is a failed or
   * RLS-blocked read of a file that should be there, not a missing thread.
   */
  if (appointmentsError || patientError || !patient) {
    return { error: await actionError("messaging.patientHistoryUnavailable") };
  }

  const rows: InboxPastAppointment[] = (appointments ?? [])
    .filter((row) => isPast(row, now))
    .map((row) => {
      // `follow_ups` comes back as an array through the embed. A follow-up is
      // one-per-appointment in practice; the newest is the one to show if a
      // clinic ever ends up with more.
      const followups = (Array.isArray(row.follow_ups) ? row.follow_ups : [])
        .slice()
        .sort(
          (a, b) =>
            new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
        );
      const followup = followups[0] ?? null;
      return {
        id: row.id,
        scheduledAt: row.scheduled_at,
        status: row.status,
        doctorId: row.doctor_id,
        doctorName: row.profiles?.full_name ?? null,
        departmentId: row.department_id,
        departmentName: row.departments?.name ?? null,
        departmentColor: row.departments?.color ?? null,
        paidAt: row.paid_at,
        totalAmount: row.total_amount,
        paymentNote: row.payment_note,
        followup: followup
          ? {
              id: followup.id,
              outcome: followup.outcome,
              notes: followup.notes,
              recordedAt: followup.recorded_at,
            }
          : null,
        followupPending: row.status === "completed" && !followup,
      };
    });

  return {
    patient: {
      id: patient.id,
      fullName: patient.full_name,
      phone: patient.phone,
      fileNumber: patient.file_number,
      nationalId: patient.national_id,
      departmentId: patient.department_id,
    },
    appointments: rows,
  };
}
