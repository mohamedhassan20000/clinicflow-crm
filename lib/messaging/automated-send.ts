import "server-only";
import { sendMessage } from "@/lib/messaging/send";
import {
  templateParameterValues,
  type PatientCopyLocale,
  type TemplateVariable,
} from "@/lib/messaging/patient-copy";
import type {
  MessageChannel,
  OutboundRelatedType,
  SendErrorCode,
} from "@/lib/messaging/types";
import type { Database } from "@/types/database";

/**
 * Shared channel-fallback dispatch for the P3D automated senders (§7.2/§7.3).
 *
 * `sendMessage` owns entitlements, caps, window rules and recording; this
 * helper only handles what it cannot: the recipient address differs per
 * channel (phone vs email) and WhatsApp business-initiated sends need an
 * approved template — so each channel is attempted explicitly, in the §5.2
 * preference order, until one send succeeds.
 */

export type AutomatedTemplateRow = Pick<
  Database["public"]["Tables"]["message_templates"]["Row"],
  "id" | "name" | "language" | "variables" | "approval_status" | "channel"
>;

export type AutomatedRecipient = {
  phone: string | null;
  email: string | null;
};

export type AutomatedSendInput = {
  clinicId: string;
  recipient: AutomatedRecipient;
  locale: PatientCopyLocale;
  /** Approved WhatsApp templates for this clinic matching the send's template name. */
  whatsappTemplates: readonly AutomatedTemplateRow[];
  templateValues: Record<TemplateVariable, string>;
  /** Freeform copy used for email fallback. */
  subject: string;
  body: string;
  relatedType: Extract<OutboundRelatedType, "appointment" | "invoice">;
  relatedId: string;
};

export type AutomatedSendResult =
  | { ok: true; channel: MessageChannel }
  | { ok: false; code: SendErrorCode | "NO_USABLE_CHANNEL" };

function templateVariableNames(
  value: AutomatedTemplateRow["variables"],
): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

/** Prefer the clinic-locale variant, fall back to any approved language. */
export function pickAutomatedTemplate(
  templates: readonly AutomatedTemplateRow[],
  locale: PatientCopyLocale,
): AutomatedTemplateRow | null {
  const approved = templates.filter(
    (template) =>
      template.channel === "whatsapp" && template.approval_status === "approved",
  );
  return (
    approved.find((template) => template.language === locale) ??
    approved[0] ??
    null
  );
}

export async function sendAutomatedPatientMessage(
  input: AutomatedSendInput,
): Promise<AutomatedSendResult> {
  let lastCode: SendErrorCode | null = null;

  for (const channel of ["whatsapp", "email"] as const) {
    let attempt: Parameters<typeof sendMessage>[0] | null = null;

    if (channel === "whatsapp") {
      if (!input.recipient.phone) continue;
      const template = pickAutomatedTemplate(input.whatsappTemplates, input.locale);
      if (!template) continue;
      const parameters = templateParameterValues(
        templateVariableNames(template.variables),
        input.templateValues,
      );
      if (!parameters) continue;
      attempt = {
        clinicId: input.clinicId,
        recipient: input.recipient.phone,
        body: "",
        templateId: template.id,
        templateParameters: parameters,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        channelPreference: ["whatsapp"],
      };
    } else {
      if (!input.recipient.email) continue;
      attempt = {
        clinicId: input.clinicId,
        recipient: input.recipient.email,
        body: input.body,
        subject: input.subject,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        channelPreference: ["email"],
      };
    }

    const result = await sendMessage(attempt);
    if (result.ok) return { ok: true, channel };
    if (result.code === "PROVIDER_SEND_AMBIGUOUS") {
      // The provider may have accepted the message; falling back to the next
      // channel could deliver a duplicate (P3-M1). Stop and let the caller
      // retry the same channel on a later run.
      return { ok: false, code: result.code };
    }
    lastCode = result.code;
  }

  return { ok: false, code: lastCode ?? "NO_USABLE_CHANNEL" };
}
