import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertWorkflowActionAccess } from "@/lib/ai/authorization";
import { workflowInvocationIdentity } from "@/lib/ai/workflows/executor";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { createClient } from "@/lib/supabase/server";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import { formatScheduledAt } from "@/lib/messaging/format";
import {
  patientCopyLocale,
  reminderCopy,
  REMINDER_TEMPLATE_NAME,
} from "@/lib/messaging/patient-copy";
import {
  anyChannelFailed,
  anyChannelSent,
  dispatchPatientMessage,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { hasActiveWhatsAppChannel } from "@/lib/messaging/channel-management";
import { logAgentTool } from "@/lib/ai/audit";

const MAX_RECIPIENTS = 25;

const inputSchema = z
  .object({
    appointments: z
      .array(
        z
          .object({ id: z.string().uuid() })
          .passthrough(),
      )
      .min(1)
      .max(MAX_RECIPIENTS),
  })
  .strict();

type ReminderDraft = {
  appointment_id: string;
  patient_name: string;
  scheduled_at: string;
  scheduled_at_label: string;
  channels: Array<"email" | "whatsapp">;
  recipient: { phone: string | null; email: string | null };
  locale: "ar" | "en";
  subject: string;
  body: string;
  templateValues: Record<string, string>;
};

async function buildDrafts(
  ctx: DoctorToolContext,
  requested: Array<{ id: string }>,
): Promise<
  | { ok: true; drafts: ReminderDraft[]; templates: AutomatedTemplateRow[]; whatsappActive: boolean }
  | { ok: false }
> {
  const ids = [...new Set(requested.map((row) => row.id))];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, patient_id, doctor_id, patients(full_name, phone, email), profiles!doctor_id(full_name)",
    )
    .eq("clinic_id", ctx.user.clinicId)
    .is("deleted_at", null)
    .in("status", ["pending", "confirmed"])
    .in("id", ids);
  if (error || !data || data.length !== ids.length) return { ok: false };

  const settings = await getClinicReminderSettings(ctx.user.clinicId);
  if (settings.error || !settings.data) return { ok: false };
  const client = createClinicScopedAdminClient(ctx.user.clinicId);
  const [templates, whatsappActive] = await Promise.all([
    client
      .from("message_templates")
      .select("id, name, language, variables, approval_status, channel")
      .eq("channel", "whatsapp")
      .eq("approval_status", "approved")
      .eq("name", REMINDER_TEMPLATE_NAME),
    hasActiveWhatsAppChannel(ctx.user.clinicId),
  ]);
  if (templates.error) return { ok: false };

  const byId = new Map(data.map((appointment) => [appointment.id, appointment]));
  const drafts = ids.map((id) => byId.get(id)!).map((appointment) => {
    const patient = appointment.patients;
    const patientName = patient?.full_name ?? "";
    const doctorName = appointment.profiles?.full_name ?? settings.data!.name;
    const locale = patientCopyLocale(settings.data!.locale);
    const { dateText, timeText } = formatScheduledAt(
      new Date(appointment.scheduled_at),
      {
        timezone: settings.data!.timezone,
        locale: settings.data!.locale,
        timeFormat: settings.data!.time_format,
        digits: settings.data!.digits,
      },
    );
    const copy = reminderCopy({
      locale,
      patientName,
      clinicName: settings.data!.name,
      doctorName,
      dateText,
      timeText,
    });
    const channels: Array<"email" | "whatsapp"> = [];
    if (patient?.email) channels.push("email");
    if (whatsappActive && patient?.phone) channels.push("whatsapp");
    return {
      appointment_id: appointment.id,
      patient_name: patientName,
      scheduled_at: appointment.scheduled_at,
      scheduled_at_label: `${dateText} · ${timeText}`,
      channels,
      recipient: {
        phone: patient?.phone ?? null,
        email: patient?.email ?? null,
      },
      locale,
      subject: copy.subject,
      body: copy.body,
      templateValues: {
        patient_name: patientName,
        clinic_name: settings.data!.name,
        doctor_name: doctorName,
        appointment_date: dateText,
        appointment_time: timeText,
      },
    };
  });
  return {
    ok: true,
    drafts,
    templates: (templates.data ?? []) as AutomatedTemplateRow[],
    whatsappActive,
  };
}

export function sendAppointmentRemindersWorkflowTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Preview, then after the user's explicit workflow confirmation send appointment reminders for a bounded list returned by list_appointments. Never invent recipients or message copy.",
    inputSchema,
    execute: async ({ appointments }, options) => {
      await assertWorkflowActionAccess(
        ctx.user,
        "appointments",
        ["admin", "receptionist"],
      );
      const invocation = workflowInvocationIdentity(options);
      const prepared = await buildDrafts(ctx, appointments);
      if (!prepared.ok) {
        return {
          needs_clarification: true as const,
          field: "appointments",
          guidance:
            "One or more appointments are no longer eligible or visible. Ask the user to preview the workflow again.",
          candidates: [],
        };
      }

      const items = prepared.drafts.map((draft) => ({
        appointment_id: draft.appointment_id,
        patient_name: draft.patient_name,
        scheduled_at: draft.scheduled_at,
        scheduled_at_label: draft.scheduled_at_label,
        channels: draft.channels,
      }));
      if (invocation.mode === "preview") {
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "send_appointment_reminders",
          tableName: "appointments",
          params: { outcome: "previewed", count: items.length },
        });
        return {
          action: "send_appointment_reminders" as const,
          draft_status: "awaiting_confirmation" as const,
          count: items.length,
          items,
        };
      }

      const outcomes = [];
      let anyFailed = false;
      let anyCompleted = false;
      for (const draft of prepared.drafts) {
        const result = await dispatchPatientMessage({
          clinicId: ctx.user.clinicId,
          // Canonical reminder identity prevents a workflow and the approved
          // daily reminder core from sending the same reminder twice.
          dedupeKey: `appointment_reminder:${draft.appointment_id}`,
          recipient: draft.recipient,
          locale: draft.locale,
          whatsappActive: prepared.whatsappActive,
          whatsappTemplates: prepared.templates,
          templateValues: draft.templateValues,
          subject: draft.subject,
          body: draft.body,
          relatedType: "appointment",
          relatedId: draft.appointment_id,
        });
        anyFailed ||= anyChannelFailed(result);
        anyCompleted ||=
          anyChannelSent(result) ||
          result.email?.status === "duplicate" ||
          result.whatsapp?.status === "duplicate";
        outcomes.push({
          appointment_id: draft.appointment_id,
          email: result.email?.status ?? "not_attempted",
          whatsapp: result.whatsapp?.status ?? "not_attempted",
        });
      }
      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "send_appointment_reminders",
        tableName: "message_dispatches",
        params: {
          outcome: anyFailed ? "partially_failed" : "confirmed",
          count: outcomes.length,
        },
      });
      return {
        action: "send_appointment_reminders" as const,
        draft_status: "sent_or_idempotent" as const,
        count: outcomes.length,
        items,
        outcomes,
        workflow_run_id: invocation.runId,
        workflow_action_failed: anyFailed,
        workflow_action_partial_failure: anyFailed && anyCompleted,
      };
    },
  });
}
