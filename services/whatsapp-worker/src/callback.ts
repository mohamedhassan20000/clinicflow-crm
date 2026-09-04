import { createHmac } from "node:crypto";
import type { WorkerConfig } from "./config.ts";

/**
 * The one way traffic leaves this worker for ClinicFlow.
 *
 * The application's /api/webhooks/whatsapp/linked-device route is the same
 * pipeline Cloud API traffic goes through, so nothing here writes to the inbox
 * itself: it hands over normalized events and lets the application decide what
 * they mean. Each request is signed with HMAC-SHA256 over `timestamp.body` so
 * the receiver can prove both origin and integrity, and reject a replay.
 */

/**
 * One file a patient sent, after the worker has already downloaded, measured and
 * sniffed it.
 *
 * `mimeType` is what the *bytes* are, never what the sender's client claimed, and
 * `originalFilename` is carried as a label only — the storage path is built from
 * a fresh identifier, so a filename can never steer where anything is written.
 * A file that was too large, or of a kind this stack will not store, still
 * produces one of these with `status: "rejected"`: the message it arrived with is
 * preserved either way, and staff are told there was something they cannot open
 * rather than being shown nothing at all.
 */
export type CallbackAttachment = {
  mediaKind: "image" | "document" | "audio" | "video" | "unsupported";
  /** True only for an `audioMessage` WhatsApp marked as PTT. */
  voiceNote: boolean;
  /** Whole seconds reported by WhatsApp, when present and sane. */
  durationSeconds: number | null;
  mimeType: string;
  originalFilename: string | null;
  byteSize: number;
  sha256: string | null;
  /** `<clinicId>/...` inside the private bucket. Null unless `status` is stored. */
  storagePath: string | null;
  status: "stored" | "rejected" | "failed";
  failureReason: string | null;
};

export type CallbackEvent =
  | {
      kind: "inbound";
      providerMessageId: string;
      sender: string;
      body: string;
      receivedAt: string;
      /** The name WhatsApp reports for this contact. Display metadata only. */
      displayName?: string | null;
      /** True when this came from the history sync rather than live traffic. */
      historical?: boolean;
      attachments?: CallbackAttachment[];
    }
  | {
      kind: "outbound_echo";
      providerMessageId: string;
      recipient: string;
      body: string;
      occurredAt: string;
      displayName?: string | null;
      historical?: boolean;
    }
  | {
      /**
       * A one-to-one chat WhatsApp listed on the history sync. Sent even when no
       * message of it survived the filters, so a thread the clinic only ever sent
       * into still appears in the inbox with the right name.
       */
      kind: "history_chat";
      participant: string;
      displayName: string | null;
      lastMessageAt: string | null;
    }
  | {
      /** A WhatsApp-asserted opaque LID ↔ phone-number pair. */
      kind: "history_identity";
      lid: string;
      participant: string;
    }
  | {
      /** A direct history chat held until its opaque LID can be resolved. */
      kind: "history_pending_chat";
      lid: string;
      displayName: string | null;
      lastMessageAt: string | null;
    }
  | {
      /** A history message held durably instead of being dropped on LID lookup. */
      kind: "history_pending_message";
      lid: string;
      providerMessageId: string;
      direction: "inbound" | "outbound";
      body: string;
      occurredAt: string;
      displayName?: string | null;
      attachments?: CallbackAttachment[];
    }
  | {
      /** Privacy-safe source counts for one WhatsApp history batch. */
      kind: "history_metrics";
      chatsReceived: number;
      messagesReceived: number;
      unsupportedMessages: number;
      unresolvedChats: number;
    }
  | {
      /** Where this clinic's history import has got to. */
      kind: "history_progress";
      status: "importing" | "complete" | "unavailable";
      chats: number;
      messages: number;
    }
  | {
      kind: "status";
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      occurredAt: string;
    };

const TIMEOUT_MS = 10_000;
/**
 * History batches get their own, much larger budget.
 *
 * The receiver handles a callback strictly sequentially — one
 * `persist_whatsapp_inbound` round-trip per event — so the wall-clock cost of a
 * batch is (events x one Supabase round-trip), plus a cold start if the function
 * was idle. A 10-second client abort over a 100-event body was a coin flip on a
 * warm path and a near-certain loss on a cold one, and every loss used to be
 * permanent. Fewer events and a longer patience make the same work fit.
 */
const HISTORY_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
/**
 * History arrives in one enormous burst. Posting it as a single body would build
 * a multi-megabyte request that the receiver has to parse, persist and answer
 * inside one timeout; posting it in bounded batches keeps every request the same
 * size as an ordinary live delivery, and a batch that fails is retried on its own
 * rather than taking the whole import with it.
 */
export const CALLBACK_MAX_EVENTS_PER_POST = 100;
/** See HISTORY_TIMEOUT_MS: sized so one batch comfortably fits one request. */
export const HISTORY_MAX_EVENTS_PER_POST = 25;

/**
 * What the application says it did with a batch.
 *
 * Reported back to the session bookkeeping so a clinic's "imported N chats" is a
 * count of rows that exist, not of protobuf entries the worker managed to parse.
 * Absent fields default to zero: an older application build answers `{ok:true}`
 * and is treated as "accepted, nothing to report" rather than as a failure.
 */
export type CallbackSummary = {
  inbound: number;
  echoes: number;
  replays: number;
  historyChats: number;
  attachments: number;
  historyPending: number;
  historyReconciled: number;
  historyDeduplicated: number;
  historyChatsReceived: number;
  historyMessagesReceived: number;
  historyUnsupported: number;
};

export type CallbackOutcome = {
  ok: boolean;
  /**
   * The application accepted the request but deliberately stored nothing.
   *
   * It answers this way when the clinic has no active linked-device channel —
   * an unlinked or never-activated pairing — and it is *not* a failure: there is
   * nothing to retry against and nothing to fix by retrying. It is also not a
   * success, and the distinction matters more than it looks. An ignored answer
   * carries the same all-zero summary a genuinely empty batch does, so without
   * this flag the worker reads "I threw your history away" as "I persisted your
   * history", marks the spool row delivered, and a clinic's entire import is
   * silently consumed by a channel that was not listening.
   */
  ignored: boolean;
  /** Present only when the application answered 2xx with a readable body. */
  summary: CallbackSummary | null;
  /** Short, log-safe reason. Never carries a response body. */
  error: string | null;
};

const EMPTY_SUMMARY: CallbackSummary = {
  inbound: 0,
  echoes: 0,
  replays: 0,
  historyChats: 0,
  attachments: 0,
  historyPending: 0,
  historyReconciled: 0,
  historyDeduplicated: 0,
  historyChatsReceived: 0,
  historyMessagesReceived: 0,
  historyUnsupported: 0,
};

function readSummary(value: unknown): CallbackSummary {
  if (!value || typeof value !== "object") return EMPTY_SUMMARY;
  const record = value as Record<string, unknown>;
  const count = (key: keyof CallbackSummary) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  return {
    inbound: count("inbound"),
    echoes: count("echoes"),
    replays: count("replays"),
    historyChats: count("historyChats"),
    attachments: count("attachments"),
    historyPending: count("historyPending"),
    historyReconciled: count("historyReconciled"),
    historyDeduplicated: count("historyDeduplicated"),
    historyChatsReceived: count("historyChatsReceived"),
    historyMessagesReceived: count("historyMessagesReceived"),
    historyUnsupported: count("historyUnsupported"),
  };
}

export class CallbackClient {
  // Not a constructor parameter property: `node --experimental-strip-types`
  // runs this source directly in development and cannot desugar those.
  private readonly config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  /**
   * Posts live events in bounded batches.
   *
   * A batch that fails no longer abandons the ones behind it. Each batch is an
   * independent unit of work — the application's persistence is keyed on
   * WhatsApp's message ids, so nothing about batch N depends on batch N-1 having
   * landed — and dropping forty batches because the seventh timed out was pure
   * loss. The boolean still means "all of it got through".
   */
  async post(clinicId: string, sessionPhone: string, events: readonly CallbackEvent[]): Promise<boolean> {
    if (events.length === 0) return true;
    let ok = true;
    for (let offset = 0; offset < events.length; offset += CALLBACK_MAX_EVENTS_PER_POST) {
      const batch = events.slice(offset, offset + CALLBACK_MAX_EVENTS_PER_POST);
      const outcome = await this.postBatch(clinicId, sessionPhone, batch);
      if (!outcome.ok) ok = false;
    }
    return ok;
  }

  /** One batch, with the history budget. Used by the durable history spool. */
  async postHistoryBatch(
    clinicId: string,
    sessionPhone: string,
    events: readonly CallbackEvent[],
  ): Promise<CallbackOutcome> {
    return this.postBatch(clinicId, sessionPhone, events, HISTORY_TIMEOUT_MS);
  }

  private async postBatch(
    clinicId: string,
    sessionPhone: string,
    events: readonly CallbackEvent[],
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<CallbackOutcome> {
    const body = JSON.stringify({ clinicId, sessionPhone, events });
    let lastError = "unreachable";

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // The timestamp is re-signed per attempt so a slow retry cannot fall
      // outside the receiver's replay window.
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", this.config.callbackSecret)
        .update(`${timestamp}.${body}`, "utf8")
        .digest("hex");
      try {
        const response = await fetch(
          new URL("/api/webhooks/whatsapp/linked-device", this.config.appUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-clinicflow-signature": signature,
              "x-clinicflow-timestamp": timestamp,
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (response.ok) {
          const parsed = await response.json().catch(() => null);
          const ignored =
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as Record<string, unknown>).ignored === true;
          return { ok: true, ignored, summary: readSummary(parsed), error: null };
        }
        // 4xx is a decision, not a hiccup: retrying an unauthorized or
        // malformed callback would only repeat it.
        if (response.status < 500) {
          return { ok: false, ignored: false, summary: null, error: `http_${response.status}` };
        }
        lastError = `http_${response.status}`;
      } catch {
        // Network failure or timeout — fall through to the backoff below.
        lastError = "network";
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    return { ok: false, ignored: false, summary: null, error: lastError };
  }
}
