import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  claimAppointmentReminder,
  createClinicScopedAdminClient,
  finalizeAppointmentReminder,
  getClinicReminderSettings,
  listReminderCandidateAppointments,
  releaseAppointmentReminder,
} from "@/lib/supabase/admin";
import { toNumberingLocale } from "@/lib/datetime";
import {
  patientCopyLocale,
  reminderCopy,
  REMINDER_TEMPLATE_NAME,
} from "@/lib/messaging/patient-copy";
import {
  sendAutomatedPatientMessage,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { emitClinicNotification } from "@/lib/notifications/emit";

/**
 * Confirmed-appointment reminders (§7.2). Runs from the Vercel Cron route.
 *
 * Idempotency is a recoverable lease: each (appointment, offset) is claimed
 * under a row lock before any send, so overlapping cron runs cannot
 * double-send; a successful send finalizes the entry to "sent", a definite
 * failure releases it for the next run (with a deduped admin notification),
 * and a crash between claim and dispatch leaves a stale claim that becomes
 * re-claimable after the lease window — a reminder can never be suppressed
 * permanently (P3-H3). An ambiguous provider outcome (timeout after possible
 * acceptance) keeps the claim so the lease expiry retries the same channel
 * later instead of risking a duplicate (P3-M1).
 *
 * When several offsets are overdue at once (cron downtime), all are claimed
 * but only one message — the nearest offset — is sent, so a patient never
 * receives a burst of stale reminders.
 */

const HOUR_MS = 3_600_000;
export const MAX_REMINDER_OFFSET_HOURS = 168;
/** Mirrors the SQL lease in reminder_offset_actionable (15 minutes). */
export const REMINDER_CLAIM_LEASE_MS = 15 * 60_000;

export type ReminderRunSummary = {
  appointments: number;
  sent: number;
  failed: number;
  skipped: number;
};

type ClinicReminderContext = {
  name: string;
  timezone: string;
  locale: string;
  timeFormat: string;
  digits: string;
  offsets: number[];
  templates: AutomatedTemplateRow[];
  patients: Map<string, { full_name: string; phone: string | null; email: string | null }>;
  doctors: Map<string, string>;
};

/**
 * Offsets that must not be attempted: finalized sends and fresh claims.
 * Stale claims (older than the lease) stay actionable so a crashed run's
 * reminder is recovered; the claim RPC re-checks the same rule under a lock.
 */
function unavailableOffsets(value: unknown, now: Date): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set();
  }
  const unavailable = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as { state?: unknown; at?: unknown };
      if (record.state === "claimed") {
        const claimedAt =
          typeof record.at === "string" ? new Date(record.at).getTime() : Number.NaN;
        const stale =
          Number.isNaN(claimedAt) ||
          claimedAt < now.getTime() - REMINDER_CLAIM_LEASE_MS;
        if (stale) continue;
      }
    }
    unavailable.add(key);
  }
  return unavailable;
}

function formatScheduledAt(
  scheduledAt: Date,
  context: Pick<ClinicReminderContext, "timezone" | "locale" | "timeFormat" | "digits">,
): { dateText: string; timeText: string } {
  const locale = toNumberingLocale({
    locale: context.locale,
    digits: context.digits === "arabic" ? "arabic" : "latin",
  });
  const dateText = new Intl.DateTimeFormat(locale, {
    timeZone: context.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(scheduledAt);
  const timeText = new Intl.DateTimeFormat(locale, {
    timeZone: context.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: context.timeFormat === "12h",
  }).format(scheduledAt);
  return { dateText, timeText };
}

async function loadClinicContext(
  clinicId: string,
  patientIds: readonly string[],
  doctorIds: readonly string[],
): Promise<ClinicReminderContext | null> {
  const settings = await getClinicReminderSettings(clinicId);
  if (settings.error || !settings.data) return null;

  const client = createClinicScopedAdminClient(clinicId);
  const [templates, patients, doctors] = await Promise.all([
    client
      .from("message_templates")
      .select("id, name, language, variables, approval_status, channel")
      .eq("channel", "whatsapp")
      .eq("approval_status", "approved")
      .eq("name", REMINDER_TEMPLATE_NAME),
    client
      .from("patients")
      .select("id, full_name, phone, email")
      .in("id", [...patientIds]),
    client
      .from("profiles")
      .select("id, full_name")
      .in("id", [...doctorIds]),
  ]);
  if (templates.error || patients.error || doctors.error) return null;

  return {
    name: settings.data.name,
    timezone: settings.data.timezone,
    locale: settings.data.locale,
    timeFormat: settings.data.time_format,
    digits: settings.data.digits,
    offsets: settings.data.reminder_offsets ?? [24, 3],
    templates: templates.data ?? [],
    patients: new Map(
      (patients.data ?? []).map((row) => [
        row.id,
        { full_name: row.full_name, phone: row.phone, email: row.email },
      ]),
    ),
    doctors: new Map((doctors.data ?? []).map((row) => [row.id, row.full_name])),
  };
}

export async function runAppointmentReminders(
  now: Date = new Date(),
): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = {
    appointments: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  const horizon = new Date(now.getTime() + MAX_REMINDER_OFFSET_HOURS * HOUR_MS);
  const candidates = await listReminderCandidateAppointments(
    now.toISOString(),
    horizon.toISOString(),
  );
  if (candidates.error) {
    Sentry.captureMessage("reminder cron could not list candidates", {
      level: "error",
      tags: { scope: "messaging-cron" },
    });
    return summary;
  }

  const byClinic = new Map<string, NonNullable<typeof candidates.data>>();
  for (const row of candidates.data ?? []) {
    const list = byClinic.get(row.clinic_id) ?? [];
    list.push(row);
    byClinic.set(row.clinic_id, list);
  }

  for (const [clinicId, appointments] of byClinic) {
    const context = await loadClinicContext(
      clinicId,
      [...new Set(appointments.map((row) => row.patient_id))],
      [...new Set(appointments.map((row) => row.doctor_id))],
    );
    if (!context) {
      summary.skipped += appointments.length;
      continue;
    }

    for (const appointment of appointments) {
      const scheduledAt = new Date(appointment.scheduled_at);
      const unavailable = unavailableOffsets(appointment.reminders_sent, now);
      const dueOffsets = context.offsets
        .filter(
          (offset) =>
            !unavailable.has(String(offset)) &&
            scheduledAt.getTime() - offset * HOUR_MS <= now.getTime() &&
            scheduledAt.getTime() > now.getTime(),
        )
        .sort((a, b) => a - b);
      if (dueOffsets.length === 0) continue;
      summary.appointments += 1;

      // Claim every due offset; only the nearest one produces a message.
      const claimed: number[] = [];
      for (const offset of dueOffsets) {
        const claim = await claimAppointmentReminder({
          clinicId,
          appointmentId: appointment.id,
          offsetHours: offset,
          claimedAt: now.toISOString(),
        });
        if (!claim.error && claim.data === true) claimed.push(offset);
      }
      if (claimed.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const patient = context.patients.get(appointment.patient_id);
      const doctorName = context.doctors.get(appointment.doctor_id) ?? context.name;
      const locale = patientCopyLocale(context.locale);
      const { dateText, timeText } = formatScheduledAt(scheduledAt, context);
      const copy = patient
        ? reminderCopy({
            locale,
            patientName: patient.full_name,
            clinicName: context.name,
            doctorName,
            dateText,
            timeText,
          })
        : null;

      const result =
        patient && copy
          ? await sendAutomatedPatientMessage({
              clinicId,
              recipient: { phone: patient.phone, email: patient.email },
              locale,
              whatsappTemplates: context.templates,
              templateValues: {
                patient_name: patient.full_name,
                clinic_name: context.name,
                doctor_name: doctorName,
                appointment_date: dateText,
                appointment_time: timeText,
              },
              subject: copy.subject,
              body: copy.body,
              relatedType: "appointment",
              relatedId: appointment.id,
            })
          : ({ ok: false, code: "NO_USABLE_CHANNEL" } as const);

      if (result.ok) {
        summary.sent += 1;
        // Only now does the lease become a durable sent marker (P3-H3).
        for (const offset of claimed) {
          await finalizeAppointmentReminder({
            clinicId,
            appointmentId: appointment.id,
            offsetHours: offset,
            sentAt: new Date().toISOString(),
          });
        }
        continue;
      }

      if (result.code === "PROVIDER_SEND_AMBIGUOUS") {
        // The message may have gone out: keep the claims so nothing re-sends
        // inside the lease window; if it was lost, the stale claims retry on
        // a later run. No admin alert for a possibly-delivered reminder.
        summary.failed += 1;
        continue;
      }

      summary.failed += 1;
      // Definite failure: release so the next run retries, and tell the
      // clinic admins once.
      for (const offset of claimed) {
        await releaseAppointmentReminder({
          clinicId,
          appointmentId: appointment.id,
          offsetHours: offset,
        });
      }
      await emitClinicNotification({
        clinicId,
        type: "reminder_failed",
        link: "/appointments",
        data: {
          appointmentId: appointment.id,
          patientName: patient?.full_name ?? "",
          scheduledAt: appointment.scheduled_at,
        },
        roles: ["admin"],
        dedupeUnread: true,
        dedupeData: { appointmentId: appointment.id },
      });
    }
  }

  return summary;
}
