import { createHash, randomBytes } from "node:crypto";
import type { proto } from "baileys";
import pino from "pino";
import type { SentMessageCache } from "./outbound.ts";

/**
 * Seeing the retry-repair exchange happen, without seeing anything in it.
 *
 * ## Why this module exists at all
 *
 * The repair path for "Waiting for this message. This may take a while." runs
 * entirely inside Baileys, and every step of it is reported through the `logger`
 * handed to `makeWASocket`. This worker passed that logger a silent pino
 * instance, for the good reason that Baileys' logging is written for a hobby
 * script: it logs binary node frames, JIDs, receipt attributes and Signal
 * addresses at debug, and at `level === 'debug'` `Socket/socket.js` additionally
 * dumps every unhandled frame whole. Silencing it was correct. The cost was that
 * the one exchange we most need to observe became invisible, and a real device
 * stuck on the placeholder produced no worker log line at all.
 *
 * So instead of a level, the socket gets a *translator*. Baileys' log calls are
 * matched against the fixed table below and re-emitted as the worker's own
 * events. Everything unmatched is dropped, and the bound object is never
 * forwarded — only fields this module reads out of it by name, each of which is
 * validated and then hashed.
 *
 * ## The sequence this makes visible
 *
 * From `baileys@6.7.24`, `Socket/messages-recv.ts` and `Socket/messages-send.ts`:
 *
 *   1. `handleReceipt` sees `attrs.type === 'retry'`  → `'recv retry request'`
 *   2. `sendMessagesAgain` calls `getMessage({...key, id})` — that hook is ours,
 *      so the cache hit or miss is logged directly by `createGetMessage` below
 *   3. `assertSessions([participant], true)`          → `'fetching sessions'`
 *   4.                                                → `'forced new session for retry recp'`
 *   5. `relayMessage(...)`                            → `'sending message to N devices'`
 *
 * A run that stops after (1) means the receipt arrived and the plaintext was
 * gone. A run that never reaches (1) means no retry receipt is arriving, and the
 * fault is upstream of anything the cache can fix.
 *
 * ## What may be logged
 *
 * A WhatsApp message id is not secret in the way a JID or a phone number is —
 * the application already stores it — but it is a durable cross-system
 * identifier, and correlating the five lines above does not require the real
 * one. `messageRef` hashes it with a salt generated fresh at every boot, so the
 * lines of a single run correlate with each other and with nothing else, ever.
 *
 * Nothing else is extracted. No JID, no participant, no receipt attributes, no
 * stack trace, no message content, no Signal address.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({ component: "whatsapp" });

/**
 * Regenerated every boot, so a `messageRef` correlates lines within one process
 * run and is meaningless outside it. Not persisted anywhere by design: a stable
 * salt would turn these into a durable pseudonymous index of who was messaged
 * when, which is the thing being avoided.
 */
const REF_SALT = randomBytes(16);

/**
 * WhatsApp message ids are short alphanumeric tokens (`3EB0C767D82F1B4A5D21`).
 * Anything else in an id position is a shape this module does not recognise and
 * therefore will not touch — refusing rather than hashing keeps a JID that
 * turned up in an unexpected field from being quietly accepted as an id.
 */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** A correlatable, non-reversible, per-boot stand-in for a message id. */
export function messageRef(id: unknown): string | null {
  if (typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) return null;
  return createHash("sha256").update(REF_SALT).update(id).digest("hex").slice(0, 12);
}

/** The worker's name for each step of the exchange, in the order they occur. */
export type RetryEvent =
  /** A recipient could not decrypt one of our messages and asked for it again. */
  | "retry_receipt_received"
  /** The hook Baileys uses to recover the plaintext found it. */
  | "retry_cache_hit"
  /** …or did not, which is where the repair stops and the placeholder sticks. */
  | "retry_cache_miss"
  /** A fresh pre-key bundle was fetched — step 3, the "forced fresh session". */
  | "signal_sessions_fetched"
  /** `sendMessagesAgain` is past `assertSessions(..., true)` and about to relay. */
  | "retry_forced_new_session"
  /** Baileys' own miss message, logged alongside ours as corroboration. */
  | "retry_message_unavailable"
  /** A message stanza went out. Fires for ordinary sends and for re-relays alike. */
  | "relay_stanza_sent"
  /** The re-relay threw. The recipient stays on the placeholder. */
  | "retry_relay_failed"
  /** The retry limit (`maxMsgRetryCount`, default 5) is spent for this message. */
  | "retry_limit_reached"
  /** A retry receipt for a message we did not send. Not our repair to make. */
  | "retry_receipt_not_for_us"
  /** *We* could not decrypt something and asked the sender to repeat it. */
  | "inbound_retry_receipt_sent";

type Translation = {
  event: RetryEvent;
  level: "debug" | "info" | "warn" | "error";
  /**
   * Where the message id sits in the object Baileys bound to this log call.
   * Only these paths are ever read; the rest of the object is not touched.
   */
  idPath?: ReadonlyArray<string | number>;
};

/**
 * Baileys' log message → the worker's event.
 *
 * Keyed by the exact message text in `baileys@6.7.24`, except the one entry
 * marked as a prefix, whose text interpolates a device count. A Baileys upgrade
 * that reworded any of these makes the corresponding line disappear from the
 * worker's logs rather than start leaking — the failure mode is silence, which
 * is the safe direction, and `retry-diagnostics.test.ts` pins the strings.
 */
const TRANSLATIONS: ReadonlyArray<{ text: string; prefix?: boolean } & Translation> = [
  // messages-recv.ts, handleReceipt
  {
    text: "recv retry request",
    event: "retry_receipt_received",
    level: "info",
    idPath: ["attrs", "id"],
  },
  { text: "recv retry for not fromMe message", event: "retry_receipt_not_for_us", level: "warn" },
  {
    text: "will not send message again, as sent too many times",
    event: "retry_limit_reached",
    level: "warn",
    idPath: ["attrs", "id"],
  },
  // messages-recv.ts, sendMessagesAgain
  { text: "forced new session for retry recp", event: "retry_forced_new_session", level: "info" },
  {
    text: "recv retry request, but message not available",
    event: "retry_message_unavailable",
    level: "warn",
    idPath: ["id"],
  },
  { text: "error in sending message again", event: "retry_relay_failed", level: "error", idPath: ["ids", 0] },
  // messages-recv.ts, the inbound half: we are the one who failed to decrypt.
  { text: "sent retry receipt", event: "inbound_retry_receipt_sent", level: "info" },
  // messages-send.ts, assertSessions
  { text: "fetching sessions", event: "signal_sessions_fetched", level: "debug" },
  // messages-send.ts, relayMessage — "sending message to 2 devices"
  {
    text: "sending message to",
    prefix: true,
    event: "relay_stanza_sent",
    level: "info",
    idPath: ["msgId"],
  },
];

/** Reads one named path out of a bound object, if it leads to a plain value. */
function atPath(bound: unknown, path: ReadonlyArray<string | number>): unknown {
  let current = bound;
  for (const step of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/**
 * What the worker will say about one Baileys log call, or `null` for the great
 * majority of them, which say nothing about the retry exchange and are dropped.
 *
 * Pure and exported so the suite can assert both halves: that each of the nine
 * strings above is recognised, and that an unrecognised call carrying JIDs, key
 * material or a stack trace yields nothing at all.
 */
export function translateBaileysLog(
  bound: unknown,
  message: string | undefined,
): { event: RetryEvent; level: Translation["level"]; messageRef: string | null } | null {
  // Baileys calls its logger both ways — `logger.info(obj, 'text')` and
  // `logger.info('text')`. The second form is handled so a call site that drops
  // its bindings in a future version does not silently stop being recognised.
  const text = typeof message === "string" ? message : typeof bound === "string" ? bound : null;
  if (text === null) return null;
  const match = TRANSLATIONS.find((entry) =>
    entry.prefix ? text.startsWith(entry.text) : text === entry.text,
  );
  if (!match) return null;
  return {
    event: match.event,
    level: match.level,
    messageRef:
      match.idPath && bound !== text ? messageRef(atPath(bound, match.idPath)) : null,
  };
}

/**
 * The shape `makeWASocket` requires of its `logger`.
 *
 * Declared here rather than imported as Baileys' `ILogger` so the adapter is
 * structurally checked against a definition this worker controls, and so the
 * tests can construct one without importing the socket.
 */
export type BaileysLogger = {
  level: string;
  child(bindings: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

export type DiagnosticSink = (record: {
  clinicId: string;
  event: RetryEvent;
  level: Translation["level"];
  messageRef: string | null;
  /** Present only on the cache hit/miss events. */
  cacheSize?: number;
}) => void;

function emit(record: Parameters<DiagnosticSink>[0]): void {
  const line = {
    clinicId: record.clinicId,
    event: record.event,
    ...(record.messageRef ? { messageRef: record.messageRef } : {}),
    ...(record.cacheSize === undefined ? {} : { cacheSize: record.cacheSize }),
  };
  logger[record.level](line, "retry diagnostic");
}

/**
 * The logger handed to `makeWASocket`.
 *
 * `level` is deliberately reported as `info`: `Socket/socket.js` branches on
 * `logger.level === 'trace'` and `=== 'debug'` to serialise whole binary frames
 * before logging them, and while this adapter would drop the result, there is no
 * reason to build it. Baileys calls `debug()` unconditionally everywhere else,
 * so the table above still sees everything it needs.
 */
export function createSocketLogger(clinicId: string, sink: DiagnosticSink = emit): BaileysLogger {
  const forward = (bound: unknown, message: string | undefined) => {
    const translated = translateBaileysLog(bound, message);
    if (!translated) return;
    sink({ clinicId, ...translated });
  };
  const adapter: BaileysLogger = {
    level: "info",
    // Baileys binds `{ class: 'baileys' }`, `{ class: 'ns' }` and similar. The
    // bindings are discarded rather than merged: nothing in them is needed, and
    // future versions may bind a JID.
    child: () => adapter,
    trace: forward,
    debug: forward,
    info: forward,
    warn: forward,
    error: forward,
  };
  return adapter;
}

/**
 * The `getMessage` hook, with the one observation that cannot be recovered from
 * Baileys' own logging: whether the lookup hit.
 *
 * Baileys logs its miss (`'recv retry request, but message not available'`) but
 * never its hit, so a working repair and a repair that was never asked for look
 * identical from the outside. This is the line that distinguishes them.
 *
 * Only `key.id` is read. Baileys calls this with the full receipt-derived key,
 * whose `remoteJid` and `participant` are the recipient's address; the cache is
 * keyed by id alone and the rest is deliberately not looked at.
 */
export function createGetMessage(
  clinicId: string,
  cache: SentMessageCache,
  sink: DiagnosticSink = emit,
): (key: { id?: string | null }) => Promise<proto.IMessage | undefined> {
  return async (key: { id?: string | null }) => {
    const message = cache.lookup(key?.id);
    sink({
      clinicId,
      event: message ? "retry_cache_hit" : "retry_cache_miss",
      level: message ? "info" : "warn",
      messageRef: messageRef(key?.id),
      cacheSize: cache.size,
    });
    return message;
  };
}
