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
import { sendAutomatedPatientMessage } from "@/lib/messaging/automated-send";
import { emitClinicNotification } from "@/lib/notifications/emit";

/**
 * Invoice follow-up sequence (§7.3): D0 notice → D+3 gentle reminder → D+7
 * final reminder, stopping on settlement, cancellation, opt-out, or after the
 * third message.
 *
 * The row is created when billing completes with an outstanding amount
 * (actions/appointments.ts hook) and only this cron advances it. A step is
 * claimed with a conditional update before the send, so overlapping runs
 * cannot double-send; a failed send counts as the attempt (bounded messages
 * beat guaranteed delivery for dunning) and notifies the clinic admins once.
 */

const DAY_MS = 86_400_000;
/** Message schedule anchored on sequence creation (the invoice date). */
const STEP_DUE_OFFSETS_DAYS = [0, 3, 7] as const;
export const MAX_FOLLOWUP_MESSAGES = 3;

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
 * action; failures are reported but never fail billing.
 */
export async function ensureInvoiceFollowupSequence(
  clinicId: string,
  appointmentId: string,
): Promise<void> {
  try {
    const client = createClinicScopedAdminClient(clinicId);
    const result = await client.from("followup_sequences").upsert(
      {
        clinic_id: clinicId,
        appointment_id: appointmentId,
        step: 0,
        status: "active",
        next_run_at: new Date().toISOString(),
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

    const nextStep = sequence.step + 1;
    const isFinal = nextStep >= MAX_FOLLOWUP_MESSAGES;
    // The schedule is anchored on sequence creation (the invoice date), so a
    // delayed run does not push the remaining steps later than D+3/D+7.
    const anchor = new Date(sequence.created_at).getTime();
    const claim = await client
      .from("followup_sequences")
      .update({
        step: nextStep,
        last_sent_at: now.toISOString(),
        next_run_at: isFinal
          ? null
          : new Date(
              anchor + STEP_DUE_OFFSETS_DAYS[nextStep as 1 | 2] * DAY_MS,
            ).toISOString(),
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

    const [settings, patient, templates] = await Promise.all([
      getClinicReminderSettings(sequence.clinic_id),
      client
        .from("patients")
        .select("id, full_name, phone, email")
        .eq("id", appointment.data.patient_id)
        .maybeSingle(),
      client
        .from("message_templates")
        .select("id, name, language, variables, approval_status, channel")
        .eq("channel", "whatsapp")
        .eq("approval_status", "approved")
        .eq("name", FOLLOWUP_TEMPLATE_NAME),
    ]);

    const locale = patientCopyLocale(settings.data?.locale);
    const clinicName = settings.data?.name ?? "";
    const copy = patient.data
      ? followupCopy({
          locale,
          patientName: patient.data.full_name,
          clinicName,
          step: sequence.step as 0 | 1 | 2,
        })
      : null;

    const result =
      patient.data && copy && settings.data
        ? await sendAutomatedPatientMessage({
            clinicId: sequence.clinic_id,
            recipient: { phone: patient.data.phone, email: patient.data.email },
            locale,
            whatsappTemplates: templates.data ?? [],
            templateValues: {
              patient_name: patient.data.full_name,
              clinic_name: clinicName,
              doctor_name: clinicName,
              appointment_date: "",
              appointment_time: "",
            },
            subject: copy.subject,
            body: copy.body,
            relatedType: "invoice",
            relatedId: sequence.appointment_id,
          })
        : ({ ok: false, code: "NO_USABLE_CHANNEL" } as const);

    if (result.ok) {
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
