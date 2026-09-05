import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
  listDueFollowupSequences,
} from "@/lib/supabase/admin";
import {
  followupCopy,
  patientCopyLocale,
  FOLLOWUP_TEMPLATE_NAME,
} from "@/lib/messaging/patient-copy";
import {
  dispatchPatientMessage,
  anyChannelSent,
} from "@/lib/messaging/automated-send";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { AUTOMATED_TEMPLATE_APPROVAL_STATES } from "@/lib/messaging/automated-send";
import { emitClinicNotification } from "@/lib/notifications/emit";

/**
 * Overdue-invoice dunning follow-up (§7.3b; 2026-07-19 flow revision).
 *
 * Two reminders whose timing, on/off, and copy are **per-clinic configurable**
 * (`clinics.invoice_followup_*`): a first reminder X days after the invoice and
 * a second Y days after, using the clinic's own `invoice_followup` WhatsApp
 * template and its configured email subject/body (falling back to built-in
 * copy). Advanced only by the daily morning cron.
 *
 * Each message is dispatched on Email and WhatsApp independently and is
 * idempotent per channel (dedupe_key `invoice_followup:<appt>:step<n>`), so no
 * duplicate is ever sent. The sequence step advances on attempt (dunning is
 * bounded-messages-first); a run where no channel reaches the patient alerts
 * the clinic admins once.
 */

const DAY_MS = 86_400_000;
export const MAX_FOLLOWUP_MESSAGES = 2;
const DEFAULT_FIRST_DAYS = 3;
const DEFAULT_SECOND_DAYS = 7;

export type FollowupRunSummary = {
  due: number;
  sent: number;
  failed: number;
  stopped: number;
  skipped: number;
};

/**
 * Registers an appointment for the invoice follow-up sequence. Idempotent:
 * one sequence per appointment, ever. Called from the billing-completion
 * action; failures are reported but never fail billing. The first reminder is
 * due at the clinic's configured `invoice_followup_first_days`.
 */
export async function ensureInvoiceFollowupSequence(
  clinicId: string,
  appointmentId: string,
): Promise<void> {
  try {
    const settings = await getClinicReminderSettings(clinicId);
    const firstDays = settings.data?.invoice_followup_first_days ?? DEFAULT_FIRST_DAYS;
    const client = createClinicScopedAdminClient(clinicId);
    const firstDueAt = new Date(Date.now() + firstDays * DAY_MS).toISOString();
    const result = await client.from("followup_sequences").upsert(
      {
        clinic_id: clinicId,
        appointment_id: appointmentId,
        step: 0,
        status: "active",
        next_run_at: firstDueAt,
      },
      { onConflict: "appointment_id", ignoreDuplicates: true },
    );
    if (result.error) throw result.error;
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "messaging-followups" },
      extra: { appointmentId },
    });
  }
}

type StopReason = "settled" | "cancelled" | "opted_out" | "completed";

export async function runInvoiceFollowups(
  now: Date = new Date(),
): Promise<FollowupRunSummary> {
  const summary: FollowupRunSummary = {
    due: 0,
    sent: 0,
    failed: 0,
    stopped: 0,
    skipped: 0,
  };

  const due = await listDueFollowupSequences(now.toISOString());
  if (due.error) {
    Sentry.captureMessage("follow-up cron could not list due sequences", {
      level: "error",
      tags: { scope: "messaging-cron" },
    });
    return summary;
  }

  for (const sequence of due.data ?? []) {
    summary.due += 1;
    const client = createClinicScopedAdminClient(sequence.clinic_id);

    async function stop(reason: StopReason) {
      const update = await client
        .from("followup_sequences")
        .update({ status: "stopped", stopped_reason: reason, next_run_at: null })
        .eq("id", sequence.id)
        .eq("status", "active");
      if (update.error) {
        Sentry.captureMessage("follow-up sequence stop failed", {
          level: "error",
          tags: { scope: "messaging-followups" },
          extra: { sequenceId: sequence.id, reason },
        });
      } else {
        summary.stopped += 1;
      }
    }

    const appointment = await client
      .from("appointments")
      .select("id, status, deleted_at, outstanding_amount, patient_id")
      .eq("id", sequence.appointment_id)
      .maybeSingle();
    if (appointment.error) {
      summary.skipped += 1;
      continue;
    }

    // Stop conditions (§7.3) are evaluated at run time, so a settlement or
    // cancellation between messages silences the sequence.
    if (
      !appointment.data ||
      appointment.data.deleted_at ||
      appointment.data.status === "cancelled"
    ) {
      await stop("cancelled");
      continue;
    }
    if ((appointment.data.outstanding_amount ?? 0) <= 0) {
      await stop("settled");
      continue;
    }
    if (sequence.step >= MAX_FOLLOWUP_MESSAGES) {
      await stop("completed");
      continue;
    }

    const settings = await getClinicReminderSettings(sequence.clinic_id);
    if (settings.error || !settings.data) {
      summary.skipped += 1;
      continue;
    }
    // Clinic paused overdue reminders: leave the sequence intact so it resumes
    // if re-enabled — do not advance or send.
    if (!settings.data.invoice_followups_enabled) {
      summary.skipped += 1;
      continue;
    }

    const secondDays =
      settings.data.invoice_followup_second_days ?? DEFAULT_SECOND_DAYS;
    const stepDueDays = [
      settings.data.invoice_followup_first_days ?? DEFAULT_FIRST_DAYS,
      secondDays,
    ] as const;

    const nextStep = sequence.step + 1;
    const isFinal = nextStep >= MAX_FOLLOWUP_MESSAGES;
    // The schedule is anchored on sequence creation (the invoice date), so a
    // delayed run does not push the remaining steps later than configured.
    const anchor = new Date(sequence.created_at).getTime();
    const claim = await client
      .from("followup_sequences")
      .update({
        step: nextStep,
        last_sent_at: now.toISOString(),
        next_run_at: isFinal
          ? null
          : new Date(anchor + stepDueDays[nextStep as 1] * DAY_MS).toISOString(),
        ...(isFinal ? { status: "stopped", stopped_reason: "completed" } : {}),
      })
      .eq("id", sequence.id)
      .eq("step", sequence.step)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) {
      summary.skipped += 1;
      continue;
    }

    const [patient, templates, whatsappProvider] = await Promise.all([
      client
        .from("patients")
        .select("id, full_name, phone, email")
        .eq("id", appointment.data.patient_id)
        .maybeSingle(),
      client
        .from("message_templates")
        .select("id, name, language, variables, approval_status, channel")
        .eq("channel", "whatsapp")
        .in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES)
        .eq("name", FOLLOWUP_TEMPLATE_NAME),
      getActiveWhatsAppProvider(sequence.clinic_id),
    ]);

    const locale = patientCopyLocale(settings.data.locale);
    const clinicName = settings.data.name;
    const copy = followupCopy({
      locale,
      patientName: patient.data?.full_name ?? "",
      clinicName,
      step: sequence.step as 0 | 1,
    });
    // Per-clinic email subject/body override the built-in dunning copy.
    const subject =
      settings.data.invoice_followup_email_subject?.trim() || copy.subject;
    const body = settings.data.invoice_followup_email_body?.trim() || copy.body;

    const result = patient.data
      ? await dispatchPatientMessage({
          clinicId: sequence.clinic_id,
          dedupeKey: `invoice_followup:${sequence.appointment_id}:step${sequence.step}`,
          recipient: { phone: patient.data.phone, email: patient.data.email },
          locale,
          whatsappActive: whatsappProvider !== null,
          whatsappProvider,
          whatsappTemplates: templates.data ?? [],
          templateValues: {
            patient_name: patient.data.full_name,
            clinic_name: clinicName,
            doctor_name: clinicName,
          },
          subject,
          body,
          relatedType: "invoice",
          relatedId: sequence.appointment_id,
        })
      : null;

    if (result && anyChannelSent(result)) {
      summary.sent += 1;
      continue;
    }

    summary.failed += 1;
    await emitClinicNotification({
      clinicId: sequence.clinic_id,
      type: "followup_failed",
      link: "/appointments",
      data: {
        appointmentId: sequence.appointment_id,
        patientName: patient.data?.full_name ?? "",
        step: String(sequence.step),
      },
      roles: ["admin"],
      dedupeUnread: true,
      dedupeData: { appointmentId: sequence.appointment_id },
    });
  }

  return summary;
}
