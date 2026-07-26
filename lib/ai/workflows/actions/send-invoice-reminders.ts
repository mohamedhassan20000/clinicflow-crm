import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertFinancialInsightsAccess, assertWorkflowActionAccess } from "@/lib/ai/authorization";
import { workflowInvocationIdentity } from "@/lib/ai/workflows/executor";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { createClient } from "@/lib/supabase/server";
import {
  createClinicScopedAdminClient,
  getClinicReminderSettings,
} from "@/lib/supabase/admin";
import {
  followupCopy,
  patientCopyLocale,
  FOLLOWUP_TEMPLATE_NAME,
} from "@/lib/messaging/patient-copy";
import { hasActiveWhatsAppChannel } from "@/lib/messaging/channel-management";
import {
  anyChannelFailed,
  anyChannelSent,
  dispatchPatientMessage,
  type AutomatedTemplateRow,
} from "@/lib/messaging/automated-send";
import { logAgentTool } from "@/lib/ai/audit";

const inputSchema = z
  .object({
    invoices: z
      .array(
        z
          .object({ appointment_id: z.string().uuid() })
          .passthrough(),
      )
      .min(1)
      .max(25),
  })
  .strict();

export function sendInvoiceRemindersWorkflowTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Preview, then after explicit confirmation send the clinic's approved overdue-invoice reminder for balances returned by list_outstanding_invoices. Uses the existing per-channel idempotent messaging core.",
    inputSchema,
    execute: async ({ invoices }, options) => {
      await assertWorkflowActionAccess(ctx.user, "revenue", ["admin", "manager"]);
      await assertFinancialInsightsAccess(ctx.user);
      const invocation = workflowInvocationIdentity(options);
      const ids = [...new Set(invoices.map((row) => row.appointment_id))];
      const supabase = await createClient();
      const authorized = await supabase
        .from("appointments")
        .select(
          "id, scheduled_at, outstanding_amount, patient_id, patients(full_name, phone, email)",
        )
        .eq("clinic_id", ctx.user.clinicId)
        .eq("status", "completed")
        .is("deleted_at", null)
        .gt("outstanding_amount", 0)
        .in("id", ids);
      if (
        authorized.error ||
        !authorized.data ||
        authorized.data.length !== ids.length
      ) {
        return {
          needs_clarification: true as const,
          field: "invoices",
          guidance:
            "One or more balances are no longer outstanding or visible. Ask the user to preview the workflow again.",
          candidates: [],
        };
      }

      const settings = await getClinicReminderSettings(ctx.user.clinicId);
      if (settings.error || !settings.data) {
        throw new Error("Invoice reminder settings unavailable.");
      }
      const client = createClinicScopedAdminClient(ctx.user.clinicId);
      const [templates, whatsappActive] = await Promise.all([
        client
          .from("message_templates")
          .select("id, name, language, variables, approval_status, channel")
          .eq("channel", "whatsapp")
          .eq("approval_status", "approved")
          .eq("name", FOLLOWUP_TEMPLATE_NAME),
        hasActiveWhatsAppChannel(ctx.user.clinicId),
      ]);
      if (templates.error) throw new Error("Invoice reminder templates unavailable.");

      const byId = new Map(
        authorized.data.map((invoice) => [invoice.id, invoice]),
      );
      const drafts = ids.map((id) => byId.get(id)!).map((invoice) => {
        const locale = patientCopyLocale(settings.data!.locale);
        const patientName = invoice.patients?.full_name ?? "";
        const copy = followupCopy({
          locale,
          patientName,
          clinicName: settings.data!.name,
          step: 0,
        });
        const channels: Array<"email" | "whatsapp"> = [];
        if (invoice.patients?.email) channels.push("email");
        if (whatsappActive && invoice.patients?.phone) channels.push("whatsapp");
        return {
          appointmentId: invoice.id,
          patientName,
          outstandingAmount: Number(invoice.outstanding_amount ?? 0),
          channels,
          recipient: {
            phone: invoice.patients?.phone ?? null,
            email: invoice.patients?.email ?? null,
          },
          locale,
          subject:
            settings.data!.invoice_followup_email_subject?.trim() || copy.subject,
          body: settings.data!.invoice_followup_email_body?.trim() || copy.body,
        };
      });
      const items = drafts.map((draft) => ({
        appointment_id: draft.appointmentId,
        patient_name: draft.patientName,
        outstanding_amount: draft.outstandingAmount,
        channels: draft.channels,
      }));
      if (invocation.mode === "preview") {
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "send_invoice_reminders",
          tableName: "appointments",
          params: { outcome: "previewed", count: items.length },
        });
        return {
          action: "send_invoice_reminders" as const,
          draft_status: "awaiting_confirmation" as const,
          count: items.length,
          items,
        };
      }

      const outcomes = [];
      let anyFailed = false;
      let anyCompleted = false;
      for (const draft of drafts) {
        const result = await dispatchPatientMessage({
          clinicId: ctx.user.clinicId,
          dedupeKey: `invoice_followup:${draft.appointmentId}:step0`,
          recipient: draft.recipient,
          locale: draft.locale,
          whatsappActive,
          whatsappTemplates: (templates.data ?? []) as AutomatedTemplateRow[],
          templateValues: {
            patient_name: draft.patientName,
            clinic_name: settings.data.name,
            doctor_name: settings.data.name,
          },
          subject: draft.subject,
          body: draft.body,
          relatedType: "invoice",
          relatedId: draft.appointmentId,
        });
        anyFailed ||= anyChannelFailed(result);
        anyCompleted ||=
          anyChannelSent(result) ||
          result.email?.status === "duplicate" ||
          result.whatsapp?.status === "duplicate";
        outcomes.push({
          appointment_id: draft.appointmentId,
          email: result.email?.status ?? "not_attempted",
          whatsapp: result.whatsapp?.status ?? "not_attempted",
        });
      }
      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "send_invoice_reminders",
        tableName: "message_dispatches",
        params: {
          outcome: anyFailed ? "partially_failed" : "confirmed",
          count: outcomes.length,
        },
      });
      return {
        action: "send_invoice_reminders" as const,
        draft_status: "sent_or_idempotent" as const,
        count: outcomes.length,
        items,
        outcomes,
        workflow_action_failed: anyFailed,
        workflow_action_partial_failure: anyFailed && anyCompleted,
      };
    },
  });
}
