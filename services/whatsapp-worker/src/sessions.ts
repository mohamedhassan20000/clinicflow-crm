import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type Chat,
  type Contact,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import {
  revocableAuthState,
  useSupabaseAuthState,
  type LinkedDeviceAuthState,
} from "./auth-state.ts";
import { createHash } from "node:crypto";
import {
  CallbackClient,
  HISTORY_MAX_EVENTS_PER_POST,
  type CallbackEvent,
} from "./callback.ts";
import type { WorkerConfig } from "./config.ts";
import { encryptAuthValue } from "./crypto.ts";
import { interpretHistoryBatch, type HistoryBatch } from "./history.ts";
import {
  planHistoryResync,
  HISTORY_RESYNC_COOLDOWN_MS,
  HISTORY_RESYNC_MAX_CHATS,
  HISTORY_RESYNC_MESSAGES_PER_CHAT,
  HISTORY_RESYNC_SPACING_MS,
  type HistoryResyncOutcome,
} from "./history-resync.ts";
import { interpretMessage, type InterpretedMedia } from "./inbound.ts";
import { canonicalLidJid, LidDirectory, NameDirectory, phoneFromJid } from "./jids.ts";
import { ingestAttachment, type MediaDownloader } from "./media.ts";
import { SentMessageCache, selectSendTarget } from "./outbound.ts";
import {
  transcodeVoiceToOggOpus,
  type VoiceTranscoder,
} from "./outbound-media.ts";
import { createGetMessage, createSocketLogger, messageRef } from "./retry-diagnostics.ts";
import type { SessionErrorCode, Store } from "./store.ts";

/**
 * One WhatsApp linked-device session per clinic, and never more than one.
 *
 * The whole point of this worker is that these sockets outlive a request. The
 * manager owns them for the life of the process, keyed strictly by clinic id:
 *
 *   clinic A → session A → WhatsApp A
 *   clinic B → session B → WhatsApp B
 *
 * There is no shared socket, no default session and no code path that resolves a
 * socket by anything other than the clinic id the caller was authorized for. A
 * second start for a clinic that already has a live socket returns the existing
 * one instead of opening a duplicate.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
/**
 * The Signal key store gets a silent logger and keeps it.
 *
 * `makeCacheableSignalKeyStore` logs the key *types and ids* it reads and writes
 * at debug/trace, and it is the one component whose bound objects are made of
 * nothing but key material. There is no diagnostic here worth the risk, so this
 * one stays off outright rather than going through the translator in
 * `retry-diagnostics.ts`.
 */
const keyStoreLogger = pino({ level: "silent" });

/** How long a displayed code stays valid before WhatsApp issues a new one. */
const QR_TTL_MS = 60_000;
/** How many codes to offer before giving up and asking the clinic to retry. */
const MAX_QR_ROUNDS = 5;
/**
 * How many times to reopen a socket that closed *before* WhatsApp issued a
 * single code.
 *
 * A separate budget from `MAX_QR_ROUNDS` because it counts a different thing.
 * `qrRounds` only moves when a code actually arrives, so it cannot bound a
 * failure that happens earlier than that: a registration WhatsApp refuses closes
 * the socket, the unpaired branch of `onClose` reopens it, the replacement is
 * refused identically, and the clinic's row is rewritten to `starting` on every
 * pass — forever, with `qr_payload` null, `last_error` null and not one line in
 * the log. That is not a hypothetical; it is how the desktop-sub-platform bug
 * above presented, and the loop is what made it invisible for as long as it was.
 */
const MAX_QRLESS_ROUNDS = 3;
/** Reconnect backoff for an established pairing that dropped. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * The stale-heartbeat window lives in `store.ts` now: the takeover decision is a
 * `WHERE` clause in `Store.claimSession`, not a comparison made here against a
 * row that may already have changed hands. Kept as a comment rather than a dead
 * constant so the next reader looking for it here finds where it went.
 */
/** History batches held while a socket is still identifying itself. */
const MAX_QUEUED_HISTORY_BATCHES = 20;
/** Attachments downloaded at once, so one media-heavy batch cannot stall the socket. */
const MEDIA_CONCURRENCY = 3;
/** Claim pages one drain pass will walk before yielding to the next sweep. */
const HISTORY_DRAIN_PAGES = 200;
/**
 * How long a clinic's history spool is left alone after the application said it
 * ignored a batch.
 *
 * The application ignores history when the clinic has no active linked-device
 * channel. Nothing about that changes in the next sixty seconds, so without this
 * the paced sweep re-posts the whole backlog every minute — hundreds of requests
 * and hundreds of identical "persisted" lines per pass, none of which store
 * anything. Fifteen minutes is chosen to sit clear of the database's own
 * five-minute claim window, so a deferred clinic cannot be picked straight back
 * up by the stale-claim path either.
 *
 * It is a delay, never a decision: the rows stay `pending` and the deferral is
 * dropped the moment a session connects, which is exactly when the channel
 * becomes active again.
 */
const HISTORY_IGNORED_DEFER_MS = 15 * 60_000;
/** How much of an error message is kept in a log line. */
const ERROR_MESSAGE_MAX = 200;

/**
 * The parts of a thrown value that are safe to put in a worker log line.
 *
 * Deliberately *not* `{ err: error }`: pino serializes an Error with its stack
 * and its own enumerable properties, and the errors reaching the teardown path
 * come from Baileys and PostgREST — which attach payloads, JIDs and, in the case
 * of `whatsapp_linked_device_auth`, the row being written. The class name and a
 * truncated primary message are enough to tell an outage from a schema fault,
 * and neither can carry key material, a phone number or a JID on its own.
 *
 * `Store` has already reduced PostgREST failures to their primary message before
 * throwing (see `safeDbError` there), which is where the `details`/`hint` fields
 * that *do* embed values are dropped.
 */
function describeError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, ERROR_MESSAGE_MAX),
    };
  }
  return { errorName: typeof error, errorMessage: "" };
}

/**
 * P15 (§4) — how many unattributable live messages one session will hold.
 *
 * Generous enough that a real patient's opening burst (a greeting, a question,
 * a photo caption) survives intact while the identity assertion catches up, and
 * small enough that a pathological unresolvable LID cannot grow the heap.
 */
const UNRESOLVED_BUFFER_LIMIT = 200;

/**
 * How long a parked message waits for WhatsApp to name its sender.
 *
 * Past this it is abandoned rather than held forever: an identity that has not
 * been asserted in a quarter of an hour of live traffic is not about to be, and
 * a message replayed hours later would arrive in the Inbox as news when it is
 * not. The drop is logged with the same diagnostic as any other, so it is
 * visible rather than silent.
 */
const UNRESOLVED_BUFFER_TTL_MS = 15 * 60 * 1000;

type Session = {
  clinicId: string;
  /**
   * The start this socket belongs to. Once the clinic's epoch moves past it —
   * a logout, or a teardown — every handler on this socket is inert.
   */
  token: StartToken;
  socket: WASocket;
  auth: LinkedDeviceAuthState;
  /** The paired number, once the socket has opened at least once. */
  phone: string | null;
  /** Stable normalized PN identity of the exact authenticated account. */
  authenticatedAccountId: string | null;
  /** LID → phone-number pairings WhatsApp has asserted on this socket. */
  lids: LidDirectory;
  /** Contact/push names WhatsApp has reported. Labels, never identity. */
  names: NameDirectory;
  /** Durable Inbox epoch; old history may enrich names/LIDs but not threads. */
  inboundActiveFrom: string | null;
  /**
   * Whether this socket has already announced that an import is under way.
   *
   * Deliberately *not* a running total any more: the clinic-visible counts are
   * now incremented by the application's own answer to each delivered batch, in
   * the database, so a batch that never landed cannot raise them and a chat
   * appearing in three batches cannot be counted three times.
   */
  history: { started: boolean };
  /**
   * History batches that arrived before the socket reported *which number* it
   * had paired. Baileys does not order `messaging-history.set` against
   * `connection.update: open`, and an event delivered without a session phone
   * cannot be attributed to a channel — so it waits here instead of being
   * dropped, and `onOpen` drains it.
   */
  pendingHistory: HistoryBatch[];
  /**
   * P15 (§4) — live direct messages whose sender could not be named yet.
   *
   * A LID-addressed chat carries the sender's phone number in the stanza's
   * `sender_pn` attribute — but WhatsApp only sends that attribute *sometimes*.
   * For a contact this session has already heard from, that is harmless: the
   * pairing was learned from an earlier stanza, a contact record or the
   * history import, and the directory answers. For a person writing to the
   * clinic for the very first time there is no earlier anything, so a stanza
   * that omits `sender_pn` used to be discarded outright — the message was
   * decrypted, acknowledged to WhatsApp, logged as `unresolved_counterparty`,
   * and then dropped. No inbox row, no conversation, no assistant, nothing for
   * staff to see. That is exactly the reported failure: a stranger messages
   * the clinic and ClinicFlow behaves as though they never did.
   *
   * Nothing here guesses a number — guessing is what would attribute one
   * patient's message to another. The message simply waits, in memory, until
   * WhatsApp asserts the pairing through any of the channels it already uses
   * (a later stanza, `chats.phoneNumberShare`, a contact record, the history
   * identity events), and is then replayed through the ordinary pipeline as
   * the live message it is.
   *
   * Bounded in both directions so a chatty unresolvable LID cannot grow the
   * worker's heap: {@link UNRESOLVED_BUFFER_LIMIT} entries, evicting oldest
   * first, and {@link UNRESOLVED_BUFFER_TTL_MS} after which an entry is
   * abandoned for good.
   */
  pendingUnresolved: Array<{
    /** Canonical `<user>@lid` this message is waiting on. */
    lid: string;
    upsertType: string;
    message: WAMessage;
    parkedAt: number;
  }>;
  /**
   * Recently sent plaintext, so a retry receipt can be answered. Owned by the
   * session rather than the socket because a reconnect must not forget messages
   * the recipient is still waiting on.
   */
  sent: SentMessageCache;
  qrRounds: number;
  /**
   * Consecutive sockets that closed without WhatsApp issuing a code. Reset the
   * moment one arrives, because a code proves the registration itself is fine.
   */
  qrlessRounds: number;
  reconnectAttempts: number;
  /** Set while a deliberate teardown is in progress, to suppress reconnects. */
  closing: boolean;
};

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      code:
        | "NO_SESSION"
        | "NOT_CONNECTED"
        | "INVALID_RECIPIENT"
        | "MEDIA_STORAGE_FETCH_FAILED"
        | "MEDIA_TRANSCODE_FAILED"
        | "MEDIA_BAILEYS_SEND_FAILED"
        | "SEND_FAILED";
    };

export type OutboundMediaReference = {
  kind: "image" | "document" | "audio";
  mimeType: string;
  bucket: "whatsapp-outbound" | "patient-assets" | "clinic-documents";
  storagePath: string;
  fileName: string | null;
  voiceNote: boolean;
};

export type OutboundSendRequest = {
  body: string;
  media?: OutboundMediaReference;
};

export type StartOutcome = { ok: true } | { ok: false; code: "OWNED_ELSEWHERE" };

/**
 * A start that has been admitted but whose socket may still be coming up.
 *
 * `admitted` settles once the clinic's ownership is proven and the durable
 * "starting" row is written — that is what the HTTP caller waits for.
 * `settled` settles when the socket has finished opening or has failed, and is
 * what the paced internal sweeps wait for. It never rejects.
 */
type PendingStart = { admitted: Promise<StartOutcome>; settled: Promise<void>; token: StartToken };

/**
 * A start's licence to publish state for a clinic.
 *
 * Every clinic has a monotonic *epoch*. A start captures the epoch current when
 * it was admitted and carries that capture through every asynchronous hop it
 * makes: the auth load, the identity write, the socket handshake, the event
 * handlers the socket goes on to fire, and the reconnects that socket schedules.
 * `logout()` (and any other definitive teardown) bumps the epoch, which revokes
 * every token issued before it in a single synchronous step — without needing to
 * find, await or unwind the work already in flight.
 *
 * Deleting the `starting` entry cannot do this job on its own: the promise it
 * pointed at goes on running, holding its own `auth` and about to receive its own
 * socket. The token is what those closures consult, so the work that survives
 * cancellation survives it *mute*.
 */
type StartToken = { clinicId: string; epoch: number };

/**
 * How the manager reaches WhatsApp. Substituted only in tests, so a suite can
 * drive a slow or failing handshake without opening a real socket.
 */
export type SocketFactory = (
  auth: LinkedDeviceAuthState,
  sent: SentMessageCache,
  clinicId: string,
  options: { syncFullHistory: boolean },
) => Promise<WASocket>;

/**
 * The device identity this worker registers as, fixed rather than derived.
 *
 * `Browsers.appropriate()` reads the *host* operating system, and Baileys turns
 * that into more than a display name: `Utils/validate-connection.ts` maps an
 * `os` of `Mac OS` or `Windows` onto `webSubPlatform = DARWIN | WIN32` whenever
 * `syncFullHistory` is set, which tells WhatsApp the client is the native
 * Desktop app rather than a linked web companion. The rest of the payload is
 * still a web-companion registration, and WhatsApp answers the contradiction by
 * terminating the stream (428) *before* it sends `pair-device` — so no QR is
 * ever issued and the socket simply closes. `Browsers.ubuntu` is not on that
 * map, so the sub-platform stays `WEB_BROWSER`, which is what this worker
 * actually is.
 *
 * Pinning it also removes the class of bug this was: a worker that behaves one
 * way on a maintainer's macOS laptop and another way in its Debian container,
 * for a reason that appears nowhere in this file.
 */
export const BROWSER_IDENTITY = Browsers.ubuntu("ClinicFlow");

/**
 * The dedupe identity of one history delivery batch.
 *
 * The key is a digest of the batch's own contents *scoped to the WhatsApp
 * account that produced it*, which is what makes the enqueue idempotent per
 * account rather than per clinic: a phone that re-pushes the same history to a
 * reconnecting socket produces the same keys and adds no rows, while the *same*
 * payload arriving under a different authenticated account is a different batch
 * and must be spooled.
 *
 * `authenticatedAccountId` was missing from this derivation before, so a batch
 * a pre-isolation link had already delivered — keyed on clinic + phone + payload
 * alone — collided with the account-scoped batch of a later link carrying the
 * identical payload, and `ignoreDuplicates: true` dropped the new rows in
 * silence. Contacts and LID pairs survived because they never ride the spool;
 * conversations and messages did not. Legacy rows are left exactly as they are:
 * their keys simply no longer collide with anything this derivation produces.
 *
 * The canonical account identity is the authenticated account bound to the
 * session (`Session.authenticatedAccountId`), never the LID — a LID is an alias
 * WhatsApp may or may not assert, and keying durable rows on it would make the
 * identity of a batch depend on whether an alias happened to be known yet.
 */
export function historyBatchKey(input: {
  clinicId: string;
  authenticatedAccountId: string;
  sessionPhone: string;
  serializedPayload: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.clinicId}:${input.authenticatedAccountId}:${input.sessionPhone}:${input.serializedPayload}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 64);
}

/**
 * How long to wait for WhatsApp's advertised protocol version before opening
 * the socket on the version Baileys ships with.
 *
 * `fetchLatestBaileysVersion()` passes no timeout to axios, which means no
 * timeout at all: a request that is dropped rather than refused never settles,
 * and this `await` is upstream of every handler the session has — so the socket
 * is never built, no `connection.update` can arrive, and the clinic's row sits
 * at `starting` forever with nothing written anywhere. Bounded here so the worst
 * case is a slightly stale version rather than a start that never finishes.
 */
const VERSION_FETCH_TIMEOUT_MS = 10_000;

/** The production factory: Baileys, on the protocol version WhatsApp advertises. */
async function connectToWhatsApp(
  auth: LinkedDeviceAuthState,
  sent: SentMessageCache,
  clinicId: string,
  options: { syncFullHistory: boolean },
): Promise<WASocket> {
  const startedAt = Date.now();
  const { version } = await fetchLatestBaileysVersion({
    timeout: VERSION_FETCH_TIMEOUT_MS,
  }).catch(() => ({ version: undefined }));
  logger.debug(
    { clinicId, stage: "version_fetched", ms: Date.now() - startedAt, pinned: !version },
    "socket startup stage",
  );
  return makeWASocket({
    ...(version ? { version } : {}),
    auth: {
      creds: auth.state.creds,
      keys: makeCacheableSignalKeyStore(auth.state.keys, keyStoreLogger),
    },
    // Not silent, and not Baileys' own logging either: a translator that
    // re-emits the handful of retry-path messages as the worker's own events and
    // drops everything else unread. See retry-diagnostics.ts for what it will
    // and will not say.
    logger: createSocketLogger(clinicId),
    // The clinic scans inside ClinicFlow; nothing is ever printed anywhere.
    printQRInTerminal: false,
    browser: BROWSER_IDENTITY,
    qrTimeout: QR_TTL_MS,
    // Asks the phone for the larger of the two history windows WhatsApp offers
    // when a device is linked. It is a request, not a guarantee: see history.ts
    // for exactly what the platform does and does not provide.
    syncFullHistory: options.syncFullHistory,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Without this, a recipient who fails to decrypt is stuck on "Waiting for
    // this message" for good: Baileys answers their retry receipt by asking for
    // the plaintext here, and the library default returns undefined, so nothing
    // is ever re-sent. See the commentary in outbound.ts. The wrapper adds the
    // hit/miss line — the one step of the exchange Baileys does not report.
    getMessage: createGetMessage(clinicId, sent),
  });
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * Starts that have been admitted but have not yet reached the point where
   * `open()` publishes the socket into `sessions`. Without this, two starts for
   * one clinic arriving in the same tick — a double-clicked "Generate QR code",
   * or the boot-time restore racing that click — would both pass the
   * `sessions.has()` guard while the first was still awaiting the database, and
   * the clinic would end up with two sockets on one pairing.
   *
   * The entry lives until the socket is up or has failed, not merely until the
   * caller is answered: the acknowledgement is deliberately early, so this map
   * is the only thing standing between an eager second click and a second
   * socket.
   */
  private readonly starting = new Map<string, PendingStart>();
  /** Pending reconnect timers, for clinics with no live socket right now. */
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  /**
   * Each clinic's current epoch. Absent means zero; `invalidate()` is the only
   * thing that moves it, and moving it revokes every token issued before.
   */
  private readonly epochs = new Map<string, number>();
  /**
   * Guarded writes that have been admitted and not yet returned, per clinic.
   *
   * `invalidate()` closes the door on new ones synchronously, so this set can
   * only shrink from that moment on — which makes `quiesce()` a real barrier
   * rather than a hopeful wait. Without it, a write a stale start had *already*
   * started could still land after logout's own cleanup, and the row would come
   * back online a moment after being taken offline. Each entry is a single store
   * call, so the barrier is bounded even when the start itself is wedged in a
   * handshake that will never finish.
   */
  private readonly guardedWrites = new Map<string, Set<Promise<unknown>>>();
  /**
   * Recently sent plaintext per clinic, for answering retry receipts.
   *
   * Held by the manager rather than by the `Session` so that a reconnect — which
   * builds a whole new socket and session — does not drop messages a recipient
   * has not managed to decrypt yet. A dropped socket is exactly the situation
   * that produces those retries, so forgetting them on reconnect would disarm
   * the repair precisely when it is needed. Discarded only when the pairing
   * itself ends.
   */
  private readonly sentMessages = new Map<string, SentMessageCache>();
  /**
   * Clinics whose history spool is being posted right now, so an enqueue, the
   * paced sweep and the boot drain cannot claim and post the same batches
   * concurrently. The database claim is the real guard across processes; this is
   * the cheap one inside a process.
   */
  private readonly draining = new Map<string, Promise<void>>();
  /**
   * When each clinic last ran an on-demand history resync, and which clinics
   * are running one right now.
   *
   * In memory deliberately: this is a rate limit on *this worker's* outgoing
   * peer requests, not a durable fact about the import — the durable state is
   * the spool, and the batch key already makes a repeated answer idempotent. A
   * restart may therefore allow one extra run, which is bounded and harmless,
   * and no schema change is needed to hold it.
   */
  private readonly historyResyncAt = new Map<string, number>();
  private readonly historyResyncing = new Set<string>();
  /**
   * Clinics whose history spool is not to be posted before this timestamp,
   * because the application is currently ignoring their history.
   *
   * In memory on purpose. It is a rate limit on this worker's own sweeps, not a
   * fact about the import — the durable state remains what the spool says — so a
   * restart, which is when an operator is most likely to be waiting for the
   * import to move, starts by trying once more rather than by honouring a timer
   * it inherited from the process before it.
   */
  private readonly historyDeferrals = new Map<string, number>();
  private readonly callbacks: CallbackClient;
  private shuttingDown = false;
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: `node --experimental-strip-types` runs this source directly in
  // development, and strip-only mode cannot desugar them.
  private readonly config: WorkerConfig;
  private readonly store: Store;
  private readonly createSocket: SocketFactory;
  /**
   * How an attachment's bytes are fetched. Substituted only in tests — the
   * default is Baileys' own decrypting download, and a suite that wants to
   * exercise the storage path cannot reach WhatsApp's media servers.
   */
  private readonly downloadMedia: MediaDownloader | undefined;
  /** Browser-recorded audio normalization; injectable so tests never need ffmpeg. */
  private readonly transcodeVoice: VoiceTranscoder;

  constructor(
    config: WorkerConfig,
    store: Store,
    createSocket: SocketFactory = connectToWhatsApp,
    downloadMedia?: MediaDownloader,
    transcodeVoice: VoiceTranscoder = transcodeVoiceToOggOpus,
  ) {
    this.config = config;
    this.store = store;
    this.createSocket = createSocket;
    this.downloadMedia = downloadMedia;
    this.transcodeVoice = transcodeVoice;
    this.callbacks = new CallbackClient(config);
  }

  /** Clinics this instance currently holds a socket for. */
  clinicIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** The token a start beginning right now would carry. */
  private issueToken(clinicId: string): StartToken {
    return { clinicId, epoch: this.epochs.get(clinicId) ?? 0 };
  }

  /** Whether a token still speaks for its clinic. */
  private isCurrent(token: StartToken): boolean {
    return (this.epochs.get(token.clinicId) ?? 0) === token.epoch;
  }

  /**
   * Revokes every token outstanding for a clinic, synchronously.
   *
   * Called before any teardown touches auth, the channel or the session row, so
   * that no in-flight start can be admitted to write anything from here on. It
   * cannot stop work that is already running — that is what the token checks and
   * `quiesce()` are for — but it does guarantee that nothing *new* is admitted.
   */
  private invalidate(clinicId: string): void {
    this.epochs.set(clinicId, (this.epochs.get(clinicId) ?? 0) + 1);
  }

  /**
   * Runs one state-publishing step on behalf of a start, or skips it because the
   * start no longer speaks for the clinic.
   *
   * Every write that could resurrect a logged-out clinic goes through here: the
   * durable "starting" row, the QR, the channel claim, the connected status, and
   * (via `revocableAuthState`) every auth write Baileys triggers.
   */
  private async guarded<T>(
    token: StartToken,
    action: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (!this.isCurrent(token)) return { ran: false };
    const inFlight = action();
    const pending = this.guardedWrites.get(token.clinicId) ?? new Set<Promise<unknown>>();
    this.guardedWrites.set(token.clinicId, pending);
    // Swallowed here only so the bookkeeping promise cannot become an unhandled
    // rejection; the caller still awaits `inFlight` and sees the real failure.
    const tracked = inFlight.then(
      () => undefined,
      () => undefined,
    );
    pending.add(tracked);
    try {
      return { ran: true, value: await inFlight };
    } finally {
      pending.delete(tracked);
      if (pending.size === 0) this.guardedWrites.delete(token.clinicId);
    }
  }

  /**
   * Waits for the guarded writes admitted before `invalidate()` to finish.
   *
   * Ordering, not politeness: cleanup that runs before these have landed can be
   * overtaken by them.
   */
  private async quiesce(clinicId: string): Promise<void> {
    const pending = this.guardedWrites.get(clinicId);
    if (!pending || pending.size === 0) return;
    await Promise.allSettled([...pending]);
  }

  /**
   * Brings this clinic's session up, and answers as soon as the request is
   * durably recorded rather than when WhatsApp finally answers.
   *
   * The caller is the ClinicFlow application, running inside a request with a
   * few seconds to live. Opening a socket takes longer than that on a bad day —
   * auth state to load, a version to fetch, a handshake to complete — so the
   * clinic used to be told the service was unavailable while the worker was in
   * fact seconds away from publishing a perfectly good code. Nothing was wrong
   * except who was waiting.
   *
   * So the two halves are separated. This resolves once the clinic's ownership
   * is proven and `status = starting` is written, which is everything the caller
   * needs: from there the panel polls the session row and the code appears in it
   * when WhatsApp issues one. The socket comes up on this instance's own time,
   * and a failure on that path is written back into the same row (see
   * `recordStartFailure`) instead of vanishing.
   *
   * Idempotent by design: the settings page may call it on every "Generate QR
   * code", and a boot-time restore may race a clinic pressing the button. A
   * clinic whose row is still being heart-beaten by a *different* worker is
   * refused, so two instances can never both hold the same pairing.
   */
  async start(clinicId: string): Promise<StartOutcome> {
    if (this.sessions.has(clinicId)) return { ok: true };
    // A start already in flight for this clinic is *the* start: the second
    // caller waits on its admission and gets that outcome rather than opening a
    // rival socket. Because the entry outlives the acknowledgement, this holds
    // for the whole window in which the first socket is still coming up.
    const inFlight = this.starting.get(clinicId);
    if (inFlight) return inFlight.admitted;

    let admit!: (outcome: StartOutcome) => void;
    let refuse!: (error: unknown) => void;
    const admitted = new Promise<StartOutcome>((resolve, reject) => {
      admit = resolve;
      refuse = reject;
    });
    const token = this.issueToken(clinicId);
    const settled = this.startUncoordinated(token, admit, refuse).finally(() => {
      // Only ever retire our *own* entry. A start cancelled by logout finishes
      // long after the clinic has moved on, and by then the map may hold the
      // fresh start that replaced it.
      if (this.starting.get(clinicId)?.token === token) this.starting.delete(clinicId);
    });
    this.starting.set(clinicId, { admitted, settled, token });
    return admitted;
  }

  /**
   * Admission first, socket second.
   *
   * The returned promise covers both halves and never rejects — a start that
   * fails before admission rejects the *caller's* promise (the application then
   * reports the service as unavailable, exactly as before), and one that fails
   * afterwards is recorded on the session row.
   */
  private async startUncoordinated(
    token: StartToken,
    admit: (outcome: StartOutcome) => void,
    refuse: (error: unknown) => void,
  ): Promise<void> {
    const { clinicId } = token;
    let admittedCaller = false;
    try {
      // Ownership and the durable "starting" row are now one conditional write.
      // Separating them — read the owner, decide, then write unconditionally —
      // is what let two workers both conclude they had won; see
      // `Store.claimSession`. This is also the first place a logout that arrived
      // during the claim can bite: writing this row would put
      // `desired_state = online` back on a clinic that has just asked to be
      // offline.
      const claim = await this.guarded(token, () =>
        this.store.claimSession(clinicId, {
          status: "starting",
          desired_state: "online",
          qr_payload: null,
          qr_expires_at: null,
          last_error: null,
        }),
      );
      if (!claim.ran) {
        // The clinic was logged out while this start was still proving its
        // ownership. Nothing durable was written, and the caller is told the
        // start succeeded because from their point of view it did — their next
        // poll reads the row logout wrote.
        admit({ ok: true });
        return;
      }
      if (!claim.value) {
        // Say so. A refused claim used to be the quietest event in the system:
        // nothing here logged, the HTTP layer answered 409 without a line, and
        // an operator watching this worker saw a pressed "Connect with QR"
        // produce no output whatsoever — which reads as "the request never
        // arrived" and sends the search to the wrong end of the chain entirely.
        // The owner and the age of its heartbeat are exactly what distinguishes
        // "another instance is genuinely serving this clinic" from "this worker
        // is pointed at a database it does not own".
        await this.logRefusedClaim(clinicId);
        // In development takeover mode a refusal is a question rather than an
        // answer: ask for the session and refuse this attempt. The holder
        // releases on its next heartbeat tick and the reconcile sweep after
        // that wins the clinic through the same fenced claim as any other
        // adoption — no socket is opened here, and none is taken from anybody.
        if (this.config.devTakeover) await this.askForHandoff(clinicId);
        admit({ ok: false, code: "OWNED_ELSEWHERE" });
        return;
      }
      // The clinic's intent and this worker's claim on it are now durable, and
      // the row the panel polls says "starting". Everything the caller was
      // waiting for has happened.
      admit({ ok: true });
      admittedCaller = true;

      if (this.shuttingDown) return;
      await this.open(token, {
        qrRounds: 0,
        qrlessRounds: 0,
        reconnectAttempts: 0,
        revalidateOwnership: false,
      });
    } catch (error) {
      if (!admittedCaller) {
        refuse(error);
        return;
      }
      await this.recordStartFailure(token, error);
    }
  }

  /**
   * Puts a socket that failed to come up *after* the acknowledgement somewhere
   * the clinic can see it.
   *
   * Nobody is holding a request open at this point, so an unrecorded failure
   * would leave the panel polling a row that says "starting" forever.
   * `desired_state` is deliberately left alone: the clinic still wants to be
   * online and the reconcile sweep is what retries. Only the visible state is
   * corrected, so the panel stops waiting for a code that is not coming.
   */
  private async recordStartFailure(token: StartToken, error: unknown): Promise<void> {
    const { clinicId } = token;
    // A start the clinic already logged out of is not a fault worth writing to
    // the row: the row says `disconnected` because that is what they asked for,
    // and overwriting it with `error` would be this bug wearing a different hat.
    if (!this.isCurrent(token)) {
      logger.info({ clinicId }, "cancelled session startup failed; nothing recorded");
      return;
    }
    logger.error({ clinicId, err: error }, "session startup failed after acknowledgement");
    const recorded = await this.guarded(token, () =>
      this.store
        .setStatus(clinicId, "error", {
          qr_payload: null,
          qr_expires_at: null,
          last_error: "unavailable",
        })
        .catch((storeError: unknown) => {
          logger.error({ clinicId, err: storeError }, "could not record session startup failure");
        }),
    );
    if (!recorded.ran) logger.info({ clinicId }, "session startup failure superseded by teardown");
  }

  /** Waits for a start this instance admitted to finish opening its socket. */
  private async settle(clinicId: string): Promise<void> {
    await this.starting.get(clinicId)?.settled;
  }

  /**
   * Opens the socket itself. Never called concurrently for one clinic.
   *
   * Three of the four statements before the socket is published are `await`s,
   * and a logout can land in any of the gaps between them, so each one is
   * followed by a currency check. The auth state is additionally handed over
   * *revoked-able* rather than raw: Baileys keeps it for the life of the socket
   * and writes through it on its own schedule, which no check placed here could
   * possibly cover.
   */
  private async open(
    token: StartToken,
    counters: {
      qrRounds: number;
      qrlessRounds: number;
      reconnectAttempts: number;
      /**
       * Whether ownership has to be proven again before a socket is opened.
       *
       * False exactly once: the first open of a start, which has just won
       * `claimSession` and would otherwise pay for the same answer twice. Every
       * other entry into this method is a *reopen* — a reconnect, a
       * `restartRequired`, another unscanned code — and each of those crosses an
       * arbitrary amount of wall-clock time during which the clinic may have
       * been handed to, or reclaimed by, another worker. Opening a second socket
       * on a linked device somebody else is driving is the one failure this
       * whole file is arranged to prevent, so the reopen paths pay the round
       * trip.
       */
      revalidateOwnership?: boolean;
    },
  ): Promise<void> {
    const { clinicId } = token;
    if (!this.isCurrent(token)) return;
    if (counters.revalidateOwnership && !(await this.revalidateOwnership(clinicId, "reconnect"))) {
      return;
    }
    if (!this.isCurrent(token)) return;

    // Each await below is a place a start can stop and never resume, and until
    // the socket is published none of them can report anything through the
    // session row. The stages are logged at debug with a duration and nothing
    // else — no auth value, no version payload, no socket — so a start that
    // stalls names the boundary it stalled on instead of going quiet.
    const openedAt = Date.now();
    const stage = (name: string) => {
      logger.debug({ clinicId, stage: name, ms: Date.now() - openedAt }, "socket startup stage");
    };
    stage("auth_state_load_start");

    const auth = revocableAuthState(
      await useSupabaseAuthState(this.store, clinicId, this.config.credentialsKey),
      async (write) => (await this.guarded(token, write)).ran,
    );
    // A brand-new identity is written before the socket opens, so a restart
    // during the scan reuses the same device keys instead of orphaning them.
    // This is the write the reported bug actually observed: a start admitted
    // before a logout reached here afterwards and re-created the row the logout
    // had just deleted. It is guarded twice over now — once here, and once
    // inside the revoked auth state.
    stage("auth_state_loaded");
    if (!auth.restored) await auth.saveCreds();
    if (!this.isCurrent(token)) return;
    stage("identity_persisted");

    const sent = this.sentCache(clinicId);
    // Recipient LID mappings are account-scoped, so they cannot be loaded until
    // Baileys has identified the authenticated account in `onOpen`.
    const lids = new LidDirectory();
    if (!this.isCurrent(token)) return;
    const socket = await this.createSocket(auth, sent, clinicId, {
      syncFullHistory: this.config.historySync,
    });
    stage("socket_created");

    // Shutdown may have begun while the handshake was in flight. Publishing now
    // would hand the replacement instance a session this one still holds, so
    // the socket is dropped instead — `desired_state` is untouched and the next
    // process restores the clinic normally.
    //
    // A logout that landed in the same window is treated the same way, for a
    // different reason: this socket is still unwired, so ending it here is the
    // one moment it can be discarded without a single handler ever having been
    // attached to it. Nothing is persisted, and `end()` is deliberately not
    // `logout()` — the clinic's teardown has already unlinked the device, and
    // this connection was never published to anyone.
    if (this.shuttingDown || !this.isCurrent(token)) {
      this.discard(clinicId, socket, this.shuttingDown ? "shutdown" : "cancelled");
      return;
    }

    const session: Session = {
      clinicId,
      token,
      socket,
      auth,
      phone: null,
      authenticatedAccountId: null,
      lids,
      names: new NameDirectory(),
      inboundActiveFrom: null,
      history: { started: false },
      pendingHistory: [],
      pendingUnresolved: [],
      sent,
      qrRounds: counters.qrRounds,
      qrlessRounds: counters.qrlessRounds,
      reconnectAttempts: counters.reconnectAttempts,
      closing: false,
    };
    // A socket is coming up for this clinic, so any reconnect still queued for
    // it is redundant.
    this.cancelReconnect(clinicId);
    this.sessions.set(clinicId, session);

    socket.ev.on("creds.update", () => {
      void auth.saveCreds().catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "failed to persist device identity");
      });
    });

    socket.ev.on("connection.update", (update) => {
      void this.onConnectionUpdate(session, update).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "connection update failed");
      });
    });

    socket.ev.on("messages.upsert", (upsert) => {
      void this.onMessages(session, upsert).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "inbound delivery failed");
      });
    });

    // Two more places WhatsApp asserts which phone number is behind a LID. A chat
    // addressed by LID cannot be attributed to a patient without one of these (or
    // the `sender_pn` on an incoming message), so both are recorded even though
    // neither is a message in its own right.
    socket.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
      session.lids.remember(lid, jid);
      void this.flushLidMappings(session).catch(() => undefined);
      // P15 (§4) — this is one of the assertions a parked first message is
      // waiting for, and it does not arrive on a message batch, so the drain
      // has to be triggered here too.
      void this.releaseParkedMessages(session).catch(() => undefined);
    });
    const learnFromContacts = (contacts: Array<Partial<Contact>>) => {
      void this.persistContacts(session, contacts).catch(() => undefined);
    };
    socket.ev.on("contacts.upsert", learnFromContacts);
    socket.ev.on("contacts.update", learnFromContacts);

    // The phone's history push. Everything it means, and everything it cannot
    // promise, is documented in history.ts.
    socket.ev.on("messaging-history.set", (batch) => {
      void this.onHistory(session, batch as HistoryBatch).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "history import failed");
      });
    });

    // A chat record names a contact even when no message of theirs has arrived
    // yet, which is what stops a freshly linked inbox reading as a wall of
    // bare phone numbers.
    const learnFromChats = (chats: Array<Partial<Chat>>) => {
      for (const chat of chats) {
        const phone = phoneFromJid(chat.id) ?? session.lids.lookup(chat.id);
        session.names.remember(phone, (chat as { name?: unknown }).name, 0);
      }
    };
    socket.ev.on("chats.upsert", learnFromChats);
    socket.ev.on("chats.update", learnFromChats);

    socket.ev.on("messages.update", (updates) => {
      void this.onReceipts(session, updates).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "receipt delivery failed");
      });
    });
    stage("handlers_attached");
  }

  private async onConnectionUpdate(
    session: Session,
    update: Partial<{
      connection: string;
      qr: string;
      lastDisconnect: { error: Error | undefined } | undefined;
    }>,
  ): Promise<void> {
    const { clinicId } = session;
    // A socket whose start has been superseded is not allowed to say anything
    // about the clinic any more. Baileys keeps emitting on a socket right up to
    // the moment it notices it has ended, and a stray `qr` here would put a
    // logged-out clinic back on the scan screen.
    if (!this.isCurrent(session.token)) return;

    const qr = update.qr;
    if (qr) {
      session.qrRounds += 1;
      // WhatsApp accepted the registration and is offering a code, so whatever
      // the previous sockets failed at, it was not this.
      session.qrlessRounds = 0;
      // Each new code replaces the previous one in place, so the panel shows a
      // fresh code without the clinic doing anything.
      await this.guarded(session.token, () =>
        this.store.setStatus(clinicId, "awaiting_scan", {
          qr_payload: qr,
          qr_expires_at: new Date(Date.now() + QR_TTL_MS).toISOString(),
          last_error: null,
        }),
      );
      return;
    }

    if (update.connection === "open") {
      await this.onOpen(session);
      return;
    }

    if (update.connection === "close") {
      await this.onClose(session, update.lastDisconnect?.error);
    }
  }

  private async onOpen(session: Session): Promise<void> {
    const { clinicId } = session;
    session.reconnectAttempts = 0;
    session.qrRounds = 0;
    session.qrlessRounds = 0;

    const phone = phoneFromJid(session.socket.user?.id);
    if (!phone) {
      await this.fail(session, "unknown");
      return;
    }
    session.phone = phone;
    const accountLid = canonicalLidJid(session.socket.authState?.creds?.me?.lid ?? null);

    // The channel envelope holds no WhatsApp secret — the device identity stays
    // in whatsapp_linked_device_auth. It carries only what the send adapter
    // needs to address this clinic's session.
    const credentials = encryptAuthValue(
      JSON.stringify({ clinicId, displayPhoneNumber: phone }),
      this.config.credentialsKey,
    );
    const claim = await this.guarded(session.token, () =>
      this.store.activateChannel({
        clinicId,
        phoneNumber: phone,
        credentialsEncrypted: credentials,
      }),
    );
    // Logged out while the socket was identifying itself: `clinic_channels` must
    // stay deleted, so the claim is never made and nothing below runs.
    if (!claim.ran) {
      logger.info({ clinicId }, "pairing completed after logout; channel not claimed");
      return;
    }
    const claimed = claim.value;
    if (!claimed.ok) {
      // The number belongs to another clinic (or could not be stored). The
      // pairing is undone rather than left half-connected.
      //
      // `reason` alone is a dead end for anyone reading the logs — every
      // database fault in the claim collapses into it. The stage says which of
      // the three statements failed, and the SQLSTATE/message name the fault.
      // Both come from Store.activateChannel already stripped of the Postgres
      // `details`/`hint` fields, which would carry the paired number itself.
      logger.warn(
        {
          clinicId,
          reason: claimed.reason,
          stage: claimed.stage,
          dbErrorCode: claimed.code,
          dbErrorMessage: claimed.message,
        },
        "could not claim paired number",
      );
      await this.logout(clinicId, claimed.reason === "identity_taken" ? "pairing_failed" : "unknown");
      return;
    }

    const bound = await this.guarded(session.token, () => this.store.bindLinkedAccount({
      clinicId,
      accountId: phone,
      accountLid,
      proposedBoundary: new Date().toISOString(),
    }));
    if (!bound.ran) return;
    const account = bound.value;
    session.authenticatedAccountId = phone;
    session.inboundActiveFrom = account.inboundActiveFrom;
    if (account.changed) {
      const superseded = await this.guarded(session.token, () =>
        this.store.supersedeHistoryBatches(clinicId, phone));
      if (!superseded.ran) return;
    }
    try {
      for (const mapping of await this.store.loadLidMappings(clinicId, phone)) {
        session.lids.remember(mapping.lid, mapping.phone);
      }
      session.lids.takeNewMappings();
    } catch {
      logger.warn({ clinicId }, "account-scoped LID mappings unavailable during startup");
    }

    const published = await this.guarded(session.token, () =>
      this.store.setStatus(clinicId, "connected", {
        desired_state: "online",
        qr_payload: null,
        qr_expires_at: null,
        phone_number: phone,
        connected_at: new Date().toISOString(),
        last_error: null,
      }),
    );
    if (!published.ran) return;
    logger.info({ clinicId }, "session connected");
    // The channel row this clinic's history had nowhere to go without was just
    // claimed and activated, so a spool deferred for the lack of it is released
    // now rather than serving out a timer that no longer describes anything.
    this.resumeHistory(clinicId);

    // Anything the phone pushed before it told us who it was.
    const queued = session.pendingHistory.splice(0, session.pendingHistory.length);
    for (const batch of queued) {
      await this.onHistory(session, batch).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "queued history import failed");
      });
    }
  }

  private async onClose(session: Session, error: Error | undefined): Promise<void> {
    const { clinicId } = session;
    // Only retire the map entry if it is still *this* socket. A close event
    // that arrives after a newer socket has already been published for the
    // clinic must not evict the live one and leave it orphaned.
    if (this.sessions.get(clinicId) === session) this.sessions.delete(clinicId);
    // `closing` covers a teardown this manager is running right now; the token
    // check covers one that has already finished — including a logout that
    // completed while this socket was still on its way down. Neither may
    // reconnect, and neither may write to the row.
    if (session.closing || this.shuttingDown || !this.isCurrent(session.token)) return;

    const statusCode =
      error instanceof Boom ? error.output?.statusCode : (error as { output?: { statusCode?: number } })?.output?.statusCode;

    // WhatsApp says this device is gone: the clinic unlinked it from the phone,
    // or the identity was invalidated. Nothing can be recovered without a new
    // scan, so the stored identity is destroyed rather than retried.
    if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
      await this.tearDown(clinicId, "logged_out");
      return;
    }

    // Baileys asks for a clean restart after pairing completes.
    if (statusCode === DisconnectReason.restartRequired) {
      await this.open(session.token, {
        qrRounds: session.qrRounds,
        qrlessRounds: 0,
        reconnectAttempts: 0,
        revalidateOwnership: true,
      });
      return;
    }

    const paired = Boolean(session.auth.state.creds.registered);

    // Nobody scanned in time. Offer a few more codes before giving up, so a
    // clinic that fetched their phone mid-way is not sent back to the card.
    if (!paired) {
      // Two very different situations reach here, and treating them alike is
      // what let a refused registration masquerade as a slow clinic. A socket
      // that showed at least one code closed because the code expired unscanned;
      // one that showed none never got as far as `pair-device`, and reopening it
      // will reproduce the refusal exactly. Only the first is worth retrying
      // five times, and neither may be retried silently.
      const qrlessRounds = session.qrRounds === 0 ? session.qrlessRounds + 1 : 0;
      logger.warn(
        { clinicId, statusCode, qrRounds: session.qrRounds, qrlessRounds },
        session.qrRounds === 0
          ? "socket closed before WhatsApp issued a code"
          : "code expired unscanned",
      );
      const exhausted =
        session.qrRounds === 0 ? qrlessRounds >= MAX_QRLESS_ROUNDS : session.qrRounds >= MAX_QR_ROUNDS;
      if (exhausted) {
        await this.tearDown(clinicId, "pairing_failed");
        return;
      }
      await this.guarded(session.token, () =>
        this.store.setStatus(clinicId, "starting", { qr_payload: null, qr_expires_at: null }),
      );
      await this.open(session.token, {
        qrRounds: session.qrRounds,
        qrlessRounds,
        reconnectAttempts: 0,
        revalidateOwnership: true,
      });
      return;
    }

    // An established pairing that dropped: keep trying, with backoff. The
    // clinic stays "connected" in the UI only while it really is.
    const attempts = session.reconnectAttempts + 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
    const marked = await this.guarded(session.token, () =>
      this.store.setStatus(clinicId, "connecting", { qr_payload: null, qr_expires_at: null }),
    );
    // Logged out while the drop was being written up. No reconnect is scheduled:
    // a pairing the clinic has ended is not one to keep dialling.
    if (!marked.ran) return;
    logger.warn({ clinicId, statusCode, attempts, delay }, "session dropped; reconnecting");
    const timer = setTimeout(() => {
      this.reconnects.delete(clinicId);
      // `cancelReconnect` already clears this timer on logout; the token check is
      // the one that holds when the logout lands between the timer firing and
      // this callback running.
      if (this.shuttingDown || this.sessions.has(clinicId) || !this.isCurrent(session.token)) return;
      void this.open(session.token, {
        qrRounds: 0,
        qrlessRounds: 0,
        reconnectAttempts: attempts,
        // The gap this timer just waited out is the whole reason ownership has
        // to be proven again: a suspended laptop resumes here, with a backoff
        // that expired while Railway was adopting the clinic.
        revalidateOwnership: true,
      }).catch(
        (openError: unknown) => {
          logger.error({ clinicId, err: openError }, "reconnect failed");
        },
      );
    }, delay);
    // The session is no longer in `sessions` — it is waiting to be reopened —
    // so the pending reconnect is tracked separately or nothing could cancel
    // it on shutdown or on a deliberate logout.
    this.reconnects.set(clinicId, timer);
  }

  /** This clinic's retry-repair cache, created on first use and kept across reconnects. */
  private sentCache(clinicId: string): SentMessageCache {
    const existing = this.sentMessages.get(clinicId);
    if (existing) return existing;
    const created = new SentMessageCache();
    this.sentMessages.set(clinicId, created);
    return created;
  }

  /**
   * Throws away a socket that came up for a start nobody is waiting for.
   *
   * `end()` rather than `logout()`: this connection was never published, never
   * wired to a handler and never wrote anything, so there is nothing to undo on
   * the phone — and in the cancellation case the clinic's own logout has already
   * unlinked the device. Failures are logged and swallowed, because the socket is
   * being abandoned either way.
   */
  private discard(clinicId: string, socket: WASocket, reason: "shutdown" | "cancelled"): void {
    try {
      socket.end(undefined);
    } catch (error) {
      logger.warn({ clinicId, reason, ...describeError(error) }, "could not close discarded socket");
      return;
    }
    logger.info({ clinicId, reason }, "discarded socket for a start that no longer applies");
  }

  /** Drops any reconnect queued for a clinic that no longer wants one. */
  private cancelReconnect(clinicId: string): void {
    const timer = this.reconnects.get(clinicId);
    if (!timer) return;
    clearTimeout(timer);
    this.reconnects.delete(clinicId);
  }

  /** Ends a pairing for good and releases everything it held. */
  private async tearDown(clinicId: string, reason: SessionErrorCode): Promise<void> {
    // Same barrier the deliberate logout uses, for the same reason: a start
    // admitted moments ago may still be holding an auth state and a socket.
    this.invalidate(clinicId);
    this.cancelReconnect(clinicId);
    // The pairing is over, so there is no session left that could answer a retry
    // for anything it sent. Holding the plaintext any longer serves nothing.
    this.sentMessages.delete(clinicId);
    await this.quiesce(clinicId);
    await this.releaseIdentity(clinicId, reason);
    await this.store.setStatus(clinicId, reason === "logged_out" ? "disconnected" : "error", {
      desired_state: "offline",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: null,
      connected_at: null,
      last_error: reason,
    });
    logger.info({ clinicId, reason }, "session ended");
  }

  /**
   * Destroys the stored device identity and releases the channel.
   *
   * Both failures used to be swallowed whole. That is how the reported bug went
   * unseen for as long as it did: a `clearAuth` that deleted nothing, or one that
   * deleted rows a stale start then re-created, looked exactly like a clean
   * teardown from the outside. Both are now reported — with the redaction
   * `describeError` documents — and both are still non-fatal, because a clinic
   * must never be left unable to finish unlinking because one delete failed.
   */
  private async releaseIdentity(clinicId: string, reason: SessionErrorCode): Promise<void> {
    await this.store.clearAuth(clinicId).catch((error: unknown) => {
      logger.error(
        { clinicId, reason, stage: "clear_auth", ...describeError(error) },
        "could not destroy stored device identity during teardown",
      );
    });
    await this.store.removeChannel(clinicId).catch((error: unknown) => {
      logger.error(
        { clinicId, reason, stage: "remove_channel", ...describeError(error) },
        "could not release the WhatsApp channel during teardown",
      );
    });
  }

  private async fail(session: Session, reason: SessionErrorCode): Promise<void> {
    // Guarded like every other write on this path: `onOpen` reaches here across
    // an await, and a socket that failed to identify itself must not stamp
    // `error` over the `disconnected` a logout has meanwhile written.
    await this.guarded(session.token, () =>
      this.store.setStatus(session.clinicId, "error", {
        desired_state: "offline",
        qr_payload: null,
        qr_expires_at: null,
        last_error: reason,
      }),
    );
  }

  /**
   * Whether this socket still speaks for its clinic.
   *
   * One question, asked at the top of every event handler: has the clinic's
   * epoch moved past the token this socket captured? It moves on a logout, on a
   * teardown, and — the case this exists for — when the heartbeat discovers the
   * clinic has been reclaimed by another worker. WhatsApp goes on delivering to
   * a socket for as long as the TCP connection survives, and `end()` is not
   * instantaneous, so a fenced session can still be handed messages, receipts
   * and history for a short while after this worker has stopped owning it.
   * Processing any of them would double-deliver into a clinic another worker is
   * already serving.
   */
  private fenced(session: Session): boolean {
    return session.closing || !this.isCurrent(session.token);
  }

  /**
   * Everything the paired device receives, on its way to the clinic's inbox.
   *
   * Both upsert types are carried. `notify` is a message that arrived while the
   * socket was up; `append` is one WhatsApp had queued for a device it considered
   * offline and flushed on the handshake — which is every message a patient sent
   * during a redeploy or a reconnect. Refusing `append` (as this did) meant those
   * messages were decrypted, acknowledged to WhatsApp, and then dropped on the
   * floor. Bulk history does not arrive here at all, so nothing is replayed by
   * accepting it; `interpretMessage` additionally bounds how stale a flushed
   * message may be, and the application dedupes on the provider message id.
   */
  private async onMessages(
    session: Session,
    upsert: { type: string; messages: WAMessage[] },
  ): Promise<void> {
    if (this.fenced(session)) return;
    if (!session.phone || !session.authenticatedAccountId) {
      logger.warn(
        { clinicId: session.clinicId, upsertType: upsert.type, count: upsert.messages.length },
        "inbound batch arrived before the session was identified",
      );
      return;
    }
    const events: CallbackEvent[] = [];
    /** Files to fetch once the whole batch has been classified. */
    const pendingMedia: Array<{
      event: Extract<CallbackEvent, { kind: "inbound" }>;
      message: WAMessage;
      media: InterpretedMedia;
    }> = [];
    for (const message of upsert.messages) {
      const interpreted = interpretMessage({
        upsertType: upsert.type,
        message,
        directory: session.lids,
        names: session.names,
      });
      if (interpreted.outcome === "event") {
        events.push(interpreted.event);
        if (interpreted.media && interpreted.event.kind === "inbound") {
          pendingMedia.push({
            event: interpreted.event,
            message,
            media: interpreted.media,
          });
        }
        // The address space a carried message actually arrived on, and how its
        // number was established. This is what answers "why does this
        // conversation never route by LID?" from the worker's own logs rather
        // than from assumption: a chat that only ever reports
        // `jidKind: "pn", counterpartySource: "chat_jid"` is being conducted in
        // the phone-number address space, so there is no LID for WhatsApp to
        // have asserted and none to be found. Debug level — this is one line per
        // message and it is a diagnostic, not an event.
        logger.debug(
          { clinicId: session.clinicId, ...interpreted.diagnostic },
          "message carried",
        );
        continue;
      }
      // Deliberately shaped so it can be read in production: the address *space*
      // of the chat, the upsert type, the direction, and whether anything
      // renderable was found. No JID, no number, no message body.
      const diagnostic = {
        clinicId: session.clinicId,
        reason: interpreted.reason,
        ...interpreted.diagnostic,
      };
      // P15 (§4) — a live direct message we cannot name the sender of is not
      // a message to throw away. It is parked and replayed the moment WhatsApp
      // asserts the pairing; see `Session.pendingUnresolved`.
      if (
        interpreted.reason === "unresolved_counterparty" &&
        this.parkUnresolved(session, upsert.type, message)
      ) {
        logger.info(diagnostic, "direct message parked pending identity");
        continue;
      }
      // A group or a status update is not a fault; a direct chat we could not
      // route is.
      if (interpreted.reason === "not_direct_chat") logger.debug(diagnostic, "message not carried");
      else logger.warn(diagnostic, "direct message dropped");
    }
    await this.flushLidMappings(session);
    // Anything this batch just taught the directory may be the assertion an
    // earlier parked message was waiting for. Drained before delivery so a
    // patient's first two messages reach the inbox in the order they were
    // written rather than in the order their identities happened to resolve.
    events.unshift(...this.drainUnresolved(session, pendingMedia));
    // Files are fetched before the batch is handed over, so an attachment and
    // the message it belongs to reach the inbox together rather than the file
    // arriving after staff have already read the text. A download that fails
    // still produces an attachment record, so the message is never held back by
    // one that could not be retrieved.
    await this.ingestMedia(session, pendingMedia);
    await this.deliver(session, events);
  }

  /**
   * P15 (§4) — holds a live direct message whose sender WhatsApp has not named.
   *
   * Returns false, and the caller drops the message as before, when there is
   * nothing to wait *for*: a historical/offline-flushed stanza (the history
   * import has its own identity reconciliation and its own pending tables), or
   * a chat that is not LID-addressed and therefore has no pairing to resolve.
   *
   * Only the live path parks. That distinction matters: parking history here
   * would duplicate the durable pending-history machinery in memory, and an
   * in-memory buffer is the wrong home for a year of messages.
   */
  private parkUnresolved(
    session: Session,
    upsertType: string,
    message: WAMessage,
  ): boolean {
    // Only genuinely live traffic. `notify` is a message that arrived while the
    // socket was up; anything else is a flush or a replay whose own path
    // already handles identity.
    if (upsertType !== "notify") return false;
    const lid = canonicalLidJid(message.key.remoteJid);
    if (!lid) return false;
    const now = Date.now();
    // Evict expired entries before measuring, so a long-idle buffer of dead
    // entries cannot refuse a live message.
    session.pendingUnresolved = session.pendingUnresolved.filter(
      (entry) => now - entry.parkedAt < UNRESOLVED_BUFFER_TTL_MS,
    );
    // Same message twice (a retry, a duplicate delivery) parks once. The
    // application dedupes on provider message id as well, so this is belt and
    // braces — but replaying the same stanza twice would also download the
    // same attachment twice, which is worth not doing.
    const providerMessageId = message.key.id;
    if (
      providerMessageId &&
      session.pendingUnresolved.some((entry) => entry.message.key.id === providerMessageId)
    ) {
      return true;
    }
    if (session.pendingUnresolved.length >= UNRESOLVED_BUFFER_LIMIT) {
      // Oldest first. A buffer at its limit is already a fault worth seeing.
      session.pendingUnresolved.shift();
      logger.warn(
        { clinicId: session.clinicId, limit: UNRESOLVED_BUFFER_LIMIT },
        "unresolved inbound buffer full; oldest message discarded",
      );
    }
    session.pendingUnresolved.push({ lid, upsertType, message, parkedAt: now });
    return true;
  }

  /**
   * P15 (§4) — replays every parked message whose sender is now known.
   *
   * Re-interprets rather than reconstructing: the parked stanza goes back
   * through `interpretMessage` with the *same* directory, so a message that
   * resolves now produces exactly the event it would have produced had the
   * assertion arrived first — the same body extraction, the same media
   * detection, the same display-name precedence, the same staleness bound. The
   * replay path and the first-time path are therefore one path, which is the
   * only way they stay in agreement.
   *
   * `staleAfterMs: null`: the message was live when it arrived, and it is the
   * TTL above — not the offline-flush bound — that decides how long it may
   * wait. Applying the flush bound here would be measuring the wrong thing.
   *
   * Entries past their TTL are dropped here with a diagnostic, so the buffer
   * empties even on a session that never resolves anything.
   */
  private drainUnresolved(
    session: Session,
    pendingMedia: Array<{
      event: Extract<CallbackEvent, { kind: "inbound" }>;
      message: WAMessage;
      media: InterpretedMedia;
    }>,
  ): CallbackEvent[] {
    if (session.pendingUnresolved.length === 0) return [];
    const now = Date.now();
    const events: CallbackEvent[] = [];
    const kept: Session["pendingUnresolved"] = [];
    for (const entry of session.pendingUnresolved) {
      if (now - entry.parkedAt >= UNRESOLVED_BUFFER_TTL_MS) {
        logger.warn(
          { clinicId: session.clinicId, reason: "unresolved_counterparty_expired" },
          "direct message dropped",
        );
        continue;
      }
      if (!session.lids.lookup(entry.lid)) {
        kept.push(entry);
        continue;
      }
      const interpreted = interpretMessage({
        upsertType: entry.upsertType,
        message: entry.message,
        directory: session.lids,
        names: session.names,
        staleAfterMs: null,
      });
      if (interpreted.outcome !== "event") {
        logger.warn(
          { clinicId: session.clinicId, reason: interpreted.reason, ...interpreted.diagnostic },
          "parked message dropped after identity resolved",
        );
        continue;
      }
      events.push(interpreted.event);
      if (interpreted.media && interpreted.event.kind === "inbound") {
        pendingMedia.push({
          event: interpreted.event,
          message: entry.message,
          media: interpreted.media,
        });
      }
      logger.info(
        { clinicId: session.clinicId, ...interpreted.diagnostic },
        "parked message carried after identity resolved",
      );
    }
    session.pendingUnresolved = kept;
    return events;
  }

  /**
   * P15 (§4) — drains the parked buffer outside a message batch.
   *
   * Same pipeline as the in-batch drain, media fetch included, so a parked
   * photo reaches the inbox with its file rather than as a bare caption.
   */
  private async releaseParkedMessages(session: Session): Promise<void> {
    if (session.pendingUnresolved.length === 0) return;
    if (this.fenced(session)) return;
    const pendingMedia: Array<{
      event: Extract<CallbackEvent, { kind: "inbound" }>;
      message: WAMessage;
      media: InterpretedMedia;
    }> = [];
    const events = this.drainUnresolved(session, pendingMedia);
    if (events.length === 0) return;
    await this.ingestMedia(session, pendingMedia);
    await this.deliver(session, events);
  }

  /**
   * Downloads the files on a batch of inbound messages, a few at a time, and
   * hangs the resulting records off the events they belong to.
   *
   * Bounded concurrency rather than `Promise.all`: a patient sending a dozen
   * photos at once must not open a dozen simultaneous media transfers on a
   * socket that also has to stay responsive to WhatsApp.
   */
  private async ingestMedia(
    session: Session,
    pending: ReadonlyArray<{
      event: Extract<CallbackEvent, { kind: "inbound" }>;
      message: WAMessage;
      media: InterpretedMedia;
    }>,
  ): Promise<void> {
    if (pending.length === 0) return;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MEDIA_CONCURRENCY, pending.length) },
      async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const item = pending[index];
          if (!item) return;
          const attachment = await ingestAttachment({
            clinicId: session.clinicId,
            message: item.message,
            content: item.media.content,
            mediaType: item.media.type,
            maxBytes: this.config.attachmentMaxBytes,
            upload: (input) => this.store.uploadAttachment(input),
            download: this.downloadMedia ?? ((message) =>
              downloadMediaMessage(message, "buffer", {}, {
                reuploadRequest: (staleMessage) => session.socket.updateMediaMessage(staleMessage),
                // Baileys' default re-upload line includes `message.key`, which
                // contains a JID. Our explicit stage diagnostic below replaces
                // it, so this internal logger must remain silent.
                logger: keyStoreLogger,
              })),
            diagnostic: (diagnostic) => {
              const failed = diagnostic.stage.endsWith("_failed");
              logger[failed ? "warn" : "info"](
                diagnostic,
                "inbound media pipeline",
              );
            },
          });
          item.event.attachments = [attachment];
        }
      },
    );
    await Promise.all(workers);
  }

  /**
   * The phone's history push, on its way into the clinic's inbox.
   *
   * Three properties make this safe to run on every link, including a reconnect
   * that happens to receive a second sync:
   *
   *   * **Idempotent by construction.** Every carried message keeps its WhatsApp
   *     message id, and the application persists on the same unique
   *     (clinic, provider_message_id) index the live path uses. A message that
   *     history and live traffic both deliver collapses onto one row, whichever
   *     arrives first.
   *   * **Inert side effects.** Historical events are flagged, and the
   *     application persists them without opening a service window, reopening a
   *     closed thread, notifying staff, or waking the patient agent. Importing a
   *     year of chat must not send a year of replies.
   *   * **Live traffic is unaffected.** This runs on its own event, on the same
   *     socket, and holds nothing the message path needs.
   */
  private async onHistory(session: Session, batch: HistoryBatch): Promise<void> {
    const { clinicId } = session;
    if (this.fenced(session)) return;
    if (!session.phone || !session.authenticatedAccountId) {
      // Bounded, so a phone that pushes history to a socket that never finishes
      // opening cannot grow this without limit.
      if (session.pendingHistory.length < MAX_QUEUED_HISTORY_BATCHES) {
        session.pendingHistory.push(batch);
      }
      return;
    }

    if (!session.history.started) {
      session.history.started = true;
      await this.store.beginHistoryImport(clinicId).catch(() => undefined);
    }

    // The initial sync may contain a bounded contacts snapshot before any live
    // `contacts.upsert` event fires. Persist what WhatsApp actually supplies;
    // Baileys does not promise a complete phone address book.
    await this.persistContacts(session, batch.contacts ?? []).catch(() => undefined);

    const interpreted = interpretHistoryBatch({
      batch,
      directory: session.lids,
      names: session.names,
      inboundActiveFrom: session.inboundActiveFrom,
    });

    const assertedMappings = interpreted.events
      .filter((event): event is Extract<CallbackEvent, { kind: "history_identity" }> =>
        event.kind === "history_identity")
      .map((event) => ({ lid: event.lid, phone: event.participant }));
    if (session.authenticatedAccountId) {
      await this.store
        .upsertLidMappings(clinicId, session.authenticatedAccountId, assertedMappings)
        .catch(() => undefined);
    }

    // Shape only: how many threads and messages, how many were refused and why.
    // No JID, no number, no name, no body.
    logger.info(
      {
        clinicId,
        chats: interpreted.chats,
        messages: interpreted.messages,
        skippedChats: interpreted.skippedChats,
        unresolvedChats: interpreted.unresolvedChats,
        pendingMessages: interpreted.pendingMessages,
        unsupportedMessages: interpreted.unsupportedMessages,
        isLatest: Boolean(batch.isLatest),
      },
      "history batch interpreted",
    );

    // Durability before delivery. Everything interpreted here is written to the
    // spool first, so a timeout, a 5xx, a Vercel cold start or this process
    // dying mid-post leaves a row the next drain picks up — instead of losing a
    // slice of an import that WhatsApp only ever sends once.
    const enqueued = await this.enqueueHistory(session, interpreted.events);
    if (batch.isLatest) {
      // Only the *fact* that the phone has finished pushing. Whether the import
      // is complete is computed from the spool (see record_whatsapp_history_
      // delivery), so a fast final batch cannot overtake a slow earlier one.
      await this.store
        .recordHistoryDelivery({ clinicId, finalBatchSeen: true })
        .catch((error: unknown) => {
          logger.error({ clinicId, err: error }, "history final-batch marker failed");
        });
    }
    if (enqueued === 0 && !batch.isLatest) return;
    await this.drainHistory(session);
  }

  /** Learns reported contact labels without treating them as patients. */
  private async persistContacts(
    session: Session,
    contacts: ReadonlyArray<Partial<Contact>>,
  ): Promise<void> {
    if (!session.authenticatedAccountId) return;
    const learned: Array<{ participantAddress: string; displayName: string | null }> = [];
    for (const contact of contacts) {
      session.lids.remember(contact.lid, contact.id);
      session.names.rememberContact(contact, session.lids);
      const phone =
        phoneFromJid((contact as { jid?: string | null }).jid) ??
        phoneFromJid(contact.id) ??
        session.lids.lookup(contact.lid) ??
        session.lids.lookup(contact.id);
      if (!phone) continue;
      const displayName = session.names
        .lookup(phone)
        ?.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
        .trim() || null;
      learned.push({ participantAddress: phone, displayName });
    }
    if (learned.length === 0) return;
    try {
      await this.store.upsertContacts(
        session.clinicId,
        session.authenticatedAccountId,
        learned,
      );
      await this.flushLidMappings(session);
      // A contact record naming both spellings of one identity is the other
      // out-of-band assertion a parked message can be waiting on.
      await this.releaseParkedMessages(session);
    } catch {
      logger.error(
        { clinicId: session.clinicId, count: learned.length },
        "contact labels could not be persisted",
      );
      throw new Error("CONTACT_PERSIST_FAILED");
    }
  }

  /**
   * Persists newly asserted pairs and asks the application to reconcile any
   * history it is holding for those opaque LIDs. Once a history import has
   * started, the notification itself rides the durable spool.
   */
  private async flushLidMappings(session: Session): Promise<void> {
    const mappings = session.lids.takeNewMappings();
    if (mappings.length === 0 || !session.phone || !session.authenticatedAccountId) return;
    await this.store.upsertLidMappings(
      session.clinicId,
      session.authenticatedAccountId,
      mappings,
    );
    const events: CallbackEvent[] = mappings.map((mapping) => ({
      kind: "history_identity",
      lid: mapping.lid,
      participant: mapping.phone,
    }));
    if (session.history.started) {
      const enqueued = await this.enqueueHistory(session, events);
      if (enqueued > 0) await this.drainHistory(session);
    } else {
      await this.deliver(session, events);
    }
  }

  /**
   * Writes one interpreted payload into the durable delivery spool.
   *
   * The batch key is a digest of the batch's own events scoped to the
   * authenticated account (see {@link historyBatchKey}), which makes the enqueue
   * idempotent across restarts *within an account*: a phone that re-pushes the
   * same history to a reconnecting socket produces the same keys and adds no
   * rows, while an identical payload under a different account is its own batch.
   */
  private async enqueueHistory(session: Session, events: CallbackEvent[]): Promise<number> {
    if (events.length === 0 || !session.phone) return 0;
    // Fail closed. Every caller reaches here only after the account is bound, so
    // a missing identity is a bug in that ordering rather than a state to cope
    // with — and the one available fallback, the old account-less key, is
    // precisely what silently dropped this clinic's history. Spooling nothing
    // leaves the events undelivered and loud in the logs; spooling under the
    // legacy identity would lose them quietly.
    if (!session.authenticatedAccountId) {
      logger.error(
        { clinicId: session.clinicId, events: events.length },
        "history not spooled: no authenticated account bound to the session",
      );
      return 0;
    }
    const batches: Array<{ batchKey: string; payload: CallbackEvent[]; eventCount: number }> = [];
    for (let offset = 0; offset < events.length; offset += HISTORY_MAX_EVENTS_PER_POST) {
      const payload = events.slice(offset, offset + HISTORY_MAX_EVENTS_PER_POST);
      batches.push({
        batchKey: historyBatchKey({
          clinicId: session.clinicId,
          authenticatedAccountId: session.authenticatedAccountId,
          sessionPhone: session.phone,
          serializedPayload: JSON.stringify(payload),
        }),
        payload,
        eventCount: payload.length,
      });
    }
    try {
      return await this.store.enqueueHistoryBatches({
        clinicId: session.clinicId,
        sessionPhone: session.phone,
        batches,
      });
    } catch (error) {
      logger.error(
        { clinicId: session.clinicId, batches: batches.length, err: error },
        "history batches could not be spooled",
      );
      return 0;
    }
  }

  /**
   * Posts whatever the spool still holds for this clinic.
   *
   * One pass makes **one attempt per pending batch** and stops. It deliberately
   * does not sit in a retry loop: `postBatch` already exhausts its own bounded
   * attempts with backoff, and a batch the application is refusing right now is
   * not going to be persuaded by a tighter loop — it is going to be picked up by
   * the next pass, which the paced reconcile sweep runs, and which survives a
   * restart because the row does.
   *
   * Live message delivery does not go through here and is unaffected while this
   * runs.
   */
  private async drainHistory(session: Session): Promise<void> {
    const { clinicId } = session;
    // A pass already under way covers everything currently pending; wait for it
    // rather than racing it, then take a fresh pass for anything it left.
    const inFlight = this.draining.get(clinicId);
    if (inFlight) await inFlight.catch(() => undefined);
    const pass = this.runHistoryDrain(clinicId);
    this.draining.set(clinicId, pass);
    try {
      await pass;
    } finally {
      if (this.draining.get(clinicId) === pass) this.draining.delete(clinicId);
    }
  }

  private async runHistoryDrain(clinicId: string): Promise<void> {
    // A clinic the application is currently ignoring is left alone until its
    // deferral expires. Checked here rather than in the callers so every entry
    // into the spool — the boot drain, the paced sweep, an enqueue, a flushed
    // LID mapping — honours it.
    if (this.historyDeferred(clinicId)) return;
    // A drain is a long walk through a durable spool, one network round trip per
    // batch, and a clinic can change hands part-way through it. The epoch
    // captured here is what notices: `fenceLostOwnership` bumps it, and every
    // iteration below then hands its claimed batches back exactly as a shutdown
    // does. Nothing is lost — the rows are still pending, and the worker that
    // now owns the clinic drains them.
    const token = this.issueToken(clinicId);
    const stopped = () => this.shuttingDown || !this.isCurrent(token);
    const attempted = new Set<string>();
    for (let page = 0; page < HISTORY_DRAIN_PAGES; page += 1) {
      // A pass can be a thousand batches long and each batch is a network
      // round-trip, so a shutdown that only closed sockets would keep posting
      // history until the platform's failsafe killed the process. Nothing is
      // lost by stopping: every row this pass did not post is still pending, and
      // the page it was part-way through is handed back below.
      if (stopped()) return;
      const claimed = await this.store
        .claimHistoryBatches(clinicId, 5, [...attempted])
        .catch((error: unknown) => {
          logger.error({ clinicId, err: error }, "history batch claim failed");
          return [];
        });
      if (claimed.length === 0) return;
      for (const [index, row] of claimed.entries()) {
        if (stopped()) {
          // Everything this page claimed and did not post is put back now rather
          // than waiting out the stale window, so the next worker finds the
          // spool exactly as this one left it.
          await this.releaseClaims(clinicId, claimed.slice(index));
          return;
        }
        attempted.add(row.id);
        const events = row.payload as CallbackEvent[];
        const outcome = await this.callbacks.postHistoryBatch(clinicId, row.sessionPhone, events);
        // "Accepted but stored nothing", because this clinic has no active
        // linked-device channel. The batch is put back exactly as it was found —
        // not delivered, not attempted, still pending — and the rest of the pass
        // is abandoned: every remaining batch would get the same answer, and
        // walking the backlog to hear it hundreds more times is the loop this
        // guard exists to end.
        if (outcome.ignored) {
          await this.releaseClaims(clinicId, claimed.slice(index));
          this.deferHistory(clinicId);
          return;
        }
        // The counts come from the application's own answer — rows that exist —
        // never from what this worker parsed. Pending unresolved LID rows are
        // counted only when a later asserted mapping actually persists them.
        const progress = await this.store
          .recordHistoryDelivery({
            clinicId,
            batchId: row.id,
            delivered: outcome.ok,
            chats: outcome.summary?.historyChats ?? 0,
            messages:
              (outcome.summary?.inbound ?? 0) +
              (outcome.summary?.echoes ?? 0) +
              (outcome.summary?.historyReconciled ?? 0),
            error: outcome.error,
          })
          .catch((error: unknown) => {
            logger.error({ clinicId, err: error }, "history delivery bookkeeping failed");
            return null;
          });
        if (outcome.ok && outcome.summary) {
          const metrics = await this.store.recordHistoryMetrics({
            clinicId,
            batchId: row.id,
            chatsReceived: outcome.summary.historyChatsReceived,
            messagesReceived: outcome.summary.historyMessagesReceived,
            deduplicated:
              outcome.summary.replays + outcome.summary.historyDeduplicated,
            unsupported: outcome.summary.historyUnsupported,
          }).catch((error: unknown) => {
            logger.error({ clinicId, err: error }, "history metrics bookkeeping failed");
            return null;
          });
          logger.info({
            clinicId,
            receivedChats: outcome.summary.historyChatsReceived,
            receivedMessages: outcome.summary.historyMessagesReceived,
            persistedMessages:
              outcome.summary.inbound + outcome.summary.echoes + outcome.summary.historyReconciled,
            deduplicatedMessages:
              outcome.summary.replays + outcome.summary.historyDeduplicated,
            pendingMessages: metrics?.pending ?? outcome.summary.historyPending,
            unsupportedMessages: outcome.summary.historyUnsupported,
          }, "history batch persisted");
        }
        if (!outcome.ok) {
          logger.error(
            {
              clinicId,
              events: events.length,
              reason: outcome.error,
              pending: progress?.pending ?? null,
              failed: progress?.failed ?? null,
            },
            "history batch not accepted",
          );
        }
      }
    }
  }

  /**
   * Hands back rows this pass claimed but is not going to post.
   *
   * The claim would lapse on its own after the database's stale window, so this
   * is not what makes the rows safe — it is what stops a spool sitting falsely
   * claimed for five minutes by a worker that has already walked away from it,
   * which is the difference between a clinic recovering on the next sweep and a
   * clinic recovering on the one after that. A release that fails is logged and
   * shrugged off for the same reason.
   */
  private async releaseClaims(
    clinicId: string,
    rows: ReadonlyArray<{ id: string }>,
  ): Promise<void> {
    for (const row of rows) {
      await this.store.releaseHistoryClaim(clinicId, row.id).catch((error: unknown) => {
        logger.warn({ clinicId, err: error }, "history batch claim could not be released");
      });
    }
  }

  /**
   * Whether this clinic's spool is inside a deferral window right now.
   *
   * Expiry is read, not swept: an entry that has passed is dropped on the way
   * out, so the map holds at most one entry per clinic and nothing has to run on
   * a timer to keep it that way.
   */
  private historyDeferred(clinicId: string): boolean {
    const until = this.historyDeferrals.get(clinicId);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.historyDeferrals.delete(clinicId);
      return false;
    }
    return true;
  }

  /** Holds this clinic's spool back, and says so exactly once per window. */
  private deferHistory(clinicId: string): void {
    const already = this.historyDeferred(clinicId);
    this.historyDeferrals.set(clinicId, Date.now() + HISTORY_IGNORED_DEFER_MS);
    if (already) return;
    logger.warn(
      { clinicId, deferredForMs: HISTORY_IGNORED_DEFER_MS },
      "history spool deferred: the application is ignoring this clinic's history, which means it has no active linked-device channel. Nothing was discarded — the batches stay pending and drain once the clinic is linked again",
    );
  }

  /** Lets a reconnected clinic's spool move again without waiting out the timer. */
  private resumeHistory(clinicId: string): void {
    if (this.historyDeferrals.delete(clinicId)) {
      logger.info({ clinicId }, "history spool resumed after the session reconnected");
    }
  }

  /**
   * Restart safety: a spool row outlives the process that wrote it, so every
   * clinic with undelivered history is drained again on boot and on the paced
   * sweep — including clinics whose socket is not currently up, whose batches
   * still belong to the number they were captured on.
   */
  async drainPendingHistory(): Promise<void> {
    const clinics = await this.store.listClinicsWithPendingHistory().catch((error: unknown) => {
      logger.error({ err: error }, "pending history lookup failed");
      return [] as string[];
    });
    for (const clinicId of clinics) {
      const session = this.sessions.get(clinicId);
      // A session row is not required: the spool carries the phone each batch was
      // captured on, so an unopened socket is not a reason to hold data hostage.
      await this.drainHistory(session ?? ({ clinicId } as Session));
    }
  }

  private async onReceipts(
    session: Session,
    updates: Array<{ key: { id?: string | null; fromMe?: boolean | null }; update: { status?: number | null } }>,
  ): Promise<void> {
    if (this.fenced(session)) return;
    if (!session.phone || !session.authenticatedAccountId) return;
    const events: CallbackEvent[] = [];
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || typeof update.status !== "number") continue;
      // Baileys reports WhatsApp's own message status enum.
      const status =
        update.status >= 4 ? "read" : update.status === 3 ? "delivered" : update.status === 2 ? "sent" : null;
      if (!status) continue;
      events.push({
        kind: "status",
        providerMessageId: key.id,
        status,
        occurredAt: new Date().toISOString(),
      });
    }
    await this.deliver(session, events);
  }

  private async deliver(session: Session, events: CallbackEvent[]): Promise<void> {
    if (events.length === 0 || !session.phone) return;
    const delivered = await this.callbacks.post(session.clinicId, session.phone, events);
    if (!delivered) {
      logger.error({ clinicId: session.clinicId, count: events.length }, "callback rejected");
    }
  }

  /**
   * "Sync WhatsApp history" — an explicit, bounded, account-scoped request for
   * older messages on a device that is already paired.
   *
   * Deliberately an *action*, not a reconnect side effect. WhatsApp pushes
   * history once, at link time; a reconnecting device gets `RECENT` or nothing,
   * and forcing a request on every reconnect would spend the account's peer-
   * message budget on a question the phone has usually already answered.
   *
   * What it does **not** do, because every one of these was a stated
   * requirement and each is enforced above rather than assumed:
   *
   *   - no logout, no `socket.logout()`, no auth mutation, no re-registration;
   *   - nothing at all without a bound `authenticatedAccountId`;
   *   - no anchor from outside that account — {@link Store.loadHistoryResyncAnchors}
   *     filters on `conversations.whatsapp_account_id`;
   *   - no legacy adoption: account-less conversations are not candidates;
   *   - no work for a fenced session, so a clinic this worker has lost cannot
   *     be spoken for.
   *
   * The answer arrives asynchronously on `messaging-history.set` with
   * `syncType: ON_DEMAND`, so it enters the existing account-scoped spool under
   * the existing account-scoped batch key, keeps `ingestion_origin=history_sync`
   * and the P11R `inbound_active_from` boundary, and replays idempotently.
   */
  async resyncHistory(clinicId: string): Promise<HistoryResyncOutcome> {
    const session = this.sessions.get(clinicId);
    if (!session) return { ok: false, code: "NO_SESSION" };
    if (this.fenced(session)) return { ok: false, code: "NO_SESSION" };
    if (!session.phone || !session.authenticatedAccountId) {
      return { ok: false, code: "NOT_CONNECTED" };
    }
    const fetchMessageHistory = (
      session.socket as unknown as {
        fetchMessageHistory?: (
          count: number,
          oldestMsgKey: { remoteJid: string; id: string; fromMe: boolean },
          oldestMsgTimestamp: number,
        ) => Promise<string>;
      }
    ).fetchMessageHistory;
    // A build of Baileys without the on-demand API says so rather than being
    // approximated with something else.
    if (typeof fetchMessageHistory !== "function") return { ok: false, code: "UNSUPPORTED" };
    if (this.historyResyncing.has(clinicId)) return { ok: false, code: "IN_PROGRESS" };
    const last = this.historyResyncAt.get(clinicId) ?? 0;
    if (Date.now() - last < HISTORY_RESYNC_COOLDOWN_MS) return { ok: false, code: "COOLDOWN" };

    this.historyResyncing.add(clinicId);
    try {
      const account = session.authenticatedAccountId;
      const anchors = await this.store
        .loadHistoryResyncAnchors(clinicId, account)
        .catch((error: unknown) => {
          logger.error({ clinicId, ...describeError(error) }, "history resync anchors unavailable");
          return [] as Awaited<ReturnType<Store["loadHistoryResyncAnchors"]>>;
        });
      const plan = planHistoryResync({
        anchors,
        maxChats: HISTORY_RESYNC_MAX_CHATS,
        messagesPerChat: HISTORY_RESYNC_MESSAGES_PER_CHAT,
      });
      if (plan.length === 0) {
        // The honest answer for an inbox with nothing to extend backwards from.
        logger.info(
          { clinicId, stage: "history_resync_no_anchors", candidates: anchors.length },
          "history resync",
        );
        return { ok: false, code: "NO_ANCHORS" };
      }
      // Visible in the clinic's own status for the duration, the same way the
      // link-time import is. Counters stay the application's to compute.
      await this.store.beginHistoryImport(clinicId).catch(() => undefined);
      session.history.started = true;

      let requested = 0;
      for (const request of plan) {
        // Ownership can change mid-run: a fenced session must stop asking
        // WhatsApp for history on behalf of a clinic it no longer serves.
        if (this.shuttingDown || this.fenced(session)) break;
        try {
          await fetchMessageHistory(request.count, request.key, request.timestampMs);
          requested += 1;
        } catch (error) {
          logger.warn(
            { clinicId, ...describeError(error) },
            "history resync request refused by WhatsApp",
          );
        }
        if (HISTORY_RESYNC_SPACING_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, HISTORY_RESYNC_SPACING_MS));
        }
      }
      this.historyResyncAt.set(clinicId, Date.now());
      // Shape only — how many conversations were asked about, never which.
      logger.info(
        {
          clinicId,
          stage: "history_resync_requested",
          chats: plan.length,
          requested,
          messagesPerChat: HISTORY_RESYNC_MESSAGES_PER_CHAT,
        },
        "history resync",
      );
      return { ok: true, requested, chats: plan.length };
    } finally {
      this.historyResyncing.delete(clinicId);
    }
  }

  /** Sends one text or storage-backed media message through this clinic's session. */
  async send(
    clinicId: string,
    recipient: string,
    input: string | OutboundSendRequest,
  ): Promise<SendOutcome> {
    const session = this.sessions.get(clinicId);
    if (!session) return { ok: false, code: "NO_SESSION" };
    // A session whose epoch has moved is one this worker has stopped speaking
    // for — a logout, or an ownership loss discovered on the last heartbeat.
    // Both delete it from `sessions`, so this only catches a caller holding a
    // handle from before that; it is cheap and it is the invariant, not an
    // optimisation.
    if (!this.isCurrent(session.token)) return { ok: false, code: "NO_SESSION" };
    if (!session.phone || !session.authenticatedAccountId) {
      return { ok: false, code: "NOT_CONNECTED" };
    }
    const digits = recipient.replace(/[^\d]/g, "");
    if (digits.length < 6 || digits.length > 20) return { ok: false, code: "INVALID_RECIPIENT" };
    const request = typeof input === "string" ? { body: input } : input;

    let content: AnyMessageContent;
    if (request.media) {
      const bytes = await this.store.downloadOutboundMedia({
        clinicId,
        bucket: request.media.bucket,
        storagePath: request.media.storagePath,
      });
      logger[bytes ? "info" : "error"](
        {
          clinicId,
          stage: bytes ? "storage_fetch_success" : "storage_fetch_failure",
          outcome: bytes ? "completed" : "failed",
          mediaKind: request.media.kind,
          bucket: request.media.bucket,
          ...(bytes ? { byteSize: bytes.length } : { reasonCode: "object_unavailable" }),
        },
        "outbound media diagnostic",
      );
      if (!bytes) return { ok: false, code: "MEDIA_STORAGE_FETCH_FAILED" };
      const caption = request.body.trim() || undefined;
      if (request.media.kind === "audio") {
        if (!request.media.voiceNote) return { ok: false, code: "MEDIA_TRANSCODE_FAILED" };
        logger.info(
          {
            event: "voice_outbound_validation_stage",
            clinicId,
            stage: "ffmpeg_started",
            outcome: "started",
            mediaKind: "audio",
            sourceByteCount: bytes.length,
          },
          "outbound media diagnostic",
        );
        try {
          const ogg = await this.transcodeVoice(bytes);
          logger.info(
            {
              event: "voice_outbound_validation_stage",
              clinicId,
              stage: "ffmpeg_completed",
              outcome: "completed",
              mediaKind: "audio",
              byteSize: ogg.length,
            },
            "outbound media diagnostic",
          );
          content = {
            audio: ogg,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          };
        } catch (error) {
          const knownReason = error instanceof Error && [
            "VOICE_TRANSCODE_TIMEOUT",
            "VOICE_TRANSCODE_TOO_LARGE",
            "VOICE_TRANSCODE_UNAVAILABLE",
            "VOICE_TRANSCODE_FAILED",
            "VOICE_VALIDATION_UNAVAILABLE",
            "VOICE_VALIDATION_TIMEOUT",
            "VOICE_SOURCE_VALIDATION_FAILED",
            "VOICE_SOURCE_INVALID_STREAM",
            "VOICE_SOURCE_INVALID_DURATION",
            "VOICE_SOURCE_SILENT_AUDIO",
            "VOICE_INVALID_STREAM",
            "VOICE_INVALID_DURATION",
            "VOICE_SILENT_AUDIO",
          ].includes(error.message)
            ? error.message.toLowerCase()
            : "voice_transcode_failed";
          logger.error(
            {
              event: "voice_outbound_validation_stage",
              clinicId,
              stage: "ffmpeg_failed",
              outcome: "failed",
              mediaKind: "audio",
              reasonCode: knownReason,
            },
            "outbound media diagnostic",
          );
          return { ok: false, code: "MEDIA_TRANSCODE_FAILED" };
        }
      } else if (request.media.kind === "image") {
        content = {
          image: bytes,
          mimetype: request.media.mimeType,
          ...(caption ? { caption } : {}),
        };
      } else {
        content = {
          document: bytes,
          mimetype: request.media.mimeType,
          fileName: request.media.fileName ?? "document",
          ...(caption ? { caption } : {}),
        };
      }
    } else {
      if (!request.body.trim()) return { ok: false, code: "SEND_FAILED" };
      content = { text: request.body };
    }

    // Which address space to use is decided from what WhatsApp has asserted on
    // this session, never from the shape of the number. See selectSendTarget.
    const target = selectSendTarget({
      phone: `+${digits}`,
      directory: session.lids,
      ownLid: session.socket.authState?.creds?.me?.lid ?? null,
      lidRoutingEnabled: this.config.outboundLidRouting,
    });

    // Deliberately shaped so it can be read in production. The address *kind*,
    // where the mapping came from, whether the send succeeded, and whether
    // WhatsApp gave us a message id — and nothing else. No JID, no phone number,
    // no message body, no key material.
    const diagnostic = {
      clinicId,
      addressKind: target.addressKind,
      mappingSource: target.mappingSource,
    };

    try {
      if (request.media) {
        logger.info(
          {
            ...diagnostic,
            stage: "baileys_media_send_started",
            outcome: "started",
            mediaKind: request.media.kind,
          },
          "outbound media diagnostic",
        );
      }
      // Last check before the message goes on the wire. Everything between the
      // lookup above and here is `await`: a storage fetch, an ffmpeg transcode,
      // a LID resolution — seconds during which a heartbeat tick may have
      // discovered that this clinic now belongs to another worker. Sending from
      // a fenced session is a duplicate message on a device this process no
      // longer owns, so the send is abandoned rather than raced.
      if (!this.isCurrent(session.token) || this.sessions.get(clinicId) !== session) {
        logger.warn({ clinicId }, "outbound send abandoned: this worker no longer owns the session");
        return { ok: false, code: "NO_SESSION" };
      }
      const sent = await session.socket.sendMessage(target.jid, content);
      const providerMessageId = sent?.key.id ?? null;
      // Retained *before* the caller is answered: a retry receipt for a message
      // the recipient could not decrypt can arrive almost immediately, and a
      // message missing from this cache is one that can never be repaired.
      //
      // `sent.key.id` is exactly the id that went out on the wire, not a
      // separate acknowledgement id: `sendMessage` generates it once
      // (`messageId: generateMessageIDV2(...)` into `generateWAMessage`), hands
      // that same `fullMsg.key.id` to `relayMessage` as `messageId`, and
      // `relayMessage` puts it on the stanza as `attrs.id`. The recipient's
      // retry receipt names that id, and `sendMessagesAgain` calls `getMessage`
      // with it. Keying the cache on it is therefore the whole contract.
      session.sent.remember(providerMessageId, sent?.message);
      logger.info(
        {
          ...diagnostic,
          outcome: "sent",
          hasProviderMessageId: providerMessageId !== null,
          // The join between this line and the retry-path lines. A hash, salted
          // per boot — see retry-diagnostics.ts.
          messageRef: messageRef(providerMessageId),
          retryCacheSize: session.sent.size,
        },
        "outbound message dispatched",
      );
      if (request.media) {
        logger.info(
          {
            ...diagnostic,
            stage: "baileys_media_send_completed",
            outcome: "completed",
            mediaKind: request.media.kind,
            hasProviderMessageId: providerMessageId !== null,
          },
          "outbound media diagnostic",
        );
      }
      return { ok: true, providerMessageId };
    } catch (error) {
      // Only the error's *class* and HTTP-ish status are logged. A Baileys send
      // failure frequently carries the recipient JID in its message and in the
      // Boom payload, so neither is included: an error object passed whole to
      // the logger here would defeat the rest of this redaction.
      logger.error(
        {
          ...diagnostic,
          outcome: "failed",
          errorName: error instanceof Error ? error.name : "unknown",
          statusCode:
            error instanceof Boom ? error.output?.statusCode : undefined,
        },
        "send failed",
      );
      if (request.media) {
        logger.error(
          {
            ...diagnostic,
            stage: "baileys_media_send_failed",
            outcome: "failed",
            mediaKind: request.media.kind,
            errorName: error instanceof Error ? error.name : "unknown",
            statusCode: error instanceof Boom ? error.output?.statusCode : undefined,
          },
          "outbound media diagnostic",
        );
      }
      return {
        ok: false,
        code: request.media ? "MEDIA_BAILEYS_SEND_FAILED" : "SEND_FAILED",
      };
    }
  }

  /**
   * Ends a clinic's pairing on request: WhatsApp is told to drop the linked
   * device, the stored identity is destroyed, and the channel is released.
   *
   * ## The race this is written against
   *
   * A logout does not only have to undo a *live* session. It also has to beat
   * one that is still being built. `start()` answers its caller as soon as the
   * intent is durable and then goes on opening the socket asynchronously, so
   * "status = starting, no socket yet" is a completely ordinary state for a
   * clinic to be in when the unlink button is pressed — and observed in
   * production: a `/start` sat in `starting` with no code, the `/logout` that
   * followed returned 200, and `whatsapp_linked_device_auth` was populated again
   * within the same second, by the admitted start reaching
   * `open()`'s `if (!auth.restored) await auth.saveCreds()`.
   *
   * Removing the `starting` entry cannot fix that, and neither can awaiting it:
   * the entry is a handle, not the work, and the work may be blocked in a
   * handshake that never returns. So the first thing this does — synchronously,
   * before a single cleanup statement runs — is bump the clinic's epoch. That
   * revokes the token every in-flight start, socket, handler, reconnect and auth
   * state is holding, in one step and with no await in the middle for a stale
   * start to slip through. From that instant the stale work can still *run*, but
   * it cannot save auth, publish a socket, claim a channel, write a QR, set
   * `desired_state` back to online, or schedule a reconnect.
   *
   * The one thing an epoch bump cannot undo is a store write that was already
   * in flight when it happened, so `quiesce()` waits for those — bounded, because
   * each is a single statement — before the cleanup below runs. After that
   * barrier, the deletes are the last word.
   */
  async logout(clinicId: string, reason: SessionErrorCode = "logged_out"): Promise<void> {
    // ---- Step 1: revoke, synchronously and atomically ----------------------
    this.invalidate(clinicId);
    this.cancelReconnect(clinicId);
    // The handle goes too, so the *next* `/start` builds a fresh one instead of
    // being handed the cancelled start's already-resolved outcome and never
    // opening a socket. This is the cheap half of the fix; the token above is
    // the half that actually holds.
    const cancelled = this.starting.get(clinicId);
    if (cancelled) {
      this.starting.delete(clinicId);
      logger.info({ clinicId }, "cancelled an in-flight start on logout");
    }
    const session = this.sessions.get(clinicId);
    if (session) {
      session.closing = true;
      this.sessions.delete(clinicId);
    }

    // ---- Step 2: let already-admitted writes land --------------------------
    await this.quiesce(clinicId);

    // ---- Step 3: unlink, then clean up -------------------------------------
    if (session) {
      // logout() unlinks the device on the phone; if it fails the local
      // teardown still runs so the clinic is never stuck.
      await session.socket.logout().catch((error: unknown) => {
        logger.warn(
          { clinicId, stage: "socket_logout", ...describeError(error) },
          "could not unlink the device on the phone; continuing with local teardown",
        );
      });
      session.socket.end(undefined);
      await this.tearDown(clinicId, reason);
      return;
    }

    // No live socket here — clean up whatever this clinic left behind anyway,
    // including a reconnect that would otherwise revive the pairing seconds
    // after the clinic asked for it to end, and the auth rows a start that never
    // reached a socket may have written.
    this.sentMessages.delete(clinicId);
    await this.releaseIdentity(clinicId, reason);
    await this.store.setStatus(clinicId, "disconnected", {
      desired_state: "offline",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: null,
      connected_at: null,
      last_error: null,
    });
    logger.info({ clinicId, reason }, "session logged out");
  }

  /**
   * Reports a claim this instance lost, and to whom.
   *
   * Never fatal and never on the pairing's critical path: the refusal has
   * already been decided by the time this runs, and a database that cannot
   * answer the follow-up read must not turn a clean 409 into a 500.
   */
  private async logRefusedClaim(clinicId: string): Promise<void> {
    const holder = await this.store.readSession(clinicId).catch(() => null);
    const heartbeatAgeMs = holder?.last_heartbeat_at
      ? Date.now() - new Date(holder.last_heartbeat_at).valueOf()
      : null;
    logger.warn(
      {
        clinicId,
        workerId: this.config.workerId,
        heldBy: holder?.worker_id ?? null,
        heartbeatAgeMs,
        sessionStatus: holder?.status ?? null,
        desiredState: holder?.desired_state ?? null,
        devTakeover: this.config.devTakeover,
      },
      "refused to start: this clinic's session is owned by another worker",
    );
  }

  /**
   * Records this instance's interest in a session somebody else is holding.
   *
   * Never called outside development takeover mode, and it takes nothing: the
   * holder keeps its socket, its stamp and its heartbeat, and the only thing
   * that changes is that its next heartbeat tick will see it has been asked.
   */
  private async askForHandoff(clinicId: string): Promise<void> {
    const asked = await this.store.requestHandoff(clinicId).catch((error: unknown) => {
      logger.warn({ clinicId, err: error }, "could not request session handoff");
      return false;
    });
    if (asked) {
      logger.info(
        { clinicId, workerId: this.config.workerId },
        "development takeover: asked the current owner to release this session",
      );
    }
  }

  /**
   * The liveness tick, and the ownership check that rides on it.
   *
   * Every 30 seconds this worker tells the database it is still holding the
   * clinics it has sockets for. The write is scoped to `worker_id = me`, so the
   * rows it *fails* to match are exactly the clinics somebody else has taken —
   * and until now that answer was thrown away, which left one real hole:
   *
   *   a developer's laptop owns a clinic; the lid closes and the process is
   *   frozen past the 90-second stale window; Railway legitimately adopts the
   *   clinic; the lid opens and the local worker resumes with a socket, a
   *   reconnect timer and an auth writer all still pointed at a linked device it
   *   no longer owns.
   *
   * Nothing in the old code stopped that worker until its next reconcile sweep
   * happened to notice, and reconcile never looked at sessions it was already
   * holding. So the resumed process could send, reconnect and — worst of all —
   * write Signal key material over the new owner's, which is the corruption the
   * single-owner invariant exists to prevent.
   *
   * The fix is this method: whatever the heartbeat did not renew is fenced at
   * once, synchronously and locally, before anything else on this tick runs.
   */
  async heartbeat(): Promise<void> {
    if (this.shuttingDown) return;
    const held = this.clinicIds();
    if (held.length === 0) return;
    const renewed = await this.store.heartbeat(held).catch((error: unknown) => {
      // A database that cannot answer is not evidence of anything: an outage
      // must not make a worker abandon clinics nobody has taken. Treat every
      // clinic as still ours and let the next tick decide.
      logger.warn({ err: error }, "heartbeat failed");
      return held;
    });
    const kept = new Set(renewed);
    for (const clinicId of held) {
      if (kept.has(clinicId)) continue;
      await this.fenceLostOwnership(clinicId, "heartbeat_not_renewed");
    }
  }

  /**
   * Re-asserts this worker's ownership of one clinic before doing something
   * that would be damaging without it.
   *
   * Deliberately the *same* statement as the heartbeat rather than a second
   * mechanism: one scoped `UPDATE ... WHERE worker_id = me` that both proves the
   * claim and refreshes it. It is not `claimSession`, which would clear a
   * standing `handoff_to` and so let a reconnecting worker silently cancel a
   * cooperative handoff it should have been honouring.
   *
   * Returns false when this worker must stop, having already fenced itself.
   */
  private async revalidateOwnership(clinicId: string, stage: string): Promise<boolean> {
    const renewed = await this.store.heartbeat([clinicId]).catch((error: unknown) => {
      // Same reasoning as the sweep: an unreachable database is not a lost
      // clinic. The socket path continues; the next tick is the real check.
      logger.warn({ clinicId, stage, err: error }, "could not revalidate session ownership");
      return [clinicId];
    });
    if (renewed.includes(clinicId)) return true;
    await this.fenceLostOwnership(clinicId, stage);
    return false;
  }

  /**
   * Stops serving a clinic this worker has discovered it no longer owns.
   *
   * Not a teardown and not a logout: the pairing is perfectly healthy, it simply
   * belongs to another process now. So nothing durable is written at all — no
   * status, no `desired_state`, no `awaiting_scan`, and above all no auth. The
   * new owner is publishing that row and a write from here would fight it.
   *
   * The order matters. `invalidate()` runs first and synchronously, which is
   * what makes this a fence rather than a request: it bumps the clinic's epoch,
   * and every guarded write in the worker — the durable status writes, the QR,
   * `creds.update`, the Signal key store, the history drain — consults that
   * epoch through the token it captured. From this statement onwards they all
   * refuse, including the ones already in flight when they come back. Only then
   * are the timers cancelled and the socket ended, and `quiesce()` waits for the
   * writes that were admitted *before* the fence so none of them can land after
   * this method returns.
   *
   * `end()`, never `logout()`: unlinking would destroy a device identity the new
   * owner is using, and cost the clinic a QR scan for nothing.
   */
  private async fenceLostOwnership(clinicId: string, reason: string): Promise<void> {
    // 1. Revoke, synchronously. Nothing new is admitted from here on.
    this.invalidate(clinicId);
    // 2. No reconnect may be pending, and none may be scheduled: `onClose` is
    //    told this drop was deliberate, and the timer already queued is dropped.
    this.cancelReconnect(clinicId);
    const inFlightStart = this.starting.get(clinicId);
    if (inFlightStart) this.starting.delete(clinicId);
    // 3. No send and no inbound processing: both resolve the clinic through
    //    `sessions`, and both re-check the token they captured.
    const session = this.sessions.get(clinicId);
    if (session) {
      session.closing = true;
      this.sessions.delete(clinicId);
      try {
        session.socket.end(undefined);
      } catch (error) {
        logger.warn(
          { clinicId, reason, ...describeError(error) },
          "could not close the socket of a session this worker no longer owns",
        );
      }
    }
    // 4. Local state that only made sense while we were serving this clinic.
    //    The retry cache is plaintext of messages the *previous* owner sent; the
    //    deferral is a rate limit on sweeps that will not run again.
    this.sentMessages.delete(clinicId);
    this.historyDeferrals.delete(clinicId);
    // 5. Let the writes admitted before step 1 finish, so nothing lands behind
    //    the fence.
    await this.quiesce(clinicId);
    logger.warn(
      { clinicId, workerId: this.config.workerId, reason, hadSocket: Boolean(session) },
      "ownership lost: this worker has stopped serving the clinic",
    );
  }

  /**
   * Lets go of the sessions another worker has asked for.
   *
   * Runs on every heartbeat tick, in *every* worker — the production instance
   * included, which is the whole reason a developer's laptop can be handed a
   * live clinic without anyone stopping the deployment. It is also the only
   * place ownership is given away outside a shutdown, and the order below is
   * what makes it safe: the socket is closed *first* and ownership released only
   * afterwards, so there is no instant at which the requester could win the
   * claim while this process still has a socket open on the same device.
   *
   * A clinic with a start in flight is skipped rather than interrupted. The
   * request is durable and the next tick will find it again.
   */
  async honorHandoffs(): Promise<void> {
    if (this.shuttingDown) return;
    const requested = await this.store.listHandoffRequests().catch((error: unknown) => {
      logger.warn({ err: error }, "could not read handoff requests");
      return [] as string[];
    });
    for (const clinicId of requested) {
      if (this.shuttingDown) return;
      if (this.starting.has(clinicId)) continue;
      this.cancelReconnect(clinicId);
      const session = this.sessions.get(clinicId);
      if (session) {
        // `closing` is what tells `onClose` this drop was deliberate, so the
        // socket is not reopened underneath the worker taking over.
        session.closing = true;
        session.socket.end(undefined);
        this.sessions.delete(clinicId);
      }
      await this.store.releaseOwnership([clinicId]).catch((error: unknown) => {
        logger.warn({ clinicId, err: error }, "could not release a requested session");
      });
      logger.info({ clinicId }, "session released to the worker that requested it");
    }
  }

  /**
   * Boot-time restore. Every clinic that asked to stay online gets its socket
   * back from the encrypted state in the database — which is what makes a
   * redeploy invisible: nobody scans anything again.
   */
  async restoreAll(): Promise<void> {
    const clinicIds = await this.store.listRestorableClinics().catch((error: unknown) => {
      logger.error({ err: error }, "could not list sessions to restore");
      return [] as string[];
    });
    logger.info({ count: clinicIds.length }, "restoring sessions");
    for (const clinicId of clinicIds) {
      const outcome = await this.start(clinicId).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "restore failed");
        return null;
      });
      if (outcome && !outcome.ok) {
        logger.warn({ clinicId }, "session is held by another worker; will retry");
      }
      // `start()` now returns before the socket is up, so the restore waits for
      // it here instead: this sweep is not the caller the fast path exists for,
      // and without the wait the stagger below would no longer stagger anything.
      await this.settle(clinicId);
      // Staggered so a large tenant base does not open every socket at once.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Restart safety for the history import (H2). A batch that was interpreted
    // but never accepted outlived the process that held it; this is where it
    // gets its next attempt, before the clinic is told anything about the state
    // of their import.
    await this.drainPendingHistory();
  }

  /**
   * Closes the gap between what clinics asked for and what this instance is
   * actually holding.
   *
   * The boot-time restore alone is not enough on a platform that overlaps
   * deployments: the new instance starts while the old one is still draining,
   * every session is refused as owned-elsewhere, and without this sweep the
   * clinics would stay dark until somebody pressed a button. It also picks up a
   * clinic that asked to connect while the worker was down, and a session whose
   * reconnects were exhausted.
   *
   * Deliberately cheap and idempotent: one indexed read, and `start()` returns
   * immediately for every clinic already held.
   */
  async reconcile(): Promise<void> {
    if (this.shuttingDown) return;
    const clinicIds = await this.store.listRestorableClinics().catch((error: unknown) => {
      logger.warn({ err: error }, "reconcile could not list sessions");
      return [] as string[];
    });
    for (const clinicId of clinicIds) {
      if (this.shuttingDown) return;
      // Held, reconnecting, or already coming up — all three mean "not this
      // sweep's problem".
      if (
        this.sessions.has(clinicId) ||
        this.reconnects.has(clinicId) ||
        this.starting.has(clinicId)
      ) {
        continue;
      }
      const outcome = await this.start(clinicId).catch((error: unknown) => {
        logger.error({ clinicId, err: error }, "reconcile start failed");
        return null;
      });
      if (outcome?.ok) logger.info({ clinicId }, "session adopted by reconcile");
      await this.settle(clinicId);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.shuttingDown) return;
    await this.drainPendingHistory();
  }

  /**
   * Shutdown for a redeploy: sockets are closed, but nothing is logged out and
   * no stored identity is touched, so `desired_state` still says online and the
   * next process picks every session back up.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const clinicId of [...this.reconnects.keys()]) this.cancelReconnect(clinicId);
    // Starts still in flight count as held: their row already carries this
    // worker's id, and the socket they were opening is dropped unpublished by
    // the shutdown check in `open()`.
    const held = [...new Set([...this.sessions.keys(), ...this.starting.keys()])];
    for (const session of this.sessions.values()) {
      session.closing = true;
      session.socket.end(undefined);
    }
    this.sessions.clear();
    // Hand the sessions over explicitly. Without this the replacement instance
    // would see a heartbeat minutes fresh, refuse every session as owned
    // elsewhere, and the clinics would stay dark until the stale window
    // elapsed.
    await this.store.releaseOwnership(held).catch((error: unknown) => {
      logger.warn({ err: error }, "could not release session ownership");
    });
    // A developer who quits mid-handoff would otherwise leave a fence standing
    // over a clinic they are no longer coming back for. `HANDOFF_TTL_MS` would
    // eventually lift it; withdrawing the request lifts it now.
    if (this.config.devTakeover) {
      await this.store.clearHandoffRequests().catch((error: unknown) => {
        logger.warn({ err: error }, "could not withdraw handoff requests");
      });
    }
  }
}
