import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import type {
  ChannelCredentials,
  OutboundMessageStatus,
  ProviderMessage,
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

const CALLBACK_STATUSES = new Set<OutboundMessageStatus>(["sent", "delivered", "read", "failed"]);

function parseEvent(raw: unknown, sessionPhone: string | null): WebhookEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const providerMessageId = asString(event.providerMessageId);
  if (!providerMessageId) return null;

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

/**
 * Parses a *verified* worker callback into normalized events. `sessionPhone` is
 * the sender identity of the clinic's stored channel — supplied by the route,
 * never by the payload — so an inbound event can only ever be attributed to the
 * pairing that actually holds that number.
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
      // it is certain about (unknown session, invalid recipient).
      const ambiguous = response.status >= 500;
      return {
        ok: false,
        error: `Linked device send failed (${response.status})`,
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
    return {
      ok: true,
      providerMessageId: asString(payload.providerMessageId),
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
