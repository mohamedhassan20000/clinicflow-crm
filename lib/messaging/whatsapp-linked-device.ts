import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { logOutboundMediaDiagnostic } from "@/lib/messaging/outbound-media-diagnostics";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import type {
  ChannelCredentials,
  InboundAttachment,
  OutboundMessageStatus,
  ProviderMessage,
  ProviderMediaFailureCode,
  ProviderSendResult,
  WebhookEvent,
} from "@/lib/messaging/types";

/**
 * P7E — the WhatsApp Linked Devices adapter.
 *
 * It implements the same channel-neutral contract as the Meta and 360dialog
 * adapters, so every existing domain caller (reminders, invoice follow-ups,
 * manual inbox replies, the patient agent) reaches a paired phone through the
 * one `sendMessage` entry point without knowing which transport carries it.
 *
 * The transport itself is the pairing worker: this adapter never opens a socket.
 * It hands the worker a message for one clinic's session and parses the events
 * that session reports back.
 *
 * Capability note, deliberately not papered over: a linked device is a *personal
 * device* on the clinic's own WhatsApp account. It has no Cloud API template
 * catalogue, no approval workflow and no 24-hour service window — an approved
 * ClinicFlow template is rendered and sent as ordinary text. Cloud-API-only
 * features (paid template categories, message-level pricing, WABA quality
 * ratings) simply do not exist here and are reported as absent, not faked.
 */

const SEND_TIMEOUT_MS = 15_000;
/** How far a worker callback's timestamp may drift before it is refused. */
const CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;

export const LINKED_DEVICE_SIGNATURE_HEADER = "x-clinicflow-signature";
export const LINKED_DEVICE_TIMESTAMP_HEADER = "x-clinicflow-timestamp";

function workerBaseUrl(): string | null {
  const raw = process.env.WHATSAPP_WORKER_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The shared secret between this application and its pairing worker. Callbacks
 * carry HMAC-SHA256 over `timestamp.body`, so a captured callback cannot be
 * replayed later and a body cannot be altered in flight.
 */
export function signLinkedDeviceCallback(
  timestamp: string,
  body: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

type WorkerSendResponse = { ok?: boolean; providerMessageId?: string | null; error?: string };

const WORKER_MEDIA_FAILURE_CODES = new Set<ProviderMediaFailureCode>([
  "MEDIA_REQUEST_REJECTED",
  "MEDIA_STORAGE_FETCH_FAILED",
  "MEDIA_TRANSCODE_FAILED",
  "MEDIA_BAILEYS_SEND_FAILED",
]);

function mediaFailureCode(
  message: ProviderMessage,
  status: number,
  workerCode: unknown,
): ProviderMediaFailureCode | undefined {
  if (!message.media) return undefined;
  if (
    typeof workerCode === "string" &&
    WORKER_MEDIA_FAILURE_CODES.has(workerCode as ProviderMediaFailureCode)
  ) {
    return workerCode as ProviderMediaFailureCode;
  }
  // Backward compatibility makes an old worker visible instead of collapsing
  // its text-only parser's 400 into the generic provider failure.
  if (status === 400 || workerCode === "invalid_message") return "MEDIA_REQUEST_REJECTED";
  if (workerCode === "MEDIA_UNAVAILABLE") return "MEDIA_STORAGE_FETCH_FAILED";
  return undefined;
}

/**
 * The payload the worker posts to /api/webhooks/whatsapp/linked-device. It is
 * ours, not a third party's, so the shape is exact and anything unexpected is
 * dropped rather than coerced.
 */
type WorkerCallbackPayload = {
  clinicId?: unknown;
  sessionPhone?: unknown;
  events?: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asIsoString(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function asLid(value: unknown): string | null {
  const raw = asString(value);
  return raw && /^\d{3,30}@lid$/.test(raw) ? raw : null;
}

function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/** Namespaces Baileys ids by authenticated account without storing its phone. */
export function scopedLinkedDeviceMessageId(accountId: string, providerMessageId: string): string {
  const scope = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 16);
  return `ld_${scope}_${providerMessageId}`.slice(0, 255);
}

const CALLBACK_STATUSES = new Set<OutboundMessageStatus>(["sent", "delivered", "read", "failed"]);

const MEDIA_KINDS = new Set<InboundAttachment["mediaKind"]>([
  "image",
  "document",
  "audio",
  "video",
  "unsupported",
]);
const ATTACHMENT_STATUSES = new Set<InboundAttachment["status"]>(["stored", "rejected", "failed"]);
/** More files than this on one message is not a patient sending documents. */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * A display name off the wire, reduced to something safe to render.
 *
 * It is chosen by whoever is typing, so it is treated exactly like message
 * content: bidirectional-override and other invisible control characters are
 * stripped (they can make a name render as a completely different string), the
 * length is bounded to the column, and nothing about it is trusted beyond being
 * a label.
 */
function asDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, 120);
}

/**
 * One attachment record, rebuilt field by field.
 *
 * Nothing is passed through: the kind and status must be members of the two
 * known sets, the size must be a non-negative integer, the digest must look like
 * a SHA-256, and the storage path must be a plain relative path with no traversal
 * in it. The path's *tenant* is checked separately by the caller, which is the
 * only place that knows which clinic the callback was proved to speak for.
 */
function parseAttachment(raw: unknown): InboundAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const mediaKind = asString(value.mediaKind) as InboundAttachment["mediaKind"] | null;
  const status = asString(value.status) as InboundAttachment["status"] | null;
  const mimeType = asString(value.mimeType);
  if (!mediaKind || !MEDIA_KINDS.has(mediaKind)) return null;
  if (!status || !ATTACHMENT_STATUSES.has(status)) return null;
  if (
    !mimeType ||
    mimeType.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*codecs\s*=\s*"?[a-z0-9!#$&^_.+-]+"?)?$/i.test(mimeType)
  ) {
    return null;
  }
  const voiceNote = value.voiceNote === true;
  if (voiceNote && mediaKind !== "audio") return null;
  const rawDuration = value.durationSeconds;
  const durationSeconds = rawDuration === null || rawDuration === undefined
    ? null
    : Number(rawDuration);
  if (
    durationSeconds !== null &&
    (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 7 * 24 * 60 * 60)
  ) {
    return null;
  }
  const byteSize = Number(value.byteSize);
  if (!Number.isInteger(byteSize) || byteSize < 0) return null;
  const sha256 = asString(value.sha256);
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const storagePath = asString(value.storagePath);
  if (storagePath !== null && !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/.test(storagePath)) return null;
  if (storagePath !== null && storagePath.includes("..")) return null;
  // A stored attachment without bytes, or a refused one that claims to have
  // them, is incoherent — refuse it rather than persist the contradiction.
  if ((status === "stored") !== (storagePath !== null)) return null;
  const originalFilename = asString(value.originalFilename);
  const failureReason = asString(value.failureReason);
  return {
    mediaKind,
    voiceNote,
    durationSeconds,
    mimeType: mimeType.toLowerCase(),
    originalFilename: originalFilename ? originalFilename.slice(0, 255) : null,
    byteSize,
    sha256,
    storagePath,
    status,
    failureReason: failureReason ? failureReason.slice(0, 80) : null,
  };
}

function parseAttachments(raw: unknown): InboundAttachment[] {
  if (!Array.isArray(raw)) return [];
  const parsed: InboundAttachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const attachment = parseAttachment(item);
    if (attachment) parsed.push(attachment);
  }
  return parsed;
}

function parseEvent(raw: unknown, sessionPhone: string | null): WebhookEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;

  // The two history events carry no message id — they describe a thread and the
  // progress of the import, not a message — so they are matched before the id is
  // required.
  if (event.kind === "history_chat") {
    const participant = asString(event.participant);
    if (!participant) return null;
    return {
      kind: "history_chat",
      participant,
      displayName: asDisplayName(event.displayName),
      lastMessageAt: asIsoString(event.lastMessageAt),
    };
  }

  if (event.kind === "history_progress") {
    const status = asString(event.status);
    if (status !== "importing" && status !== "complete" && status !== "unavailable") return null;
    const chats = Number(event.chats);
    const messages = Number(event.messages);
    return {
      kind: "history_progress",
      status,
      chats: Number.isInteger(chats) && chats >= 0 ? chats : 0,
      messages: Number.isInteger(messages) && messages >= 0 ? messages : 0,
    };
  }

  if (event.kind === "history_identity") {
    const lid = asLid(event.lid);
    const participant = asString(event.participant);
    if (!lid || !participant) return null;
    return { kind: "history_identity", lid, participant };
  }

  if (event.kind === "history_pending_chat") {
    const lid = asLid(event.lid);
    if (!lid) return null;
    return {
      kind: "history_pending_chat",
      lid,
      displayName: asDisplayName(event.displayName),
      lastMessageAt: asIsoString(event.lastMessageAt),
    };
  }

  if (event.kind === "history_metrics") {
    return {
      kind: "history_metrics",
      chatsReceived: asCount(event.chatsReceived),
      messagesReceived: asCount(event.messagesReceived),
      unsupportedMessages: asCount(event.unsupportedMessages),
      unresolvedChats: asCount(event.unresolvedChats),
    };
  }

  const rawProviderMessageId = asString(event.providerMessageId);
  if (!rawProviderMessageId) return null;
  const providerMessageId = sessionPhone
    ? scopedLinkedDeviceMessageId(sessionPhone, rawProviderMessageId)
    : rawProviderMessageId;

  if (event.kind === "history_pending_message") {
    const lid = asLid(event.lid);
    const occurredAt = asIsoString(event.occurredAt);
    const direction = event.direction;
    if (!lid || !occurredAt || (direction !== "inbound" && direction !== "outbound")) {
      return null;
    }
    return {
      kind: "history_pending_message",
      lid,
      providerMessageId,
      direction,
      body: typeof event.body === "string" ? event.body.slice(0, 8192) : "",
      occurredAt,
      displayName: asDisplayName(event.displayName),
      attachments: direction === "inbound" ? parseAttachments(event.attachments) : [],
    };
  }

  if (event.kind === "inbound") {
    const sender = asString(event.sender);
    if (!sender || !sessionPhone) return null;
    return {
      kind: "inbound",
      // The pairing has exactly one identity, and the route proves it against
      // the stored channel before any of this is persisted.
      phoneNumberId: sessionPhone,
      sender,
      providerMessageId,
      body: typeof event.body === "string" ? event.body : "",
      receivedAt: asIsoString(event.receivedAt),
      displayName: asDisplayName(event.displayName),
      historical: event.historical === true,
      attachments: parseAttachments(event.attachments),
    };
  }

  if (event.kind === "outbound_echo") {
    const recipient = asString(event.recipient);
    if (!recipient) return null;
    return {
      kind: "outbound_echo",
      recipient,
      providerMessageId,
      body: typeof event.body === "string" ? event.body : "",
      occurredAt: asIsoString(event.occurredAt),
      displayName: asDisplayName(event.displayName),
      historical: event.historical === true,
    };
  }

  if (event.kind === "status") {
    const status = asString(event.status);
    if (!status || !CALLBACK_STATUSES.has(status as OutboundMessageStatus)) return null;
    return {
      kind: "status",
      providerMessageId,
      clientReference: asString(event.clientReference),
      status: status as Extract<OutboundMessageStatus, "sent" | "delivered" | "read" | "failed">,
      error: null,
      occurredAt: asIsoString(event.occurredAt),
    };
  }

  return null;
}

/** Reads the clinic a callback claims, before anything about it is trusted. */
export function readLinkedDeviceCallbackClinicId(body: string): string | null {
  try {
    const payload = JSON.parse(body) as WorkerCallbackPayload;
    return asString(payload.clinicId);
  } catch {
    return null;
  }
}

/** The worker-observed authenticated PN identity, used to reject stale spools. */
export function readLinkedDeviceCallbackAccountId(body: string): string | null {
  try {
    const payload = JSON.parse(body) as WorkerCallbackPayload;
    const value = asString(payload.sessionPhone);
    return value && /^\+[1-9][0-9]{5,19}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parses a *verified* worker callback into normalized events. `sessionPhone` is
 * the worker-observed authenticated PN identity after the route has proved it
 * equals both the active channel and the current session binding.
 */
export function parseLinkedDeviceCallback(
  body: string,
  sessionPhone: string | null,
): WebhookEvent[] {
  let payload: WorkerCallbackPayload;
  try {
    payload = JSON.parse(body) as WorkerCallbackPayload;
  } catch {
    return [];
  }
  if (!Array.isArray(payload.events)) return [];
  const events: WebhookEvent[] = [];
  for (const raw of payload.events) {
    const parsed = parseEvent(raw, sessionPhone);
    events.push(parsed ?? { kind: "ignored", reason: "unsupported_event" });
  }
  return events;
}

export const linkedDeviceWhatsAppProvider: MessagingProvider = {
  id: "linked_device",
  channel: "whatsapp",

  /**
   * Sends through this clinic's own paired session.
   *
   * The session is addressed by the clinic id stored inside the channel's
   * encrypted envelope, so one clinic's send can never be routed onto another
   * clinic's socket even if a caller passed the wrong recipient. A timeout is
   * reported as ambiguous: the worker may already have handed the message to
   * WhatsApp, and the delivery callback repairs the row by client reference.
   */
  async send(
    message: ProviderMessage,
    credentials: ChannelCredentials,
  ): Promise<ProviderSendResult> {
    const baseUrl = workerBaseUrl();
    const token = process.env.WHATSAPP_WORKER_TOKEN;
    const clinicId = credentials.clinicId;
    if (!baseUrl || !token || !clinicId) {
      return { ok: false, error: "Linked device transport is not configured" };
    }

    if (message.media) {
      logOutboundMediaDiagnostic({
        stage: "provider_request_started",
        clinicId,
        mediaKind: message.media.kind,
        bucket: message.media.bucket,
        outcome: "started",
      });
    }

    let response: Response;
    try {
      response = await fetch(
        new URL(`/v1/sessions/${encodeURIComponent(clinicId)}/messages`, baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            recipient: message.recipient,
            body: message.body,
            clientReference: message.clientReference ?? null,
            // A private object reference only. The worker downloads with its
            // service role after independently checking bucket + tenant path;
            // media bytes never enter this 64 KB HTTP body.
            ...(message.media ? { media: message.media } : {}),
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      return { ok: false, error: sanitizeProviderError(error), ambiguous: true };
    }

    if (!response.ok) {
      // 5xx means the worker never got far enough to be sure; 4xx is a refusal
      // it is certain about (unknown session, invalid recipient). A missing
      // storage object is also deterministic and happens before Baileys sends;
      // do not leave its row queued as an ambiguous provider acceptance.
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const failureCode = mediaFailureCode(message, response.status, payload?.error);
      const deterministicMediaFailure =
        failureCode === "MEDIA_REQUEST_REJECTED" ||
        failureCode === "MEDIA_STORAGE_FETCH_FAILED" ||
        failureCode === "MEDIA_TRANSCODE_FAILED";
      const ambiguous = response.status >= 500 && !deterministicMediaFailure;
      return {
        ok: false,
        error: `Linked device send failed (${response.status})`,
        ...(failureCode ? { failureCode } : {}),
        ...(ambiguous ? { ambiguous: true } : {}),
      };
    }

    let payload: WorkerSendResponse;
    try {
      payload = (await response.json()) as WorkerSendResponse;
    } catch (error) {
      return { ok: false, error: sanitizeProviderError(error), ambiguous: true };
    }
    if (!payload.ok) {
      return { ok: false, error: "Linked device send failed" };
    }
    const authenticatedAccountId = asString(credentials.displayPhoneNumber);
    if (!authenticatedAccountId || !/^\+[1-9][0-9]{5,19}$/.test(authenticatedAccountId)) {
      return { ok: false, error: "Linked device account identity is unavailable" };
    }
    const rawProviderMessageId = asString(payload.providerMessageId);
    return {
      ok: true,
      providerMessageId: rawProviderMessageId
        ? scopedLinkedDeviceMessageId(authenticatedAccountId, rawProviderMessageId)
        : null,
      // A linked device is the clinic's own WhatsApp account: there is no
      // per-message price to report.
      costMicro: null,
    };
  },

  /**
   * Verifies a worker callback. Unlike the provider adapters this is not a
   * third party's signature scheme — it is our own shared secret, checked in
   * constant time over the exact bytes received, with a bounded timestamp so a
   * captured callback cannot be replayed.
   */
  async verifySignature(request: Request): Promise<boolean> {
    const secret = process.env.WHATSAPP_WORKER_CALLBACK_SECRET;
    if (!secret) return false;
    const signature = request.headers.get(LINKED_DEVICE_SIGNATURE_HEADER);
    const timestamp = request.headers.get(LINKED_DEVICE_TIMESTAMP_HEADER);
    if (!signature || !timestamp) return false;
    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > CALLBACK_MAX_SKEW_MS) {
      return false;
    }
    const body = await request.text();
    return equalsConstantTime(signature, signLinkedDeviceCallback(timestamp, body, secret));
  },

  /**
   * Part of the MessagingProvider contract, but the linked-device route parses
   * with `parseLinkedDeviceCallback` instead: it must bind every event to the
   * sender identity on the clinic's stored channel, which only the route knows.
   */
  async parseWebhook(request: Request): Promise<WebhookEvent[]> {
    return parseLinkedDeviceCallback(await request.text(), null);
  },
};
