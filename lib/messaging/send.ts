import "server-only";
import * as Sentry from "@sentry/nextjs";
import { DEFAULT_FROM } from "@/lib/email/resend";
import {
  checkUsageLimit,
  getEntitlements,
  hasFeature,
  type Entitlements,
  type UsageMetric,
} from "@/lib/entitlements";
import {
  createClinicScopedAdminClient,
  finalizeOutboundMessage,
  incrementClinicUsage,
} from "@/lib/supabase/admin";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import { outboundMediaPlaceholderBody } from "@/lib/messaging/media-placeholder";
import { resendEmailProvider } from "@/lib/messaging/email-resend";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import {
  getWhatsAppProviderCapabilities,
  isTemplateUsableForWhatsAppProvider,
  resolveActiveChannels,
} from "@/lib/messaging/provider-policy";
import { dialog360WhatsAppProvider } from "@/lib/messaging/whatsapp-dialog360";
import { linkedDeviceWhatsAppProvider } from "@/lib/messaging/whatsapp-linked-device";
import { metaWhatsAppProvider } from "@/lib/messaging/whatsapp-meta";
import type {
  ChannelCredentials,
  MessageChannel,
  MessagingProviderId,
  OutboundMessageInput,
  SendErrorCode,
  SendResult,
} from "@/lib/messaging/types";
import type { Database } from "@/types/database";

/**
 * The single entry point every outbound message goes through (§5.2, §7.6):
 * resolves the clinic's active channel by preference order, checks
 * entitlements and usage counters, records the outbound_messages row, and
 * dispatches through the channel adapter. One send = one row = one usage tick.
 */

// The send path only reads the transport columns; the P6C operational-state
// columns are not selected here, so pick exactly the columns the queries return.
type ClinicChannelRow = Pick<
  Database["public"]["Tables"]["clinic_channels"]["Row"],
  | "id"
  | "clinic_id"
  | "channel"
  | "provider"
  | "credentials_encrypted"
  | "sender_identity"
  | "status"
  | "connected_at"
  | "created_at"
  | "updated_at"
>;
type MessageTemplateRow = Database["public"]["Tables"]["message_templates"]["Row"];

const DEFAULT_CHANNEL_ORDER: readonly MessageChannel[] = [
  "whatsapp",
  "email",
];

const CHANNEL_METRIC: Record<MessageChannel, UsageMetric> = {
  whatsapp: "wa_messages",
  email: "emails",
};

/**
 * Email has no plan feature flag: it is the baseline channel every
 * subscribed clinic can use from day one (§5.1 Model C).
 */
const CHANNEL_FEATURE: Partial<Record<MessageChannel, string>> = {
  whatsapp: "whatsapp",
};

/**
 * Meta-direct registered here in P6C, the linked-device pairing in P7E; domain
 * callers remain provider-neutral and never choose a transport themselves.
 */
const ADAPTERS: Partial<Record<MessagingProviderId, MessagingProvider>> = {
  dialog360: dialog360WhatsAppProvider,
  meta: metaWhatsAppProvider,
  linked_device: linkedDeviceWhatsAppProvider,
  resend: resendEmailProvider,
};

const PREVIEW_MAX_LENGTH = 120;

/**
 * Truncated, redacted preview for outbound_messages.body_preview (§9.3):
 * digit runs (phone numbers, file numbers, national IDs) are masked and the
 * text is cut well under the column's 160-char bound.
 */
export function buildBodyPreview(body: string): string {
  const redacted = body.replace(/\d{4,}/g, "••••");
  return redacted.length > PREVIEW_MAX_LENGTH
    ? `${redacted.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : redacted;
}

function normalizePreference(
  preference: readonly MessageChannel[] | undefined,
): readonly MessageChannel[] {
  if (!preference || preference.length === 0) return DEFAULT_CHANNEL_ORDER;
  return [...new Set(preference)];
}

function channelAllowed(
  entitlements: Entitlements,
  channel: MessageChannel,
): boolean {
  const feature = CHANNEL_FEATURE[channel];
  if (feature) return hasFeature(entitlements, feature);
  return entitlements.subscriptionAllowed;
}

function failure(code: SendErrorCode, outboundMessageId?: string): SendResult {
  return outboundMessageId ? { ok: false, code, outboundMessageId } : { ok: false, code };
}

async function provisionEmailChannel(
  client: ReturnType<typeof createClinicScopedAdminClient>,
  clinicId: string,
): Promise<ClinicChannelRow | null> {
  const result = await client
    .from("clinic_channels")
    .upsert(
      {
        clinic_id: clinicId,
        channel: "email",
        provider: "resend",
        credentials_encrypted: null,
        sender_identity: DEFAULT_FROM,
        status: "active",
        connected_at: new Date().toISOString(),
      },
      { onConflict: "clinic_id,channel,provider" },
    )
    .select(
      "id, clinic_id, channel, provider, credentials_encrypted, sender_identity, status, connected_at, created_at, updated_at",
    )
    .single();
  return result.error ? null : result.data;
}

async function persistFinalState(input: Parameters<typeof finalizeOutboundMessage>[0]) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await finalizeOutboundMessage(input);
    if (!result.error && result.data === true) return true;
  }
  return false;
}

function templateVariableNames(value: Database["public"]["Tables"]["message_templates"]["Row"]["variables"]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function renderTemplateBody(
  template: MessageTemplateRow,
  parameters: readonly string[],
): string | null {
  const names = templateVariableNames(template.variables);
  if (
    names.length !== parameters.length ||
    parameters.some((parameter) => !parameter.trim() || parameter.length > 1000)
  ) {
    return null;
  }
  let body = template.body;
  parameters.forEach((parameter, index) => {
    const value = parameter.trim();
    body = body.replaceAll(`{{${index + 1}}}`, value);
    body = body.replaceAll(`{{${names[index]}}}`, value);
  });
  return body;
}

export async function sendMessage(
  input: OutboundMessageInput,
): Promise<SendResult> {
  if (
    !input.clinicId?.trim() ||
    !input.recipient?.trim() ||
    (!input.body?.trim() && !input.templateId && !input.media)
  ) {
    return failure("INVALID_INPUT");
  }

  const entitlements = await getEntitlements(input.clinicId);
  if (!entitlements.subscriptionAllowed) return failure("SUBSCRIPTION_INACTIVE");

  const client = createClinicScopedAdminClient(input.clinicId);
  const channelsResult = await client
    .from("clinic_channels")
    .select(
      "id, clinic_id, channel, provider, credentials_encrypted, sender_identity, status, connected_at, created_at, updated_at",
    )
    .eq("status", "active");
  if (channelsResult.error) return failure("CHANNEL_LOOKUP_FAILED");

  const activeChannels = resolveActiveChannels(channelsResult.data ?? []);
  const preference = normalizePreference(input.channelPreference);
  if (preference.includes("email") && !activeChannels.has("email")) {
    const emailChannel = await provisionEmailChannel(client, input.clinicId);
    if (!emailChannel) return failure("CHANNEL_LOOKUP_FAILED");
    activeChannels.set("email", emailChannel);
  }
  if (activeChannels.size === 0) return failure("NO_ACTIVE_CHANNEL");

  // Walk the preference order; channels the clinic is not entitled to or that
  // are over their usage cap are skipped so a WhatsApp cap degrades to email
  // instead of silencing the clinic. The first blocking reason is kept
  // for the error when nothing remains.
  let firstBlock: SendErrorCode | null = null;
  let selected: ClinicChannelRow | null = null;
  for (const channel of preference) {
    const row = activeChannels.get(channel);
    if (!row) continue;
    if (!ADAPTERS[row.provider]) continue;
    if (!channelAllowed(entitlements, channel)) {
      firstBlock ??= "NOT_ENTITLED";
      continue;
    }
    const usage = await checkUsageLimit(input.clinicId, CHANNEL_METRIC[channel]);
    if (!usage.allowed) {
      firstBlock ??=
        usage.reason === "subscription_inactive"
          ? "SUBSCRIPTION_INACTIVE"
          : "USAGE_LIMIT_REACHED";
      continue;
    }
    selected = row;
    break;
  }
  if (!selected) return failure(firstBlock ?? "NO_ACTIVE_CHANNEL");

  const whatsappCapabilities = selected.channel === "whatsapp"
    ? getWhatsAppProviderCapabilities(selected.provider)
    : null;

  // Storage-reference media is intentionally a linked-device-only capability.
  // Cloud API providers must reject it explicitly rather than silently sending
  // only the caption and making staff believe the file was delivered.
  if (input.media && !whatsappCapabilities?.mediaSupported) {
    return failure("MEDIA_UNSUPPORTED");
  }

  if (selected.channel === "email" && !input.subject?.trim()) {
    return failure("EMAIL_SUBJECT_REQUIRED");
  }

  let conversation: {
    id: string;
    channel: MessageChannel;
    status: Database["public"]["Enums"]["conversation_status"];
    window_expires_at: string | null;
    whatsapp_account_id: string | null;
  } | null = null;
  if (input.conversationId) {
    const conversationResult = await client
      .from("conversations")
      .select("id, channel, status, window_expires_at, whatsapp_account_id")
      .eq("id", input.conversationId)
      .maybeSingle();
    if (conversationResult.error || !conversationResult.data) {
      return failure("CONVERSATION_NOT_FOUND");
    }
    conversation = conversationResult.data;
    if (conversation.status !== "open") return failure("CONVERSATION_CLOSED");
    if (conversation.channel !== selected.channel) {
      return failure("CONVERSATION_NOT_FOUND");
    }
    if (selected.channel === "whatsapp") {
      if (selected.provider === "linked_device") {
        const session = await client.from("whatsapp_linked_device_sessions")
          .select("authenticated_account_id").eq("clinic_id", input.clinicId).maybeSingle();
        if (
          session.error ||
          !selected.sender_identity ||
          session.data?.authenticated_account_id !== selected.sender_identity ||
          conversation.whatsapp_account_id !== selected.sender_identity
        ) return failure("CONVERSATION_NOT_FOUND");
      } else if (conversation.whatsapp_account_id !== null) {
        return failure("CONVERSATION_NOT_FOUND");
      }
    }
  } else if (selected.channel === "whatsapp" && input.relatedType === "manual") {
    return failure("CONVERSATION_NOT_FOUND");
  }

  let body = input.body.trim();
  let template: MessageTemplateRow | null = null;
  if (input.templateId) {
    const templateResult = await client
      .from("message_templates")
      .select(
        "id, clinic_id, channel, name, language, body, variables, provider_template_id, approval_status, created_at, updated_at",
      )
      .eq("id", input.templateId)
      .maybeSingle();
    // Provider approval is a Cloud API concept: Meta reviews a template before
    // a WABA may send it. A linked device sends from the clinic's own WhatsApp
    // account, where the template is just the clinic's own text and no reviewer
    // exists — so only an explicitly rejected template is refused there.
    const approvalOk = templateResult.data
      ? isTemplateUsableForWhatsAppProvider(
          selected.provider,
          templateResult.data.approval_status,
        )
      : false;
    if (
      templateResult.error ||
      !templateResult.data ||
      templateResult.data.channel !== selected.channel ||
      !approvalOk
    ) {
      return failure("TEMPLATE_NOT_APPROVED");
    }
    template = templateResult.data;
    if (selected.channel === "whatsapp" && selected.provider === "meta") {
      const binding = await client
        .from("message_template_provider_bindings")
        .select("id")
        .eq("template_id", template.id)
        .eq("provider", "meta")
        .eq("approval_status", "approved")
        .maybeSingle();
      if (binding.error || !binding.data) return failure("TEMPLATE_NOT_APPROVED");
    }
    const rendered = renderTemplateBody(template, input.templateParameters ?? []);
    if (!rendered) return failure("TEMPLATE_PARAMETERS_INVALID");
    body = rendered;
  }

  // The 24-hour service window is a Cloud API business rule enforced by Meta on
  // WABA traffic. A linked device sends from the clinic's own WhatsApp account,
  // where no such window exists and no template mechanism exists to reopen one,
  // so applying the gate there would block sends WhatsApp itself allows.
  if (
    conversation?.channel === "whatsapp" &&
    whatsappCapabilities?.serviceWindowRequired &&
    (!conversation.window_expires_at ||
      new Date(conversation.window_expires_at).valueOf() <= Date.now()) &&
    !template
  ) {
    return failure("SERVICE_WINDOW_CLOSED");
  }

  // Decrypt credentials before writing the queued row so a broken envelope
  // fails fast without a dangling record. Email carries none by design.
  let credentials: ChannelCredentials = {};
  if (selected.credentials_encrypted) {
    try {
      credentials = decryptChannelCredentials(selected.credentials_encrypted);
    } catch (error) {
      Sentry.captureException(error, {
        tags: { scope: "messaging", clinic_channel: selected.channel },
      });
      return failure("CREDENTIALS_UNAVAILABLE");
    }
  }

  // P16 — what the *record* says when the message is a file with no caption.
  //
  // `body` above is what WhatsApp receives and stays exactly as the sender
  // wrote it (empty, for a bare file). The stored text is allowed to differ:
  // an empty row rendered as "No message preview" in the conversation list and
  // in the thread, for the two most ordinary things staff send. The marker is
  // the same closed vocabulary the worker writes for inbound media, so one
  // rule — `lib/messaging/media-placeholder.ts` — localizes both directions and
  // keeps the marker out of the bubble, where the attachment itself is shown.
  const storedBody = body.trim().length > 0 || !input.media
    ? body
    : outboundMediaPlaceholderBody({
        kind: input.media.kind,
        voiceNote: input.media.voiceNote,
      });

  const insertResult = await client
    .from("outbound_messages")
    .insert({
      clinic_id: input.clinicId,
      channel: selected.channel,
      provider: selected.provider,
      recipient: input.recipient.trim(),
      template_id: template?.id ?? null,
      body_preview: buildBodyPreview(storedBody),
      // P8: inbox threads keep the full text alongside the redacted preview.
      // The Inbox used to render `body_preview`, so a long reply — an AI answer
      // in particular — arrived complete on the patient's phone and appeared
      // cut off at 120 characters to the staff member reading the same thread.
      // Everything that is not a conversation (reminders, invoice follow-ups,
      // every analytics path) still carries the preview alone: the database
      // check constraint on this column enforces that, not this call site.
      ...(input.relatedType === "manual" ? { body: storedBody.slice(0, 8192) } : {}),
      related_type: input.relatedType,
      related_id: input.conversationId ?? input.relatedId ?? null,
      // P11T — attribution, written atomically with the row. Nothing reads it
      // back to decide what the assistant may see; it is what lets a clinic ask
      // which episode a message belonged to.
      ...(input.episodeId ? { episode_id: input.episodeId } : {}),
      status: "queued",
    })
    .select("id")
    .single();
  if (insertResult.error || !insertResult.data) return failure("RECORD_FAILED");
  const outboundMessageId = insertResult.data.id;

  const adapter = ADAPTERS[selected.provider];
  if (!adapter) return failure("NO_ACTIVE_CHANNEL", outboundMessageId);

  let sendResult;
  try {
    sendResult = await adapter.send(
      {
        channel: selected.channel,
        recipient: input.recipient.trim(),
        body,
        subject: input.subject,
        senderIdentity: selected.sender_identity,
        clientReference: outboundMessageId,
        template: template
          ? {
              name: template.name,
              language: template.language,
              parameters: input.templateParameters ?? [],
            }
          : undefined,
        // Base64 attachments remain email-only. WhatsApp media is the separate
        // private storage reference below.
        attachments: selected.channel === "email" ? input.attachments : undefined,
        media: input.media
          ? {
              kind: input.media.kind,
              mimeType: input.media.mimeType,
              bucket: input.media.bucket,
              storagePath: input.media.storagePath,
              fileName: input.media.fileName,
              voiceNote: input.media.voiceNote,
            }
          : undefined,
      },
      credentials,
    );
  } catch (error) {
    sendResult = { ok: false as const, error: sanitizeProviderError(error) };
  }

  if (!sendResult.ok && sendResult.ambiguous) {
    // The provider may have accepted the message (timeout/network loss after
    // dispatch). Do not finalize as failed: the row stays queued so the
    // delivery callback can repair it via the client reference, and callers
    // must not fall back to another channel (P3-M1). The attempt error is
    // recorded for operators without touching the lifecycle status.
    const noted = await client
      .from("outbound_messages")
      .update({ error: sendResult.error })
      .eq("id", outboundMessageId)
      .eq("status", "queued");
    if (noted.error) {
      Sentry.captureMessage("outbound_messages ambiguous outcome could not be recorded", {
        level: "warning",
        tags: { scope: "messaging" },
        extra: { outboundMessageId },
      });
    }
    return failure(sendResult.failureCode ?? "PROVIDER_SEND_AMBIGUOUS", outboundMessageId);
  }

  if (!sendResult.ok) {
    const finalized = await persistFinalState({
      clinicId: input.clinicId,
      outboundMessageId,
      status: "failed",
      providerMessageId: null,
      error: sendResult.error,
      costMicro: null,
      occurredAt: new Date().toISOString(),
    });
    if (!finalized) {
      Sentry.captureMessage("outbound_messages provider failure could not be persisted", {
        level: "error",
        tags: { scope: "messaging" },
        extra: { outboundMessageId },
      });
      return failure("RECORD_FAILED", outboundMessageId);
    }
    return failure(sendResult.failureCode ?? "PROVIDER_SEND_FAILED", outboundMessageId);
  }

  const finalized = await persistFinalState({
    clinicId: input.clinicId,
    outboundMessageId,
    status: "sent",
    providerMessageId: sendResult.providerMessageId,
    error: null,
    costMicro: sendResult.costMicro,
    occurredAt: new Date().toISOString(),
  });
  if (!finalized) {
    Sentry.captureMessage("outbound_messages acceptance could not be persisted after send", {
      level: "error",
      tags: { scope: "messaging" },
      extra: { outboundMessageId },
    });
    return failure("RECORD_FAILED", outboundMessageId);
  }

  // The message left the building: count it. A failed counter write must not
  // retro-fail the send — it is surfaced to Sentry instead.
  const usageResult = await incrementClinicUsage(
    input.clinicId,
    CHANNEL_METRIC[selected.channel],
  );
  if (usageResult.error) {
    Sentry.captureMessage("increment_usage failed after messaging send", {
      level: "error",
      tags: { scope: "messaging" },
      extra: { outboundMessageId, metric: CHANNEL_METRIC[selected.channel] },
    });
  }
  return {
    ok: true,
    outboundMessageId,
    channel: selected.channel,
    provider: selected.provider,
    providerMessageId: sendResult.providerMessageId,
  };
}
