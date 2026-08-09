import type { Database } from "@/types/database";

export type MessageChannel = Database["public"]["Enums"]["message_channel"];
export type MessagingProviderId =
  Database["public"]["Enums"]["messaging_provider"];
export type OutboundMessageStatus =
  Database["public"]["Enums"]["outbound_message_status"];
export type OutboundRelatedType =
  Database["public"]["Enums"]["outbound_related_type"];

/**
 * Decrypted per-clinic provider credentials. Flat string map by design so the
 * encryption envelope, the Sentry scrubber, and adapters share one shape.
 * Never log, serialize into errors, or return these to a client.
 */
export type ChannelCredentials = Readonly<Record<string, string>>;

/**
 * A caller-supplied binary attachment. Only the email channel carries these;
 * WhatsApp template sends ignore them. `content` is base64-encoded so the value
 * is a plain serializable string across the send boundary.
 */
export type MessageAttachment = {
  filename: string;
  /** Base64-encoded file bytes. */
  content: string;
  contentType?: string;
};

/** What a caller asks the messaging layer to deliver. */
export type OutboundMessageInput = {
  clinicId: string;
  recipient: string;
  body: string;
  /** Required when the resolved channel is email. */
  subject?: string;
  relatedType: OutboundRelatedType;
  relatedId?: string | null;
  /** Required for manual WhatsApp replies; used for service-window enforcement. */
  conversationId?: string | null;
  templateId?: string | null;
  /** Ordered WhatsApp template body values ({{1}}, {{2}}, ...). */
  templateParameters?: readonly string[];
  /** Preference order; defaults to whatsapp → email (§5.2). */
  channelPreference?: readonly MessageChannel[];
  /** Email-only binary attachments (e.g. the canonical invoice PDF). */
  attachments?: readonly MessageAttachment[];
};

/** What an adapter receives — channel-level, provider-agnostic. */
export type ProviderMessage = {
  channel: MessageChannel;
  recipient: string;
  body: string;
  subject?: string;
  /** The clinic's sender identity: phone number or from-address. */
  senderIdentity: string;
  /** Durable caller-generated correlation id echoed by supporting providers. */
  clientReference?: string;
  /** Provider-neutral WhatsApp template dispatch details. */
  template?: {
    name: string;
    language: string;
    parameters: readonly string[];
  };
  /** Email-only binary attachments (e.g. the canonical invoice PDF). */
  attachments?: readonly MessageAttachment[];
};

export type ProviderSendResult =
  | { ok: true; providerMessageId: string | null; costMicro: number | null }
  | {
      ok: false;
      error: string;
      /**
       * True when the provider may have accepted the message anyway (timeout,
       * network interruption, unparseable 2xx). Callers must not fall back to
       * another channel on an ambiguous outcome — the delivery callback can
       * still repair the record via the client reference.
       */
      ambiguous?: boolean;
    };

export type TemplateApprovalStatus =
  Database["public"]["Enums"]["template_approval_status"];

export type ProviderTemplateInput = {
  name: string;
  language: string;
  body: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
};

export type ProviderTemplateResult =
  | {
      ok: true;
      providerTemplateId: string;
      status: TemplateApprovalStatus;
    }
  | { ok: false; error: string };

/** Normalized provider webhook event (routes consume these in P3B). */
export type WebhookEvent =
  | {
      kind: "inbound";
      phoneNumberId: string;
      sender: string;
      providerMessageId: string;
      body: string;
      receivedAt: string | null;
    }
  | {
      kind: "status";
      providerMessageId: string;
      clientReference?: string | null;
      status: Extract<OutboundMessageStatus, "sent" | "delivered" | "read" | "failed">;
      error: string | null;
      occurredAt: string | null;
    }
  | {
      kind: "template_status";
      providerTemplateId: string;
      name: string | null;
      language: string | null;
      status: TemplateApprovalStatus;
    }
  | {
      /**
       * P6C: a Meta-direct account/phone/review state change. Carries only
       * provider status strings (no message content); the connection-state
       * machine derives the channel state and a sanitized failure reason from
       * these. `failureReason` is raw provider text and is never persisted or
       * shown without sanitization.
       */
      kind: "channel_state";
      phoneNumberId: string | null;
      wabaId: string | null;
      observedAt?: string | null;
      signals: {
        businessVerificationStatus?: string | null;
        phoneStatus?: string | null;
        accountReviewStatus?: string | null;
        qualityRating?: string | null;
        messagingLimitTier?: string | null;
        webhookSubscribed?: boolean | null;
        failureReason?: string | null;
      };
    }
  | { kind: "ignored"; reason: string };

export type SendErrorCode =
  | "INVALID_INPUT"
  | "EMAIL_SUBJECT_REQUIRED"
  | "CHANNEL_LOOKUP_FAILED"
  | "NO_ACTIVE_CHANNEL"
  | "NOT_ENTITLED"
  | "SUBSCRIPTION_INACTIVE"
  | "USAGE_LIMIT_REACHED"
  | "CREDENTIALS_UNAVAILABLE"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_CLOSED"
  | "SERVICE_WINDOW_CLOSED"
  | "TEMPLATE_NOT_APPROVED"
  | "TEMPLATE_PARAMETERS_INVALID"
  | "RECORD_FAILED"
  | "PROVIDER_SEND_FAILED"
  /** Timeout/network loss after the provider may have accepted; the row stays queued for callback repair or a later retry. */
  | "PROVIDER_SEND_AMBIGUOUS";

export type SendResult =
  | {
      ok: true;
      outboundMessageId: string;
      channel: MessageChannel;
      provider: MessagingProviderId;
      providerMessageId: string | null;
    }
  | {
      ok: false;
      code: SendErrorCode;
      /** Present when a queued outbound_messages row was written before failure. */
      outboundMessageId?: string;
    };
