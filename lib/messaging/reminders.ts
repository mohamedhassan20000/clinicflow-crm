import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
  listDailyReminderCandidates,
} from "@/lib/supabase/admin";
import { formatScheduledAt } from "@/lib/messaging/format";
import {
  patientCopyLocale,
  reminderCopy,
  REMINDER_TEMPLATE_NAME,
} from "@/lib/messaging/patient-copy";
import {
  dispatchPatientMessage,
  anyChannelSent,
  anyChannelFailed,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { AUTOMATED_TEMPLATE_APPROVAL_STATES } from "@/lib/messaging/automated-send";
import { emitClinicNotification } from "@/lib/notifications/emit";

/**
 * Daily appointment reminders (§7.2b, 2026-07-18 direction; 2026-07-19 flow
 * revision).
 *
 * The single daily morning cron sends one reminder per confirmed appointment
 * whose scheduled_at falls on the clinic-local calendar date of *today or
 * tomorrow*. Clinics with reminders disabled are excluded at the SQL layer.
 *
 * Idempotency now lives in the per-channel `message_dispatches` ledger
 * (dedupe_key `appointment_reminder:<id>`): Email and WhatsApp are dispatched
 * independently, each sent at most once, and if one channel fails while the
 * other succeeds only the failed channel retries on a later run. Because the
 * dedupe is per channel, an appointment reminded today as "tomorrow" is skipped
 * tomorrow as "today".
 */

const DAY_MS = 86_400_000;
/**
 * Selection horizon. Today+tomorrow in the clinic's local calendar can be up to
 * ~48h ahead of "now"; the SQL candidate query does the exact local-date
 * filtering, this bound just keeps the scan index-friendly.
 */
export const REMINDER_HORIZON_MS = 2 * DAY_MS;

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
  templates: AutomatedTemplateRow[];
  patients: Map<string, { full_name: string; phone: string | null; email: string | null }>;
  doctors: Map<string, string>;
};

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
      .in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES)
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

  const horizon = new Date(now.getTime() + REMINDER_HORIZON_MS);
  const candidates = await listDailyReminderCandidates(
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
    const whatsappProvider = await getActiveWhatsAppProvider(clinicId);
    const whatsappActive = whatsappProvider !== null;

    for (const appointment of appointments) {
      summary.appointments += 1;

      const patient = context.patients.get(appointment.patient_id);
      if (!patient) {
        summary.skipped += 1;
        continue;
      }

      const scheduledAt = new Date(appointment.scheduled_at);
      const doctorName = context.doctors.get(appointment.doctor_id) ?? context.name;
      const locale = patientCopyLocale(context.locale);
      const { dateText, timeText } = formatScheduledAt(scheduledAt, context);
      const copy = reminderCopy({
        locale,
        patientName: patient.full_name,
        clinicName: context.name,
        doctorName,
        dateText,
        timeText,
      });

      const result = await dispatchPatientMessage({
        clinicId,
        dedupeKey: `appointment_reminder:${appointment.id}`,
        recipient: { phone: patient.phone, email: patient.email },
        locale,
        whatsappActive,
        whatsappProvider,
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
      });

      if (anyChannelSent(result)) {
        summary.sent += 1;
        continue;
      }
      // Nothing newly sent. Alert admins only on a definite failure (a channel
      // that was attempted and failed); a fully-deduped or unreachable patient
      // is a quiet skip. The failed channel's claim is already released, so it
      // retries on the next run.
      if (anyChannelFailed(result)) {
        summary.failed += 1;
        await emitClinicNotification({
          clinicId,
          type: "reminder_failed",
          link: "/appointments",
          data: {
            appointmentId: appointment.id,
            patientName: patient.full_name,
            scheduledAt: appointment.scheduled_at,
          },
          roles: ["admin"],
          dedupeUnread: true,
          dedupeData: { appointmentId: appointment.id },
        });
        continue;
      }
      summary.skipped += 1;
    }
  }

  return summary;
}
