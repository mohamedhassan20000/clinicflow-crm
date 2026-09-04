import "server-only";

import { z } from "zod";
import { ActionBusinessRuleError } from "@/lib/ai/actions/errors";
import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import {
  createPendingActionBooking,
  previewPendingBooking,
} from "@/lib/booking/pending-workflow";
import { createClient } from "@/lib/supabase/server";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import { formatScheduledAt } from "@/lib/messaging/format";
import {
  FOLLOWUP_TEMPLATE_NAME,
  followupCopy,
  patientCopyLocale,
  REMINDER_TEMPLATE_NAME,
  reminderCopy,
} from "@/lib/messaging/patient-copy";
import {
  anyChannelFailed,
  anyChannelSent,
  dispatchPatientMessage,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { AUTOMATED_TEMPLATE_APPROVAL_STATES } from "@/lib/messaging/automated-send";

const MAX_RECIPIENTS = 25;

const appointmentReminderSchema = z.object({
  appointments: z.array(z.object({ id: z.string().uuid() }).passthrough()).min(1).max(MAX_RECIPIENTS),
}).strict();

const invoiceReminderSchema = z.object({
  invoices: z.array(z.object({ appointment_id: z.string().uuid() }).passthrough()).min(1).max(MAX_RECIPIENTS),
}).strict();

const pendingBookingSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid(),
  department_id: z.string().uuid().nullable().optional(),
  scheduled_at: z.string().datetime(),
  duration_minutes: z.number().int().min(15).max(240).default(30),
}).strict();

async function appointmentReminderDrafts(user: Parameters<ActionDefinition["preview"]>[0], appointments: Array<{ id: string }>) {
  const ids = [...new Set(appointments.map(({ id }) => id))];
  const supabase = await createClient();
  const { data, error } = await supabase.from("appointments")
    .select("id, scheduled_at, patients(full_name, phone, email), profiles!doctor_id(full_name)")
    .eq("clinic_id", user.clinicId).is("deleted_at", null).in("status", ["pending", "confirmed"]).in("id", ids);
  if (error || !data || data.length !== ids.length) throw new ActionBusinessRuleError("appointments_unavailable");
  const settings = await getClinicReminderSettings(user.clinicId);
  if (settings.error || !settings.data) throw new Error("Appointment reminder settings unavailable.");
  const client = createClinicScopedAdminClient(user.clinicId);
  const [templates, whatsappProvider] = await Promise.all([
    client.from("message_templates").select("id, name, language, variables, approval_status, channel")
      .eq("channel", "whatsapp").in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES).eq("name", REMINDER_TEMPLATE_NAME),
    getActiveWhatsAppProvider(user.clinicId),
  ]);
  if (templates.error) throw new Error("Appointment reminder templates unavailable.");
  const byId = new Map(data.map((row) => [row.id, row]));
  return {
    templates: (templates.data ?? []) as AutomatedTemplateRow[], whatsappProvider,
    whatsappActive: whatsappProvider !== null,
    drafts: ids.map((id) => {
      const appointment = byId.get(id)!;
      const patient = appointment.patients;
      const locale = patientCopyLocale(settings.data!.locale);
      const scheduled = formatScheduledAt(new Date(appointment.scheduled_at), {
        timezone: settings.data!.timezone, locale: settings.data!.locale,
        timeFormat: settings.data!.time_format, digits: settings.data!.digits,
      });
      const copy = reminderCopy({ locale, patientName: patient?.full_name ?? "", clinicName: settings.data!.name,
        doctorName: appointment.profiles?.full_name ?? settings.data!.name, dateText: scheduled.dateText, timeText: scheduled.timeText });
      const channels: Array<"email" | "whatsapp"> = [];
      if (patient?.email) channels.push("email");
      if (whatsappProvider !== null && patient?.phone) channels.push("whatsapp");
      return { appointmentId: appointment.id, patientName: patient?.full_name ?? "", scheduledAt: appointment.scheduled_at,
        scheduledLabel: `${scheduled.dateText} · ${scheduled.timeText}`, channels, recipient: { phone: patient?.phone ?? null, email: patient?.email ?? null },
        locale, subject: copy.subject, body: copy.body, templateValues: { patient_name: patient?.full_name ?? "", clinic_name: settings.data!.name,
          doctor_name: appointment.profiles?.full_name ?? settings.data!.name, appointment_date: scheduled.dateText, appointment_time: scheduled.timeText } };
    }),
  };
}

async function invoiceReminderDrafts(user: Parameters<ActionDefinition["preview"]>[0], invoices: Array<{ appointment_id: string }>) {
  const ids = [...new Set(invoices.map(({ appointment_id }) => appointment_id))];
  const supabase = await createClient();
  const { data, error } = await supabase.from("appointments")
    .select("id, outstanding_amount, patients(full_name, phone, email)")
    .eq("clinic_id", user.clinicId).eq("status", "completed").is("deleted_at", null).gt("outstanding_amount", 0).in("id", ids);
  if (error || !data || data.length !== ids.length) throw new ActionBusinessRuleError("invoices_unavailable");
  const settings = await getClinicReminderSettings(user.clinicId);
  if (settings.error || !settings.data) throw new Error("Invoice reminder settings unavailable.");
  const client = createClinicScopedAdminClient(user.clinicId);
  const [templates, whatsappProvider] = await Promise.all([
    client.from("message_templates").select("id, name, language, variables, approval_status, channel")
      .eq("channel", "whatsapp").in("approval_status", AUTOMATED_TEMPLATE_APPROVAL_STATES).eq("name", FOLLOWUP_TEMPLATE_NAME),
    getActiveWhatsAppProvider(user.clinicId),
  ]);
  if (templates.error) throw new Error("Invoice reminder templates unavailable.");
  const byId = new Map(data.map((row) => [row.id, row]));
  return { templates: (templates.data ?? []) as AutomatedTemplateRow[], whatsappProvider,
    whatsappActive: whatsappProvider !== null, drafts: ids.map((id) => {
    const invoice = byId.get(id)!; const patient = invoice.patients; const locale = patientCopyLocale(settings.data!.locale);
    const copy = followupCopy({ locale, patientName: patient?.full_name ?? "", clinicName: settings.data!.name, step: 0 });
    const channels: Array<"email" | "whatsapp"> = [];
    if (patient?.email) channels.push("email"); if (whatsappProvider !== null && patient?.phone) channels.push("whatsapp");
    return { appointmentId: invoice.id, patientName: patient?.full_name ?? "", clinicName: settings.data!.name,
      outstandingAmount: Number(invoice.outstanding_amount ?? 0), channels,
      recipient: { phone: patient?.phone ?? null, email: patient?.email ?? null }, locale,
      subject: settings.data!.invoice_followup_email_subject?.trim() || copy.subject,
      body: settings.data!.invoice_followup_email_body?.trim() || copy.body };
  }) };
}

const appointmentReminders: ActionDefinition<z.infer<typeof appointmentReminderSchema>> = {
  id: "appointments.send_reminders", roles: ["admin", "receptionist"],
  requiredFeatures: ["ai_assistant", "ai.workflows", "ai.staff_analytics"], risk: "bulk", pageSlug: "appointments",
  inputSchema: appointmentReminderSchema,
  labels: { en: "Send appointment reminders", ar: "إرسال تذكيرات المواعيد" },
  description: { en: "Preview and send up to 25 appointment reminders.", ar: "معاينة وإرسال حتى 25 تذكيراً للموعد." },
  inputDescription: { en: "Authorized pending or confirmed appointment ids.", ar: "معرفات مواعيد معلقة أو مؤكدة ومصرح بها." },
  async preview(user, input) {
    const prepared = await appointmentReminderDrafts(user, input.appointments);
    const items = prepared.drafts.map((draft) => `${draft.patientName} — ${draft.scheduledLabel} (${draft.channels.join(", ") || "no channel"})`);
    return { title: "Send appointment reminders", summary: `Send ${items.length} appointment reminder${items.length === 1 ? "" : "s"}.`,
      changes: items.map((item) => ({ label: "Reminder", before: null, after: `Appointment reminder for ${item}`, identifiesRecord: true as const })), audit: { targetTable: "appointments", targetRecordIds: prepared.drafts.map((draft) => draft.appointmentId) } };
  },
  async execute(user, input) {
    const prepared = await appointmentReminderDrafts(user, input.appointments); const outcomes = [];
    let anyFailed = false; let anyCompleted = false;
    for (const draft of prepared.drafts) {
      const result = await dispatchPatientMessage({ clinicId: user.clinicId, dedupeKey: `appointment_reminder:${draft.appointmentId}`,
        recipient: draft.recipient, locale: draft.locale, whatsappActive: prepared.whatsappActive, whatsappProvider: prepared.whatsappProvider, whatsappTemplates: prepared.templates,
        templateValues: draft.templateValues, subject: draft.subject, body: draft.body, relatedType: "appointment", relatedId: draft.appointmentId });
      anyFailed ||= anyChannelFailed(result); anyCompleted ||= anyChannelSent(result) || result.email?.status === "duplicate" || result.whatsapp?.status === "duplicate";
      outcomes.push({ appointment_id: draft.appointmentId, email: result.email?.status ?? "not_attempted", whatsapp: result.whatsapp?.status ?? "not_attempted" });
    }
    return { summary: anyFailed ? "Appointment reminders were sent where possible; some channels failed." : "Appointment reminders were sent or were already delivered.",
      data: { count: outcomes.length, outcomes, partial_failure: anyFailed && anyCompleted }, audit: { targetTable: "message_dispatches", targetRecordIds: prepared.drafts.map((draft) => draft.appointmentId) } };
  },
};

const invoiceReminders: ActionDefinition<z.infer<typeof invoiceReminderSchema>> = {
  id: "invoices.send_reminders", roles: ["admin", "manager"], requiredFeatures: ["ai_assistant", "ai.workflows", "ai.staff_analytics", "ai.financial_insights"],
  requiredUserPermission: "ai.financial_insights", risk: "bulk", pageSlug: "revenue", inputSchema: invoiceReminderSchema,
  labels: { en: "Send invoice reminders", ar: "إرسال تذكيرات الفواتير" }, description: { en: "Preview and send up to 25 overdue-invoice reminders.", ar: "معاينة وإرسال حتى 25 تذكيراً لفاتورة متأخرة." },
  inputDescription: { en: "Authorized outstanding appointment ids.", ar: "معرفات المواعيد ذات الرصيد المستحق والمصرح بها." },
  async preview(user, input) { const prepared = await invoiceReminderDrafts(user, input.invoices); return { title: "Send invoice reminders", summary: `Send ${prepared.drafts.length} overdue-invoice reminder${prepared.drafts.length === 1 ? "" : "s"}.`,
    changes: prepared.drafts.map((draft) => ({ label: draft.patientName, before: draft.outstandingAmount, after: `Reminder for ${draft.patientName} will be sent`, identifiesRecord: true as const })), audit: { targetTable: "appointments", targetRecordIds: prepared.drafts.map((draft) => draft.appointmentId) } }; },
  async execute(user, input) { const prepared = await invoiceReminderDrafts(user, input.invoices); const outcomes = []; let anyFailed = false; let anyCompleted = false;
    for (const draft of prepared.drafts) { const result = await dispatchPatientMessage({ clinicId: user.clinicId, dedupeKey: `invoice_followup:${draft.appointmentId}:step0`, recipient: draft.recipient,
      locale: draft.locale, whatsappActive: prepared.whatsappActive, whatsappProvider: prepared.whatsappProvider, whatsappTemplates: prepared.templates, templateValues: { patient_name: draft.patientName, clinic_name: draft.clinicName, doctor_name: draft.clinicName },
      subject: draft.subject, body: draft.body, relatedType: "invoice", relatedId: draft.appointmentId }); anyFailed ||= anyChannelFailed(result); anyCompleted ||= anyChannelSent(result) || result.email?.status === "duplicate" || result.whatsapp?.status === "duplicate";
      outcomes.push({ appointment_id: draft.appointmentId, email: result.email?.status ?? "not_attempted", whatsapp: result.whatsapp?.status ?? "not_attempted" }); }
    return { summary: anyFailed ? "Invoice reminders were sent where possible; some channels failed." : "Invoice reminders were sent or were already delivered.", data: { count: outcomes.length, outcomes, partial_failure: anyFailed && anyCompleted }, audit: { targetTable: "message_dispatches", targetRecordIds: prepared.drafts.map((draft) => draft.appointmentId) } }; },
};

const pendingBooking: ActionDefinition<z.infer<typeof pendingBookingSchema>> = {
  id: "appointments.create_pending", roles: ["admin", "receptionist"], requiredFeatures: ["ai_assistant", "ai.workflows"], risk: "normal", pageSlug: "appointments", inputSchema: pendingBookingSchema,
  labels: { en: "Create pending appointment", ar: "إنشاء موعد معلّق" }, description: { en: "Preview and create one pending appointment without notifying the patient.", ar: "معاينة وإنشاء موعد معلق واحد دون إشعار المريض." }, inputDescription: { en: "Patient, doctor, optional department, time, and duration.", ar: "المريض والطبيب والقسم الاختياري والوقت والمدة." },
  async preview(user, booking) { const supabase = await createClient(); const preview = await previewPendingBooking({ supabase, user, booking }); if (!preview) throw new ActionBusinessRuleError("booking_unavailable"); return { title: "Create pending appointment", summary: "Create this pending appointment without notifying the patient.", changes: [
    { label: "Patient", before: null, after: preview.patient_name }, { label: "Doctor", before: null, after: preview.doctor_name }, { label: "Time", before: null, after: preview.scheduled_at_label }, { label: "Status", before: null, after: preview.status }, { label: "Patient notification", before: null, after: preview.patient_notification },
  ], audit: { targetTable: "appointments" } }; },
  async execute(user, booking, context) { const supabase = await createClient(); const created = await createPendingActionBooking({ supabase, user, booking, actionReceiptId: context.actionReceiptId }); if (!created.ok) throw new ActionBusinessRuleError(created.reason); return { summary: "Pending appointment created without notifying the patient.", data: { appointment_id: created.appointmentId, booking: created.preview }, audit: { targetTable: "appointments", targetRecordIds: [created.appointmentId], after: created.preview } }; },
};

export const LEGACY_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] = [
  registerActionDefinition(appointmentReminders),
  registerActionDefinition(invoiceReminders),
  registerActionDefinition(pendingBooking),
];
