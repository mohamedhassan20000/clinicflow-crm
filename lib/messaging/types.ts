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

/**
 * A server-authorized object reference for a linked-device WhatsApp send.
 * Bytes never cross the application's 64 KB worker request boundary.
 */
export type OutboundMediaReference = {
  mediaId: string;
  kind: "image" | "document" | "audio";
  mimeType: string;
  bucket: "whatsapp-outbound" | "patient-assets" | "clinic-documents";
  storagePath: string;
  fileName: string | null;
  /** Voice notes are always transcoded to OGG/Opus by the worker. */
  voiceNote: boolean;
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
  /** Linked-device WhatsApp only; always a storage reference, never bytes. */
  media?: OutboundMediaReference;
  /**
   * P11T — the conversation episode this message belongs to, written into the
   * row in the same statement that creates it.
   *
   * Set by the Patient Assistant so that an inbound turn and the assistant's
   * reply to it carry the same `episode_id` and an audit never has to replay
   * timestamp arithmetic to pair them. Omitted by every other caller: a
   * reminder, an invoice follow-up or a staff member's own message is not part
   * of an assistant episode, and a null here is the truthful record of that.
   */
  episodeId?: string | null;
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
  /** Linked-device WhatsApp only; the worker downloads this private object. */
  media?: Omit<OutboundMediaReference, "mediaId">;
};

export type ProviderSendResult =
  | { ok: true; providerMessageId: string | null; costMicro: number | null }
  | {
      ok: false;
      error: string;
      /** Safe, provider-neutral media failure stage; never raw provider text. */
      failureCode?: ProviderMediaFailureCode;
      /**
       * True when the provider may have accepted the message anyway (timeout,
       * network interruption, unparseable 2xx). Callers must not fall back to
       * another channel on an ambiguous outcome — the delivery callback can
       * still repair the record via the client reference.
       */
      ambiguous?: boolean;
    };

export type ProviderMediaFailureCode =
  | "MEDIA_REQUEST_REJECTED"
  | "MEDIA_STORAGE_FETCH_FAILED"
  | "MEDIA_TRANSCODE_FAILED"
  | "MEDIA_BAILEYS_SEND_FAILED";

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
/**
 * P8, linked-device only: a file a patient sent, already downloaded, sniffed and
 * stored by the pairing worker.
 *
 * `mimeType` is what the bytes are, not what the sending client claimed;
 * `originalFilename` is a label and never a path component. A refused or failed
 * file still arrives as one of these so the clinic sees that something came
 * through that ClinicFlow could not open.
 */
export type InboundAttachment = {
  mediaKind: "image" | "document" | "audio" | "video" | "unsupported";
  /** `audioMessage.ptt`, kept separately from the coarse audio media kind. */
  voiceNote: boolean;
  /** Whole seconds reported by WhatsApp, when available. */
  durationSeconds: number | null;
  mimeType: string;
  originalFilename: string | null;
  byteSize: number;
  sha256: string | null;
  storagePath: string | null;
  status: "stored" | "rejected" | "failed";
  failureReason: string | null;
};

export type WebhookEvent =
  | {
      kind: "inbound";
      phoneNumberId: string;
      sender: string;
      providerMessageId: string;
      body: string;
      receivedAt: string | null;
      /**
       * P8: the contact/push name WhatsApp reports for this sender. Display
       * metadata only — it never resolves, matches or verifies a patient.
       */
      displayName?: string | null;
      /**
       * P8: this message came from the linked device's history sync, not from
       * live traffic. Historical messages are persisted but produce no service
       * window, no staff notification, and no agent turn.
       */
      historical?: boolean;
      attachments?: InboundAttachment[];
    }
  | {
      /**
       * P8: a one-to-one chat the history sync listed. Opens the inbox thread so
       * a conversation the clinic only ever sent into still appears, and carries
       * the WhatsApp display name for it.
       */
      kind: "history_chat";
      participant: string;
      displayName: string | null;
      lastMessageAt: string | null;
    }
  | {
      /** P8: how far this clinic's history import has got. */
      kind: "history_progress";
      status: "importing" | "complete" | "unavailable";
      chats: number;
      messages: number;
    }
  | {
      kind: "history_identity";
      lid: string;
      participant: string;
    }
  | {
      kind: "history_pending_chat";
      lid: string;
      displayName: string | null;
      lastMessageAt: string | null;
    }
  | {
      kind: "history_pending_message";
      lid: string;
      providerMessageId: string;
      direction: "inbound" | "outbound";
      body: string;
      occurredAt: string;
      displayName?: string | null;
      attachments?: InboundAttachment[];
    }
  | {
      kind: "history_metrics";
      chatsReceived: number;
      messagesReceived: number;
      unsupportedMessages: number;
      unresolvedChats: number;
    }
  | {
      /**
       * P7E, linked-device only: a message the clinic sent from the phone
       * itself, which the paired device receives a copy of. It is mirrored into
       * the inbox thread as an outbound message so staff see the whole
       * conversation, and never counted against messaging usage — ClinicFlow
       * did not send it. Messages ClinicFlow *did* send arrive here too and are
       * discarded by provider-message-id uniqueness.
       */
      kind: "outbound_echo";
      recipient: string;
      providerMessageId: string;
      body: string;
      occurredAt: string | null;
      displayName?: string | null;
      historical?: boolean;
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
  | "MEDIA_UNSUPPORTED"
  | "MEDIA_UNAVAILABLE"
  | ProviderMediaFailureCode
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
