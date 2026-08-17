import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import { useSupabaseAuthState, type LinkedDeviceAuthState } from "./auth-state.ts";
import { CallbackClient, type CallbackEvent } from "./callback.ts";
import type { WorkerConfig } from "./config.ts";
import { encryptAuthValue } from "./crypto.ts";
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
/** Baileys wants its own logger instance; it must not inherit our transports. */
const socketLogger = pino({ level: "silent" });

/** How long a displayed code stays valid before WhatsApp issues a new one. */
const QR_TTL_MS = 60_000;
/** How many codes to offer before giving up and asking the clinic to retry. */
const MAX_QR_ROUNDS = 5;
/** Reconnect backoff for an established pairing that dropped. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** A session row whose worker stopped heart-beating may be taken over. */
const HEARTBEAT_STALE_MS = 90_000;

type Session = {
  clinicId: string;
  socket: WASocket;
  auth: LinkedDeviceAuthState;
  /** The paired number, once the socket has opened at least once. */
  phone: string | null;
  qrRounds: number;
  reconnectAttempts: number;
  /** Set while a deliberate teardown is in progress, to suppress reconnects. */
  closing: boolean;
};

/** The bracketed marker staff see for a message type we cannot render as text. */
const MEDIA_MARKERS: Record<string, string> = {
  imageMessage: "[image]",
  videoMessage: "[video]",
  audioMessage: "[voice message]",
  documentMessage: "[document]",
  stickerMessage: "[sticker]",
  contactMessage: "[contact]",
  locationMessage: "[location]",
};

function messageText(message: WAMessage["message"]): string | null {
  if (!message) return null;
  const content =
    message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  if (typeof content.conversation === "string" && content.conversation.length > 0) {
    return content.conversation;
  }
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  const caption = content.imageMessage?.caption ?? content.videoMessage?.caption;
  if (caption) return caption;
  for (const [type, marker] of Object.entries(MEDIA_MARKERS)) {
    if (type in content) return marker;
  }
  return null;
}

/** `20100000000@s.whatsapp.net` → `+20100000000`. */
function phoneFromJid(jid: string): string | null {
  const user = jidNormalizedUser(jid).split("@")[0]?.split(":")[0];
  return user && /^\d{6,20}$/.test(user) ? `+${user}` : null;
}

/** Only one-to-one chats are carried; groups, status and broadcasts are not. */
function isDirectChat(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; code: "NO_SESSION" | "NOT_CONNECTED" | "INVALID_RECIPIENT" | "SEND_FAILED" };

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * Starts that have been admitted but have not yet reached the point where
   * `open()` publishes the socket into `sessions`. Without this, two starts for
   * one clinic arriving in the same tick — a double-clicked "Generate QR code",
   * or the boot-time restore racing that click — would both pass the
   * `sessions.has()` guard while the first was still awaiting the database, and
   * the clinic would end up with two sockets on one pairing.
   */
  private readonly starting = new Map<string, Promise<{ ok: true } | { ok: false; code: "OWNED_ELSEWHERE" }>>();
  /** Pending reconnect timers, for clinics with no live socket right now. */
  private readonly reconnects = new Map<string, NodeJS.Timeout>();
  private readonly callbacks: CallbackClient;
  private shuttingDown = false;
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: `node --experimental-strip-types` runs this source directly in
  // development, and strip-only mode cannot desugar them.
  private readonly config: WorkerConfig;
  private readonly store: Store;

  constructor(config: WorkerConfig, store: Store) {
    this.config = config;
    this.store = store;
    this.callbacks = new CallbackClient(config);
  }

  /** Clinics this instance currently holds a socket for. */
  clinicIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Brings this clinic's session up.
   *
   * Idempotent by design: the settings page may call it on every "Generate QR
   * code", and a boot-time restore may race a clinic pressing the button. A
   * clinic whose row is still being heart-beaten by a *different* worker is
   * refused, so two instances can never both hold the same pairing.
   */
  async start(clinicId: string): Promise<{ ok: true } | { ok: false; code: "OWNED_ELSEWHERE" }> {
    if (this.sessions.has(clinicId)) return { ok: true };
    // A start already in flight for this clinic is *the* start: the second
    // caller waits on it and gets its outcome rather than opening a rival
    // socket.
    const inFlight = this.starting.get(clinicId);
    if (inFlight) return inFlight;

    const attempt = this.startUncoordinated(clinicId).finally(() => {
      this.starting.delete(clinicId);
    });
    this.starting.set(clinicId, attempt);
    return attempt;
  }

  private async startUncoordinated(
    clinicId: string,
  ): Promise<{ ok: true } | { ok: false; code: "OWNED_ELSEWHERE" }> {
    const existing = await this.store.readSession(clinicId).catch(() => null);
    if (
      existing?.worker_id &&
      existing.worker_id !== this.config.workerId &&
      existing.last_heartbeat_at &&
      Date.now() - new Date(existing.last_heartbeat_at).valueOf() < HEARTBEAT_STALE_MS
    ) {
      return { ok: false, code: "OWNED_ELSEWHERE" };
    }

    await this.store.upsertSession(clinicId, {
      status: "starting",
      desired_state: "online",
      qr_payload: null,
      qr_expires_at: null,
      last_error: null,
    });
    await this.open(clinicId, { qrRounds: 0, reconnectAttempts: 0 });
    return { ok: true };
  }

  /** Opens the socket itself. Never called concurrently for one clinic. */
  private async open(
    clinicId: string,
    counters: { qrRounds: number; reconnectAttempts: number },
  ): Promise<void> {
    const auth = await useSupabaseAuthState(this.store, clinicId, this.config.credentialsKey);
    // A brand-new identity is written before the socket opens, so a restart
    // during the scan reuses the same device keys instead of orphaning them.
    if (!auth.restored) await auth.saveCreds();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const socket = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, socketLogger),
      },
      logger: socketLogger,
      // The clinic scans inside ClinicFlow; nothing is ever printed anywhere.
      printQRInTerminal: false,
      browser: Browsers.appropriate("ClinicFlow"),
      qrTimeout: QR_TTL_MS,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    const session: Session = {
      clinicId,
      socket,
      auth,
      phone: null,
      qrRounds: counters.qrRounds,
      reconnectAttempts: counters.reconnectAttempts,
      closing: false,
    };
    // A socket is coming up for this clinic, so any reconnect still queued for
    // it is redundant.
    this.cancelReconnect(clinicId);
    this.sessions.set(clinicId, session);

    socket.ev.on("creds.update", () => {
      void auth.saveCreds().catch((error: unknown) => {
        logger.error({ clinicId, error }, "failed to persist device identity");
      });
    });

    socket.ev.on("connection.update", (update) => {
      void this.onConnectionUpdate(session, update).catch((error: unknown) => {
        logger.error({ clinicId, error }, "connection update failed");
      });
    });

    socket.ev.on("messages.upsert", (upsert) => {
      void this.onMessages(session, upsert).catch((error: unknown) => {
        logger.error({ clinicId, error }, "inbound delivery failed");
      });
    });

    socket.ev.on("messages.update", (updates) => {
      void this.onReceipts(session, updates).catch((error: unknown) => {
        logger.error({ clinicId, error }, "receipt delivery failed");
      });
    });
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

    if (update.qr) {
      session.qrRounds += 1;
      // Each new code replaces the previous one in place, so the panel shows a
      // fresh code without the clinic doing anything.
      await this.store.setStatus(clinicId, "awaiting_scan", {
        qr_payload: update.qr,
        qr_expires_at: new Date(Date.now() + QR_TTL_MS).toISOString(),
        last_error: null,
      });
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

    const jid = session.socket.user?.id;
    const phone = jid ? phoneFromJid(jid) : null;
    if (!phone) {
      await this.fail(session, "unknown");
      return;
    }
    session.phone = phone;

    // The channel envelope holds no WhatsApp secret — the device identity stays
    // in whatsapp_linked_device_auth. It carries only what the send adapter
    // needs to address this clinic's session.
    const credentials = encryptAuthValue(
      JSON.stringify({ clinicId, displayPhoneNumber: phone }),
      this.config.credentialsKey,
    );
    const claimed = await this.store.activateChannel({
      clinicId,
      phoneNumber: phone,
      credentialsEncrypted: credentials,
    });
    if (!claimed.ok) {
      // The number belongs to another clinic (or could not be stored). The
      // pairing is undone rather than left half-connected.
      logger.warn({ clinicId, reason: claimed.reason }, "could not claim paired number");
      await this.logout(clinicId, claimed.reason === "identity_taken" ? "pairing_failed" : "unknown");
      return;
    }

    await this.store.setStatus(clinicId, "connected", {
      desired_state: "online",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: phone,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    logger.info({ clinicId }, "session connected");
  }

  private async onClose(session: Session, error: Error | undefined): Promise<void> {
    const { clinicId } = session;
    // Only retire the map entry if it is still *this* socket. A close event
    // that arrives after a newer socket has already been published for the
    // clinic must not evict the live one and leave it orphaned.
    if (this.sessions.get(clinicId) === session) this.sessions.delete(clinicId);
    if (session.closing || this.shuttingDown) return;

    const statusCode =
      error instanceof Boom ? error.output?.statusCode : (error as { output?: { statusCode?: number } })?.output?.statusCode;

    // WhatsApp says this device is gone: the clinic unlinked it from the phone,
    // or the identity was invalidated. Nothing can be recovered without a new
    // scan, so the stored identity is destroyed rather than retried.
    if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
      await this.tearDown(clinicId, session, "logged_out");
      return;
    }

    // Baileys asks for a clean restart after pairing completes.
    if (statusCode === DisconnectReason.restartRequired) {
      await this.open(clinicId, { qrRounds: session.qrRounds, reconnectAttempts: 0 });
      return;
    }

    const paired = Boolean(session.auth.state.creds.registered);

    // Nobody scanned in time. Offer a few more codes before giving up, so a
    // clinic that fetched their phone mid-way is not sent back to the card.
    if (!paired) {
      if (session.qrRounds < MAX_QR_ROUNDS) {
        await this.store.setStatus(clinicId, "starting", { qr_payload: null, qr_expires_at: null });
        await this.open(clinicId, { qrRounds: session.qrRounds, reconnectAttempts: 0 });
        return;
      }
      await this.tearDown(clinicId, session, "pairing_failed");
      return;
    }

    // An established pairing that dropped: keep trying, with backoff. The
    // clinic stays "connected" in the UI only while it really is.
    const attempts = session.reconnectAttempts + 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
    await this.store.setStatus(clinicId, "connecting", { qr_payload: null, qr_expires_at: null });
    logger.warn({ clinicId, statusCode, attempts, delay }, "session dropped; reconnecting");
    const timer = setTimeout(() => {
      this.reconnects.delete(clinicId);
      if (this.shuttingDown || this.sessions.has(clinicId)) return;
      void this.open(clinicId, { qrRounds: 0, reconnectAttempts: attempts }).catch(
        (openError: unknown) => {
          logger.error({ clinicId, error: openError }, "reconnect failed");
        },
      );
    }, delay);
    // The session is no longer in `sessions` — it is waiting to be reopened —
    // so the pending reconnect is tracked separately or nothing could cancel
    // it on shutdown or on a deliberate logout.
    this.reconnects.set(clinicId, timer);
  }

  /** Drops any reconnect queued for a clinic that no longer wants one. */
  private cancelReconnect(clinicId: string): void {
    const timer = this.reconnects.get(clinicId);
    if (!timer) return;
    clearTimeout(timer);
    this.reconnects.delete(clinicId);
  }

  /** Ends a pairing for good and releases everything it held. */
  private async tearDown(
    clinicId: string,
    session: Session,
    reason: SessionErrorCode,
  ): Promise<void> {
    this.cancelReconnect(clinicId);
    await session.auth.clear().catch(() => undefined);
    await this.store.removeChannel(clinicId).catch(() => undefined);
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

  private async fail(session: Session, reason: SessionErrorCode): Promise<void> {
    await this.store.setStatus(session.clinicId, "error", {
      desired_state: "offline",
      qr_payload: null,
      qr_expires_at: null,
      last_error: reason,
    });
  }

  private async onMessages(
    session: Session,
    upsert: { type: string; messages: WAMessage[] },
  ): Promise<void> {
    // `notify` is live traffic. `append` is history backfill, which must not be
    // replayed into the inbox as if it just arrived.
    if (upsert.type !== "notify" || !session.phone) return;
    const events: CallbackEvent[] = [];
    for (const message of upsert.messages) {
      const jid = message.key.remoteJid;
      if (!isDirectChat(jid)) continue;
      const providerMessageId = message.key.id;
      if (!providerMessageId) continue;
      const counterparty = phoneFromJid(jid);
      if (!counterparty) continue;
      const body = messageText(message.message);
      if (body === null) continue;
      const occurredAt = new Date(
        Number(message.messageTimestamp ?? 0) * 1000 || Date.now(),
      ).toISOString();

      if (message.key.fromMe) {
        // A message the clinic sent from their own phone (or that ClinicFlow
        // sent through this session — the application discards that echo).
        events.push({
          kind: "outbound_echo",
          providerMessageId,
          recipient: counterparty,
          body,
          occurredAt,
        });
      } else {
        events.push({
          kind: "inbound",
          providerMessageId,
          sender: counterparty,
          body,
          receivedAt: occurredAt,
        });
      }
    }
    await this.deliver(session, events);
  }

  private async onReceipts(
    session: Session,
    updates: Array<{ key: { id?: string | null; fromMe?: boolean | null }; update: { status?: number | null } }>,
  ): Promise<void> {
    if (!session.phone) return;
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

  /** Sends one text message through this clinic's own session. */
  async send(clinicId: string, recipient: string, body: string): Promise<SendOutcome> {
    const session = this.sessions.get(clinicId);
    if (!session) return { ok: false, code: "NO_SESSION" };
    if (!session.phone) return { ok: false, code: "NOT_CONNECTED" };
    const digits = recipient.replace(/[^\d]/g, "");
    if (digits.length < 6 || digits.length > 20) return { ok: false, code: "INVALID_RECIPIENT" };
    const jid = `${digits}@s.whatsapp.net`;
    try {
      const sent = await session.socket.sendMessage(jid, { text: body });
      return { ok: true, providerMessageId: sent?.key.id ?? null };
    } catch (error) {
      logger.error({ clinicId, error }, "send failed");
      return { ok: false, code: "SEND_FAILED" };
    }
  }

  /**
   * Ends a clinic's pairing on request: WhatsApp is told to drop the linked
   * device, the stored identity is destroyed, and the channel is released.
   */
  async logout(clinicId: string, reason: SessionErrorCode = "logged_out"): Promise<void> {
    const session = this.sessions.get(clinicId);
    if (session) {
      session.closing = true;
      this.sessions.delete(clinicId);
      // logout() unlinks the device on the phone; if it fails the local
      // teardown still runs so the clinic is never stuck.
      await session.socket.logout().catch(() => undefined);
      session.socket.end(undefined);
      await this.tearDown(clinicId, session, reason);
      return;
    }
    // No live socket here — clean up whatever this clinic left behind anyway,
    // including a reconnect that would otherwise revive the pairing seconds
    // after the clinic asked for it to end.
    this.cancelReconnect(clinicId);
    await this.store.clearAuth(clinicId).catch(() => undefined);
    await this.store.removeChannel(clinicId).catch(() => undefined);
    await this.store.setStatus(clinicId, "disconnected", {
      desired_state: "offline",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: null,
      connected_at: null,
      last_error: null,
    });
  }

  /**
   * Boot-time restore. Every clinic that asked to stay online gets its socket
   * back from the encrypted state in the database — which is what makes a
   * redeploy invisible: nobody scans anything again.
   */
  async restoreAll(): Promise<void> {
    const clinicIds = await this.store.listRestorableClinics().catch((error: unknown) => {
      logger.error({ error }, "could not list sessions to restore");
      return [] as string[];
    });
    logger.info({ count: clinicIds.length }, "restoring sessions");
    for (const clinicId of clinicIds) {
      const outcome = await this.start(clinicId).catch((error: unknown) => {
        logger.error({ clinicId, error }, "restore failed");
        return null;
      });
      if (outcome && !outcome.ok) {
        logger.warn({ clinicId }, "session is held by another worker; will retry");
      }
      // Staggered so a large tenant base does not open every socket at once.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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
      logger.warn({ error }, "reconcile could not list sessions");
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
        logger.error({ clinicId, error }, "reconcile start failed");
        return null;
      });
      if (outcome?.ok) logger.info({ clinicId }, "session adopted by reconcile");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Shutdown for a redeploy: sockets are closed, but nothing is logged out and
   * no stored identity is touched, so `desired_state` still says online and the
   * next process picks every session back up.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const clinicId of [...this.reconnects.keys()]) this.cancelReconnect(clinicId);
    const held = [...this.sessions.keys()];
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
      logger.warn({ error }, "could not release session ownership");
    });
  }
}
