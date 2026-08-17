import "server-only";
import { sendMessage } from "@/lib/messaging/send";
import {
  claimMessageDispatch,
  finalizeMessageDispatch,
  releaseMessageDispatch,
} from "@/lib/supabase/admin";
import {
  templateParameterValues,
  type PatientCopyLocale,
  type TemplateVariable,
} from "@/lib/messaging/patient-copy";
import type {
  MessagingProviderId,
  MessageAttachment,
  MessageChannel,
  OutboundRelatedType,
  SendErrorCode,
} from "@/lib/messaging/types";
import type { Database } from "@/types/database";

/**
 * Independent-channel, idempotent patient dispatch (2026-07-19 flow revision).
 *
 * Email and WhatsApp are treated as **independent** channels — one never blocks
 * the other:
 *   - Email is always attempted when the patient has an email address.
 *   - WhatsApp is attempted only when the clinic has an active WhatsApp
 *     integration, the patient has a phone, and an approved template exists.
 *
 * Every channel send is guarded by a per-channel claim on `dedupe_key` in
 * `message_dispatches`, so a duplicate is never sent, and if one channel
 * succeeds while the other fails, only the failed channel is retried (its claim
 * is released; the succeeded channel stays terminal). `sendMessage` still owns
 * entitlements, usage caps, window rules, and `outbound_messages` recording.
 */

export type AutomatedTemplateRow = Pick<
  Database["public"]["Tables"]["message_templates"]["Row"],
  "id" | "name" | "language" | "variables" | "approval_status" | "channel"
>;

export type ChannelDispatchOutcome =
  | { status: "sent"; outboundMessageId?: string }
  /** Claim denied — already sent or a concurrent run is mid-send. */
  | { status: "duplicate" }
  /** Provider outcome unclear; the claim is kept so a later run may retry. */
  | { status: "ambiguous" }
  | { status: "failed"; code: SendErrorCode }
  | {
      status: "not_attempted";
      reason: "no_address" | "no_whatsapp_channel" | "no_template";
    };

export type DispatchResult = {
  email: ChannelDispatchOutcome | null;
  whatsapp: ChannelDispatchOutcome | null;
};

export type DispatchInput = {
  clinicId: string;
  /** Logical message identity for per-channel idempotency (e.g. 'invoice:<id>'). */
  dedupeKey: string;
  recipient: { phone: string | null; email: string | null };
  locale: PatientCopyLocale;
  /** Candidate WhatsApp templates for this clinic matching the send's template name. */
  whatsappTemplates: readonly AutomatedTemplateRow[];
  templateValues: Partial<Record<TemplateVariable, string>>;
  /** Freeform copy for the email channel. */
  subject: string;
  body: string;
  relatedType: Extract<OutboundRelatedType, "appointment" | "invoice">;
  relatedId: string;
  /** Whether the clinic has an active WhatsApp integration. */
  whatsappActive: boolean;
  /**
   * Which transport carries it, which decides whether a template needs Meta's
   * approval to be usable. Omitted means "a Cloud API transport" — the strict
   * reading, so an unset value can never loosen the gate.
   */
  whatsappProvider?: MessagingProviderId | null;
  /** Email-only attachments (e.g. the canonical invoice PDF). */
  emailAttachments?: readonly MessageAttachment[];
};

function templateVariableNames(
  value: AutomatedTemplateRow["variables"],
): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

/**
 * The stored approval states worth loading for an automated send. The provider
 * decides which of them are actually usable, so the query fetches the
 * candidates and pickAutomatedTemplate makes the call.
 */
export const AUTOMATED_TEMPLATE_APPROVAL_STATES = [
  "approved",
  "submitted",
  "draft",
] as const;

/**
 * Prefer the clinic-locale variant, fall back to any usable language.
 *
 * On a Cloud API transport only a Meta-approved template may be sent, and that
 * gate is enforced again inside sendMessage. A linked device is the clinic's own
 * WhatsApp account: there is no template catalogue, no reviewer and nothing to
 * approve, so the clinic's own saved body is what goes out — anything but an
 * explicitly rejected template is usable there.
 */
export function pickAutomatedTemplate(
  templates: readonly AutomatedTemplateRow[],
  locale: PatientCopyLocale,
  provider?: MessagingProviderId | null,
): AutomatedTemplateRow | null {
  const usable = templates.filter(
    (template) =>
      template.channel === "whatsapp" &&
      (provider === "linked_device"
        ? template.approval_status !== "rejected"
        : template.approval_status === "approved"),
  );
  return (
    usable.find((template) => template.language === locale) ?? usable[0] ?? null
  );
}

/** True when any channel produced a new send (used by callers for retry/alerts). */
export function anyChannelSent(result: DispatchResult): boolean {
  return result.email?.status === "sent" || result.whatsapp?.status === "sent";
}

/** True when a channel that was actually attempted ended in a definite failure. */
export function anyChannelFailed(result: DispatchResult): boolean {
  return result.email?.status === "failed" || result.whatsapp?.status === "failed";
}

async function dispatchOnChannel(
  channel: Extract<MessageChannel, "whatsapp" | "email">,
  clinicId: string,
  dedupeKey: string,
  attempt: Parameters<typeof sendMessage>[0],
): Promise<ChannelDispatchOutcome> {
  const claim = await claimMessageDispatch({
    clinicId,
    dedupeKey,
    channel,
    claimedAt: new Date().toISOString(),
  });
  // Claim denied → already sent (idempotent) or a concurrent run holds it.
  if (claim.error || claim.data !== true) return { status: "duplicate" };

  const result = await sendMessage(attempt);
  if (result.ok) {
    await finalizeMessageDispatch({
      clinicId,
      dedupeKey,
      channel,
      sentAt: new Date().toISOString(),
      outboundMessageId: result.outboundMessageId ?? null,
    });
    return { status: "sent", outboundMessageId: result.outboundMessageId };
  }
  if (result.code === "PROVIDER_SEND_AMBIGUOUS") {
    // Keep the claim: the message may have gone out. A later run reclaims after
    // the lease if it was actually lost.
    return { status: "ambiguous" };
  }
  // Definite failure: release so only this channel retries next time.
  await releaseMessageDispatch({ clinicId, dedupeKey, channel });
  return { status: "failed", code: result.code };
}

export async function dispatchPatientMessage(
  input: DispatchInput,
): Promise<DispatchResult> {
  const result: DispatchResult = { email: null, whatsapp: null };

  // EMAIL — always attempted when an address exists, independent of WhatsApp.
  if (input.recipient.email) {
    result.email = await dispatchOnChannel("email", input.clinicId, input.dedupeKey, {
      clinicId: input.clinicId,
      recipient: input.recipient.email,
      body: input.body,
      subject: input.subject,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      channelPreference: ["email"],
      attachments: input.emailAttachments,
    });
  } else {
    result.email = { status: "not_attempted", reason: "no_address" };
  }

  // WHATSAPP — only when the clinic has an active integration, independent of
  // the email outcome.
  if (!input.whatsappActive) {
    result.whatsapp = { status: "not_attempted", reason: "no_whatsapp_channel" };
  } else if (!input.recipient.phone) {
    result.whatsapp = { status: "not_attempted", reason: "no_address" };
  } else {
    const template = pickAutomatedTemplate(
      input.whatsappTemplates,
      input.locale,
      input.whatsappProvider,
    );
    const parameters = template
      ? templateParameterValues(
          templateVariableNames(template.variables),
          input.templateValues,
        )
      : null;
    if (!template || !parameters) {
      result.whatsapp = { status: "not_attempted", reason: "no_template" };
    } else {
      result.whatsapp = await dispatchOnChannel(
        "whatsapp",
        input.clinicId,
        input.dedupeKey,
        {
          clinicId: input.clinicId,
          recipient: input.recipient.phone,
          body: "",
          templateId: template.id,
          templateParameters: parameters,
          relatedType: input.relatedType,
          relatedId: input.relatedId,
          channelPreference: ["whatsapp"],
        },
      );
    }
  }

  return result;
}
