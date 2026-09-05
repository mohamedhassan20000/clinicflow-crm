import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import { formatScheduledAt } from "@/lib/messaging/format";
import {
  appointmentEventCopy,
  patientCopyLocale,
  APPOINTMENT_EVENT_TEMPLATE_NAME,
  type AppointmentEvent,
} from "@/lib/messaging/patient-copy";
import {
  dispatchPatientMessage,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { AUTOMATED_TEMPLATE_APPROVAL_STATES } from "@/lib/messaging/automated-send";

export type { AppointmentEvent };

/**
 * Event-driven appointment notifications (§7.2a, 2026-07-18 direction).
 *
 * Sent immediately and inline from the appointment mutations — not by cron —
 * when an appointment is created (pending), confirmed, rescheduled, or
 * cancelled. WhatsApp-first with Email fallback through the shared
 * `sendAutomatedPatientMessage` boundary; the WhatsApp path uses the clinic's
 * approved template for that event, and email falls back to built-in ar/en
 * copy in the clinic's locale.
 *
 * This is awareness for the patient, never a record: the call is best-effort
 * and never throws into (or fails) the appointment action that triggered it.
 * The delivery attempt is still recorded on `outbound_messages` by
 * `sendMessage`, so failures remain auditable.
 *
 * The `rescheduled` event is wired here and ready; the reschedule trigger is
 * added when the reschedule flow / `rescheduled` status lands (roadmap §7.2a).
 */
export async function notifyAppointmentEvent(input: {
  clinicId: string;
  appointmentId: string;
  event: AppointmentEvent;
}): Promise<void> {
  const { clinicId, appointmentId, event } = input;
  try {
    const client = createClinicScopedAdminClient(clinicId);
    const appointment = await client
      .from("appointments")
      .select("id, patient_id, doctor_id, scheduled_at")
      .eq("id", appointmentId)
      .maybeSingle();
    if (appointment.error || !appointment.data) return;

    const settings = await getClinicReminderSettings(clinicId);
    if (settings.error || !settings.data) return;

    const [patient, doctor, templates, whatsappProvider] = await Promise.all([
      client
        .from("patients")
        .select("id, full_name, phone, email")
        .eq("id", appointment.data.patient_id)
        .maybeSingle(),
      client
        .from("profiles")
        .select("id, full_name")
        .eq("id", appointment.data.doctor_id)
        .maybeSingle(),
      client
        .from("message_templates")
        .select("id, name, language, variables, approval_status, channel")
        .eq("channel", "whatsapp")
        .in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES)
        .eq("name", APPOINTMENT_EVENT_TEMPLATE_NAME[event]),
      getActiveWhatsAppProvider(clinicId),
    ]);
    if (patient.error || !patient.data) return;

    const clinicName = settings.data.name;
    const doctorName = doctor.data?.full_name ?? clinicName;
    const locale = patientCopyLocale(settings.data.locale);
    const { dateText, timeText } = formatScheduledAt(
      new Date(appointment.data.scheduled_at),
      {
        timezone: settings.data.timezone,
        locale: settings.data.locale,
        timeFormat: settings.data.time_format,
        digits: settings.data.digits,
      },
    );
    const copy = appointmentEventCopy({
      locale,
      event,
      patientName: patient.data.full_name,
      clinicName,
      doctorName,
      dateText,
      timeText,
    });

    await dispatchPatientMessage({
      clinicId,
      dedupeKey: `appointment:${event}:${appointmentId}`,
      recipient: { phone: patient.data.phone, email: patient.data.email },
      locale,
      whatsappActive: whatsappProvider !== null,
      whatsappProvider,
      whatsappTemplates: (templates.data ?? []) as AutomatedTemplateRow[],
      templateValues: {
        patient_name: patient.data.full_name,
        clinic_name: clinicName,
        doctor_name: doctorName,
        appointment_date: dateText,
        appointment_time: timeText,
      },
      subject: copy.subject,
      body: copy.body,
      relatedType: "appointment",
      relatedId: appointmentId,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "messaging-appointment-notify" },
      extra: { appointmentId, event },
    });
  }
}
