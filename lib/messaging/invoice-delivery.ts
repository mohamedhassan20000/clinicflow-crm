import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import { formatClinicCurrency } from "@/lib/datetime";
import {
  invoiceIssuedCopy,
  patientCopyLocale,
  INVOICE_TEMPLATE_NAME,
  type PatientCopyLocale,
  type TemplateVariable,
} from "@/lib/messaging/patient-copy";
import {
  dispatchPatientMessage,
  type AutomatedTemplateRow,
  type DispatchResult,
} from "@/lib/messaging/automated-send";
import { hasActiveWhatsAppChannel } from "@/lib/messaging/channel-management";

/**
 * Event-driven invoice delivery (§7.3a, 2026-07-18 direction).
 *
 * The moment an invoice is issued (billing completes on
 * `updateAppointmentStatus`), the invoice is delivered immediately to the
 * patient via WhatsApp + Email — no cron. Best-effort: a delivery failure never
 * fails billing, and every attempt is recorded on `outbound_messages`.
 *
 * P3 is deliberately **template-agnostic**: the pipeline is
 *   compose summary  → render message → send
 * so P7 (System Templates & Document Engine) can replace the rendered document
 * (`renderInvoiceMessage`) with the professional, serialized invoice without
 * touching the compose or send stages or the calling action. The P3 summary is
 * the existing appointment/billing representation — no invoice table, no
 * serial number (those arrive in P7).
 */

/** Minimal, template-agnostic P3 invoice representation. */
export type InvoiceSummary = {
  clinicId: string;
  appointmentId: string;
  patient: { full_name: string; phone: string | null; email: string | null };
  clinicName: string;
  locale: PatientCopyLocale;
  currency: string;
  clinicLocaleTag: string;
  digits: "latin" | "arabic";
  total: number;
  outstanding: number;
};

/** compose stage: read the existing billing representation for one appointment. */
export async function buildInvoiceSummary(
  clinicId: string,
  appointmentId: string,
): Promise<{ summary: InvoiceSummary; templates: AutomatedTemplateRow[] } | null> {
  const client = createClinicScopedAdminClient(clinicId);
  const appointment = await client
    .from("appointments")
    .select("id, patient_id, total_amount, outstanding_amount")
    .eq("id", appointmentId)
    .maybeSingle();
  if (appointment.error || !appointment.data) return null;

  const settings = await getClinicReminderSettings(clinicId);
  if (settings.error || !settings.data) return null;

  const [patient, templates] = await Promise.all([
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
      .eq("name", INVOICE_TEMPLATE_NAME),
  ]);
  if (patient.error || !patient.data) return null;

  const digits = settings.data.digits === "arabic" ? "arabic" : "latin";
  return {
    summary: {
      clinicId,
      appointmentId,
      patient: {
        full_name: patient.data.full_name,
        phone: patient.data.phone,
        email: patient.data.email,
      },
      clinicName: settings.data.name,
      locale: patientCopyLocale(settings.data.locale),
      currency: settings.data.currency ?? "KWD",
      clinicLocaleTag: settings.data.locale,
      digits,
      total: Number(appointment.data.total_amount ?? 0),
      outstanding: Number(appointment.data.outstanding_amount ?? 0),
    },
    templates: (templates.data ?? []) as AutomatedTemplateRow[],
  };
}

/**
 * render stage: turn the summary into subject/body + WhatsApp template values.
 * P7 replaces this with the rendered professional document while keeping the
 * same input/output contract.
 */
export function renderInvoiceMessage(summary: InvoiceSummary): {
  subject: string;
  body: string;
  templateValues: Record<TemplateVariable, string>;
} {
  const money = (value: number) =>
    formatClinicCurrency(value, {
      locale: summary.clinicLocaleTag,
      currency: summary.currency,
      digits: summary.digits,
    });
  const totalText = money(summary.total);
  const outstandingText = money(summary.outstanding);
  const hasOutstanding = summary.outstanding > 0.001;
  const copy = invoiceIssuedCopy({
    locale: summary.locale,
    patientName: summary.patient.full_name,
    clinicName: summary.clinicName,
    totalText,
    outstandingText,
    hasOutstanding,
  });
  return {
    subject: copy.subject,
    body: copy.body,
    templateValues: {
      patient_name: summary.patient.full_name,
      clinic_name: summary.clinicName,
      doctor_name: summary.clinicName,
      appointment_date: "",
      appointment_time: "",
      invoice_total: totalText,
      invoice_outstanding: hasOutstanding ? outstandingText : totalText,
    },
  };
}

/**
 * send stage: Email and WhatsApp dispatched independently (Email always if the
 * patient has one; WhatsApp only if the clinic has an active integration), each
 * idempotent on `invoice:<appointmentId>`, recorded on outbound_messages.
 *
 * Triggered manually from the "Send to patient" action (2026-07-19 flow
 * revision) — not automatically after billing. Returns the per-channel result
 * so the UI can report what was delivered; `null` when the invoice could not be
 * composed (missing appointment/patient).
 */
export async function deliverIssuedInvoice(input: {
  clinicId: string;
  appointmentId: string;
}): Promise<DispatchResult | null> {
  try {
    const [composed, whatsappActive] = await Promise.all([
      buildInvoiceSummary(input.clinicId, input.appointmentId),
      hasActiveWhatsAppChannel(input.clinicId),
    ]);
    if (!composed) return null;
    const { summary, templates } = composed;
    const rendered = renderInvoiceMessage(summary);

    return await dispatchPatientMessage({
      clinicId: input.clinicId,
      dedupeKey: `invoice:${input.appointmentId}`,
      recipient: {
        phone: summary.patient.phone,
        email: summary.patient.email,
      },
      locale: summary.locale,
      whatsappActive,
      whatsappTemplates: templates,
      templateValues: rendered.templateValues,
      subject: rendered.subject,
      body: rendered.body,
      relatedType: "invoice",
      relatedId: input.appointmentId,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "messaging-invoice-delivery" },
      extra: { appointmentId: input.appointmentId },
    });
    return null;
  }
}
