import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  downloadClinicDocumentPdf,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import { formatClinicCurrency } from "@/lib/datetime";
import { issueInvoiceDocument } from "@/lib/documents/invoice-issuance";
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
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { AUTOMATED_TEMPLATE_APPROVAL_STATES } from "@/lib/messaging/automated-send";
import type { MessageAttachment } from "@/lib/messaging/types";

/**
 * Manual invoice delivery seam (§7.3a, 2026-07-19 flow revision).
 *
 * The pipeline is deliberately template-agnostic —
 *   compose summary  → render message → send
 * — and P7-7 completes it without a parallel delivery system: the same seam now
 * (1) issues the canonical, serialized professional invoice document
 * (idempotent per appointment), and (2) attaches that stored PDF to the email
 * channel. Email and WhatsApp remain independent, each idempotent on
 * `invoice:<appointmentId>` via the `message_dispatches` ledger, and every
 * attempt is still recorded on `outbound_messages`. A document-issuance or
 * PDF-read failure degrades gracefully to the existing text summary rather than
 * blocking delivery.
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
      .in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES)
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
export function renderInvoiceMessage(
  summary: InvoiceSummary,
  documentNumber?: string | null,
): {
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
  // The professional invoice PDF (attached to email) carries the full detail;
  // the message body references its canonical number when one was issued.
  const numberLine = documentNumber
    ? summary.locale === "ar"
      ? `\nرقم الفاتورة: ${documentNumber}`
      : `\nInvoice number: ${documentNumber}`
    : "";
  return {
    subject: copy.subject,
    body: `${copy.body}${numberLine}`,
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
 * Issue-and-read the canonical invoice PDF for email attachment. Best-effort:
 * a failure here degrades to a text-only delivery so the patient still receives
 * their invoice summary. Returns the attachment and the canonical number when
 * available.
 */
async function prepareInvoiceAttachment(input: {
  clinicId: string;
  actorId: string;
  appointmentId: string;
  locale: PatientCopyLocale;
}): Promise<{ attachment: MessageAttachment | null; documentNumber: string | null }> {
  try {
    const issued = await issueInvoiceDocument({
      clinicId: input.clinicId,
      actorId: input.actorId,
      appointmentId: input.appointmentId,
      locale: input.locale,
    });
    const download = await downloadClinicDocumentPdf({
      clinicId: input.clinicId,
      documentType: "INVOICE",
      documentId: issued.documentId,
    });
    if (download.error || !download.data) {
      return { attachment: null, documentNumber: issued.documentNumber };
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const filename = `${issued.documentNumber}.pdf`;
    return {
      attachment: {
        filename,
        content: Buffer.from(bytes).toString("base64"),
        contentType: "application/pdf",
      },
      documentNumber: issued.documentNumber,
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "messaging-invoice-attachment" },
      extra: { appointmentId: input.appointmentId },
    });
    return { attachment: null, documentNumber: null };
  }
}

/**
 * send stage: Email and WhatsApp dispatched independently (Email always if the
 * patient has one; WhatsApp only if the clinic has an active integration), each
 * idempotent on `invoice:<appointmentId>`, recorded on outbound_messages.
 *
 * Triggered manually from the "Send to patient" action (2026-07-19 flow
 * revision) — not automatically after billing. P7-7 attaches the canonical
 * serialized invoice PDF to the email channel. Returns the per-channel result
 * so the UI can report what was delivered; `null` when the invoice could not be
 * composed (missing appointment/patient).
 */
export async function deliverIssuedInvoice(input: {
  clinicId: string;
  appointmentId: string;
  actorId: string;
}): Promise<DispatchResult | null> {
  try {
    const settings = await getClinicReminderSettings(input.clinicId);
    const locale = patientCopyLocale(settings.data?.locale);
    const [composed, whatsappProvider, prepared] = await Promise.all([
      buildInvoiceSummary(input.clinicId, input.appointmentId),
      getActiveWhatsAppProvider(input.clinicId),
      prepareInvoiceAttachment({
        clinicId: input.clinicId,
        actorId: input.actorId,
        appointmentId: input.appointmentId,
        locale,
      }),
    ]);
    if (!composed) return null;
    const { summary, templates } = composed;
    const rendered = renderInvoiceMessage(summary, prepared.documentNumber);

    return await dispatchPatientMessage({
      clinicId: input.clinicId,
      dedupeKey: `invoice:${input.appointmentId}`,
      recipient: {
        phone: summary.patient.phone,
        email: summary.patient.email,
      },
      locale: summary.locale,
      whatsappActive: whatsappProvider !== null,
      whatsappProvider,
      whatsappTemplates: templates,
      templateValues: rendered.templateValues,
      subject: rendered.subject,
      body: rendered.body,
      relatedType: "invoice",
      relatedId: input.appointmentId,
      emailAttachments: prepared.attachment ? [prepared.attachment] : undefined,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "messaging-invoice-delivery" },
      extra: { appointmentId: input.appointmentId },
    });
    return null;
  }
}
