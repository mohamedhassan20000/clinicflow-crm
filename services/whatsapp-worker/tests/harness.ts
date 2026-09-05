import type { WASocket } from "baileys";
import type { WorkerConfig } from "../src/config.ts";
import { SessionManager } from "../src/sessions.ts";
import { HANDOFF_TTL_MS, HEARTBEAT_STALE_MS, type SessionRow, type Store } from "../src/store.ts";

/**
 * The stand-ins the worker's own suite runs against: a session store held in
 * memory and a WhatsApp socket that does nothing until a test tells it to.
 *
 * Nothing here reaches Supabase or WhatsApp. The point of these tests is the
 * manager's own control flow — when a caller is answered, what is durable by
 * then, and what happens to a handshake that fails after nobody is listening —
 * and both of those dependencies are exactly the slow, unavailable things the
 * tests need to be able to stall on demand.
 */

export const CLINIC_A = "11111111-1111-4111-8111-111111111111";
export const CLINIC_B = "22222222-2222-4222-8222-222222222222";

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    port: 0,
    workerId: "worker-under-test",
    supabaseUrl: "https://project.supabase.test",
    supabaseServiceRoleKey: "service-role-key",
    credentialsKey: Buffer.alloc(32, 7),
    apiToken: "t".repeat(40),
    callbackSecret: "s".repeat(40),
    appUrl: "https://clinicflow.test",
    outboundLidRouting: true,
    historySync: true,
    attachmentMaxBytes: 10 * 1024 * 1024,
    attachmentBucket: "whatsapp-inbound",
    outboundMediaMaxBytes: 10 * 1024 * 1024,
    devTakeover: false,
    ...overrides,
  };
}

export type StoredSession = Record<string, unknown> & { clinic_id: string };

export type HistoryBatchRow = {
  id: string;
  clinicId: string;
  sessionPhone: string;
  payload: unknown[];
  status: "pending" | "delivered" | "failed" | "superseded";
  attempts: number;
  claimed: boolean;
};

/**
 * An in-memory `Store`. Only the surface the start path touches is real; the
 * rest is present so the manager can run without a database.
 */
export class FakeStore {
  /**
   * The session rows. Two `FakeStore`s constructed with the same map are two
   * workers against one database, which is the only way to exercise ownership
   * at all — see `tests/ownership-handoff.test.ts`.
   */
  readonly sessions: Map<string, StoredSession>;
  /**
   * The encrypted device identities.
   *
   * Shareable for the same reason `sessions` is: `whatsapp_linked_device_auth`
   * is one table, and a handoff is only durable if the worker taking over reads
   * the *same* rows the worker letting go wrote. A per-store map would make
   * every handoff look like a fresh pairing and hide the one failure the
   * zero-QR suite exists to catch.
   */
  readonly auth: Map<string, string>;
  /** Set to make the durable "starting" write fail, as an outage would. */
  upsertError: Error | null = null;
  /**
   * Blocks every auth write until resolved, so a test can hold `saveCreds` open
   * across a logout — the exact window the start/logout race lives in.
   */
  authWriteGate: Promise<void> | null = null;
  /** Auth writes admitted so far, by `keyType:keyId`, in order. */
  readonly authWrites: string[] = [];
  /** Set to make the identity delete fail, as a database fault would. */
  clearAuthError: Error | null = null;
  /** Set to make the channel delete fail, as a database fault would. */
  removeChannelError: Error | null = null;
  readonly clearAuthCalls: string[] = [];
  readonly removeChannelCalls: string[] = [];
  /** Clinics with a live `clinic_channels` row, as `activateChannel` leaves them. */
  readonly channels = new Set<string>();
  readonly linkedAccounts = new Map<string, string>();
  readonly workerId: string;

  constructor(
    workerId: string,
    sharedSessions?: Map<string, StoredSession>,
    sharedAuth?: Map<string, string>,
  ) {
    this.workerId = workerId;
    this.sessions = sharedSessions ?? new Map<string, StoredSession>();
    this.auth = sharedAuth ?? new Map<string, string>();
  }

  /** Seeds a row as another worker would have left it. */
  seed(clinicId: string, row: Record<string, unknown>): void {
    this.commit(clinicId, { clinic_id: clinicId, ...row });
  }

  /**
   * The one place a session row is written, so the database's own refusals are
   * refusals here too.
   *
   * `whatsapp_linked_device_sessions_handoff_not_self` is a real check
   * constraint on the real table, and a fake store that quietly accepted the row
   * it rejects is a fake store that reports green for the exact defect it was
   * built to catch — which is what happened: a worker stamped `worker_id` with
   * its own id on a row whose `handoff_to` already named it, Postgres answered
   * SQLSTATE 23514, and this suite had no opinion at all. Now it throws what
   * PostgREST would.
   */
  private commit(clinicId: string, row: StoredSession): void {
    const owner = row.worker_id as string | null | undefined;
    const requester = row.handoff_to as string | null | undefined;
    if (owner && requester && owner === requester) {
      const violation = new Error(
        'new row for relation "whatsapp_linked_device_sessions" violates check constraint ' +
          '"whatsapp_linked_device_sessions_handoff_not_self"',
      );
      (violation as Error & { code: string }).code = "23514";
      throw violation;
    }
    this.sessions.set(clinicId, row);
  }

  row(clinicId: string): StoredSession | undefined {
    return this.sessions.get(clinicId);
  }

  async readSession(clinicId: string): Promise<SessionRow | null> {
    return (this.sessions.get(clinicId) as SessionRow | undefined) ?? null;
  }

  /**
   * State without ownership — the split the real store now makes.
   *
   * A row this worker owns is updated in place with a fresh heartbeat. A row it
   * does not own gets the visible columns only: no `worker_id`, no heartbeat, no
   * `handoff_to`. Nothing here can take a session, which is the property the
   * suite below leans on.
   */
  async writeSessionState(clinicId: string, patch: Record<string, unknown>): Promise<void> {
    if (this.upsertError) throw this.upsertError;
    const row = this.sessions.get(clinicId);
    if (row?.worker_id === this.workerId) {
      this.commit(clinicId, { ...row, last_heartbeat_at: new Date().toISOString(), ...patch });
      return;
    }
    this.commit(clinicId, { ...(row ?? { clinic_id: clinicId }), clinic_id: clinicId, ...patch });
  }

  async setStatus(
    clinicId: string,
    status: string,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    await this.writeSessionState(clinicId, { status, ...patch });
  }

  async ensureInboundActiveFrom(clinicId: string, proposed: string): Promise<string> {
    const row = this.sessions.get(clinicId) ?? { clinic_id: clinicId };
    const existing = row.inbound_active_from as string | null | undefined;
    const value = existing ?? proposed;
    this.commit(clinicId, {
      ...row,
      created_at: (row.created_at as string | undefined) ?? proposed,
      inbound_active_from: value,
    });
    return value;
  }

  async bindLinkedAccount(input: {
    clinicId: string;
    accountId: string;
    accountLid: string | null;
    proposedBoundary: string;
  }): Promise<{ inboundActiveFrom: string; changed: boolean }> {
    const row = this.sessions.get(input.clinicId) ?? { clinic_id: input.clinicId };
    const previous = row.authenticated_account_id as string | null | undefined;
    const accountKey = `${input.clinicId}:${input.accountId}`;
    const boundary = this.linkedAccounts.get(accountKey) ??
      (previous === input.accountId && typeof row.inbound_active_from === "string"
        ? row.inbound_active_from
        : input.proposedBoundary);
    this.linkedAccounts.set(accountKey, boundary);
    this.commit(input.clinicId, {
      ...row,
      authenticated_account_id: input.accountId,
      authenticated_account_lid: input.accountLid,
      inbound_active_from: boundary,
    });
    return {
      inboundActiveFrom: boundary,
      changed: Boolean(previous && previous !== input.accountId),
    };
  }

  async supersedeHistoryBatches(clinicId: string, activeAccountId: string): Promise<void> {
    for (const row of this.batches.values()) {
      if (row.clinicId !== clinicId || row.sessionPhone === activeAccountId) continue;
      if (row.status === "pending") row.status = "superseded";
    }
  }

  async readAuthValue(clinicId: string, keyType: string, keyId: string): Promise<string | null> {
    return this.auth.get(`${clinicId}:${keyType}:${keyId}`) ?? null;
  }

  async writeAuthValues(
    clinicId: string,
    rows: ReadonlyArray<{ keyType: string; keyId: string; value: string }>,
  ): Promise<void> {
    if (this.authWriteGate) await this.authWriteGate;
    for (const row of rows) {
      this.authWrites.push(`${row.keyType}:${row.keyId}`);
      this.auth.set(`${clinicId}:${row.keyType}:${row.keyId}`, row.value);
    }
  }

  /** Auth rows this clinic currently has stored. */
  authKeys(clinicId: string): string[] {
    return [...this.auth.keys()].filter((key) => key.startsWith(`${clinicId}:`));
  }

  async deleteAuthValues(
    clinicId: string,
    rows: ReadonlyArray<{ keyType: string; keyId: string }>,
  ): Promise<void> {
    for (const row of rows) this.auth.delete(`${clinicId}:${row.keyType}:${row.keyId}`);
  }

  async clearAuth(clinicId: string): Promise<void> {
    this.clearAuthCalls.push(clinicId);
    if (this.clearAuthError) throw this.clearAuthError;
    for (const key of [...this.auth.keys()]) {
      if (key.startsWith(`${clinicId}:`)) this.auth.delete(key);
    }
  }

  async removeChannel(clinicId: string): Promise<void> {
    this.removeChannelCalls.push(clinicId);
    if (this.removeChannelError) throw this.removeChannelError;
    this.channels.delete(clinicId);
  }
  /**
   * The fenced claim, with the same predicate the SQL `UPDATE` carries: the seat
   * is available (unowned, ours, or stale) *and* no live handoff request names
   * somebody else. Winning it clears the request, because it has been answered.
   */
  async claimSession(clinicId: string, patch: Record<string, unknown> = {}): Promise<boolean> {
    if (this.upsertError) throw this.upsertError;
    const now = Date.now();
    const row = this.sessions.get(clinicId);
    if (row) {
      const owner = row.worker_id as string | null | undefined;
      const beat = row.last_heartbeat_at as string | null | undefined;
      const seatTaken =
        Boolean(owner) && owner !== this.workerId && Boolean(beat) &&
        now - new Date(beat as string).valueOf() < HEARTBEAT_STALE_MS;
      if (seatTaken) return false;
      const requester = row.handoff_to as string | null | undefined;
      const requestedAt = row.handoff_requested_at as string | null | undefined;
      const fenced =
        Boolean(requester) && requester !== this.workerId && Boolean(requestedAt) &&
        now - new Date(requestedAt as string).valueOf() < HANDOFF_TTL_MS;
      if (fenced) return false;
    }
    this.commit(clinicId, {
      ...(row ?? { clinic_id: clinicId }),
      clinic_id: clinicId,
      worker_id: this.workerId,
      last_heartbeat_at: new Date(now).toISOString(),
      handoff_to: null,
      handoff_requested_at: null,
      ...patch,
    });
    return true;
  }

  async requestHandoff(clinicId: string): Promise<boolean> {
    const row = this.sessions.get(clinicId);
    const owner = row?.worker_id as string | null | undefined;
    if (!row || !owner || owner === this.workerId) return false;
    this.commit(clinicId, {
      ...row,
      handoff_to: this.workerId,
      handoff_requested_at: new Date().toISOString(),
    });
    return true;
  }

  async listHandoffRequests(): Promise<string[]> {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((row) => {
        const requestedAt = row.handoff_requested_at as string | null | undefined;
        return (
          row.worker_id === this.workerId &&
          Boolean(row.handoff_to) &&
          row.handoff_to !== this.workerId &&
          Boolean(requestedAt) &&
          now - new Date(requestedAt as string).valueOf() < HANDOFF_TTL_MS
        );
      })
      .map((row) => row.clinic_id);
  }

  async clearHandoffRequests(): Promise<void> {
    for (const [clinicId, row] of this.sessions) {
      if (row.handoff_to !== this.workerId) continue;
      this.commit(clinicId, { ...row, handoff_to: null, handoff_requested_at: null });
    }
  }

  async listLiveSessionsOwnedByThisWorkerId(): Promise<string[]> {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((row) => {
        const beat = row.last_heartbeat_at as string | null | undefined;
        return (
          row.worker_id === this.workerId &&
          Boolean(beat) &&
          now - new Date(beat as string).valueOf() < HEARTBEAT_STALE_MS
        );
      })
      .map((row) => row.clinic_id);
  }

  /**
   * The real store refreshes only rows this worker still owns, and reports which
   * ones it matched. A worker that has handed a session over must not be able to
   * keep it alive from a stale timer — and it must be *told*, because the
   * unmatched ids are the lost-owner signal the manager fences on.
   */
  async heartbeat(clinicIds: readonly string[] = []): Promise<string[]> {
    const renewed: string[] = [];
    for (const clinicId of clinicIds) {
      const row = this.sessions.get(clinicId);
      if (row?.worker_id !== this.workerId) continue;
      this.commit(clinicId, { ...row, last_heartbeat_at: new Date().toISOString() });
      renewed.push(clinicId);
    }
    return renewed;
  }
  async releaseOwnership(clinicIds: readonly string[]): Promise<void> {
    for (const clinicId of clinicIds) {
      const row = this.sessions.get(clinicId);
      if (row?.worker_id === this.workerId) {
        this.commit(clinicId, { ...row, worker_id: null, last_heartbeat_at: null });
      }
    }
  }

  async listRestorableClinics(): Promise<string[]> {
    return [...this.sessions.values()]
      .filter((row) => row.desired_state === "online")
      .map((row) => row.clinic_id);
  }

  async activateChannel(input?: { clinicId: string }): Promise<{ ok: true }> {
    if (input?.clinicId) this.channels.add(input.clinicId);
    return { ok: true };
  }

  /** Every attachment the worker uploaded, by storage path. */
  readonly uploads = new Map<string, { contentType: string; byteSize: number }>();
  readonly outboundMedia = new Map<string, Buffer>();
  readonly contacts = new Map<string, string | null>();
  readonly scopedContacts = new Map<string, string | null>();
  readonly lidMappings = new Map<string, string>();
  /** Set to make every upload fail, as a storage outage would. */
  uploadFails = false;

  async uploadAttachment(input: {
    clinicId: string;
    path: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<boolean> {
    if (this.uploadFails) return false;
    if (!input.path.startsWith(`${input.clinicId}/`)) return false;
    // Mirrors the real bucket's `upsert: false`: a path already written is not
    // written again.
    if (this.uploads.has(input.path)) return false;
    this.uploads.set(input.path, {
      contentType: input.contentType,
      byteSize: input.bytes.length,
    });
    return true;
  }

  async downloadOutboundMedia(input: {
    clinicId: string;
    bucket: string;
    storagePath: string;
  }): Promise<Buffer | null> {
    const allowed =
      (input.bucket === "whatsapp-outbound" && input.storagePath.startsWith(`${input.clinicId}/`)) ||
      (input.bucket === "patient-assets" && input.storagePath.startsWith(`documents/${input.clinicId}/`)) ||
      (input.bucket === "clinic-documents" && input.storagePath.startsWith(`documents/${input.clinicId}/`));
    if (!allowed || input.storagePath.includes("..")) return null;
    return this.outboundMedia.get(`${input.bucket}:${input.storagePath}`) ?? null;
  }

  /**
   * Contacts and LID aliases are keyed by *clinic and account*, matching the
   * real tables' primary keys.
   *
   * This is not incidental precision. A store keyed by account alone reports
   * green for a cross-tenant leak — two clinics that happen to have scanned the
   * same WhatsApp number would share one row here and nothing would notice —
   * which is exactly the property the isolation suite exists to assert.
   */
  scopeKey(clinicId: string, accountId: string, subject: string): string {
    return `${clinicId}:${accountId}:${subject}`;
  }

  async upsertContacts(
    clinicId: string,
    authenticatedAccountId: string,
    contacts: ReadonlyArray<{ participantAddress: string; displayName: string | null }>,
  ): Promise<void> {
    for (const contact of contacts) {
      this.contacts.set(contact.participantAddress, contact.displayName);
      this.scopedContacts.set(
        this.scopeKey(clinicId, authenticatedAccountId, contact.participantAddress),
        contact.displayName,
      );
    }
  }

  async upsertLidMappings(
    clinicId: string,
    authenticatedAccountId: string,
    mappings: ReadonlyArray<{ lid: string; phone: string }>,
  ): Promise<void> {
    for (const mapping of mappings) {
      const key = this.scopeKey(clinicId, authenticatedAccountId, mapping.lid);
      const existing = this.lidMappings.get(key);
      if (!existing) this.lidMappings.set(key, mapping.phone);
    }
  }

  async loadLidMappings(
    clinicId: string,
    authenticatedAccountId: string,
  ): Promise<Array<{ lid: string; phone: string }>> {
    const prefix = `${clinicId}:${authenticatedAccountId}:`;
    return [...this.lidMappings]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, phone]) => ({ lid: key.slice(prefix.length), phone }));
  }

  /**
   * Anchors for the on-demand history resync, keyed the way the real read is
   * scoped: `clinicId:authenticatedAccountId`. Keying it that way is the point —
   * a test can plant anchors under a *different* account and prove the resync
   * never reaches them, which is the account-boundary property in question.
   */
  readonly resyncAnchors = new Map<
    string,
    Array<{
      participantAddress: string;
      providerMessageId: string;
      fromMe: boolean;
      occurredAt: string;
    }>
  >();
  /** Every `(clinicId, account)` pair the manager asked anchors for, in order. */
  readonly anchorReads: Array<{ clinicId: string; account: string }> = [];

  async loadHistoryResyncAnchors(
    clinicId: string,
    authenticatedAccountId: string,
  ): Promise<
    Array<{
      participantAddress: string;
      providerMessageId: string;
      fromMe: boolean;
      occurredAt: string;
    }>
  > {
    this.anchorReads.push({ clinicId, account: authenticatedAccountId });
    return this.resyncAnchors.get(`${clinicId}:${authenticatedAccountId}`) ?? [];
  }

  // -- History delivery spool (H2) -----------------------------------------
  //
  // An in-memory stand-in for `whatsapp_history_delivery_batches` plus the two
  // RPCs that own it. It reproduces the properties the real ones guarantee —
  // enqueue-before-deliver, dedup on the batch key, one claim at a time, and a
  // status computed from the spool rather than from the worker's intentions —
  // because those are exactly what the H2 tests are about.
  readonly batches = new Map<string, HistoryBatchRow>();
  /** Attempts a batch gets before the import is reported `partial`. */
  maxHistoryAttempts = 8;

  async beginHistoryImport(clinicId: string): Promise<void> {
    this.sessions.set(clinicId, {
      ...(this.sessions.get(clinicId) ?? { clinic_id: clinicId }),
      clinic_id: clinicId,
      history_status: "importing",
    });
  }

  async enqueueHistoryBatches(input: {
    clinicId: string;
    sessionPhone: string;
    batches: ReadonlyArray<{ batchKey: string; payload: unknown[]; eventCount: number }>;
  }): Promise<number> {
    let added = 0;
    for (const batch of input.batches) {
      const key = `${input.clinicId}:${batch.batchKey}`;
      if (this.batches.has(key)) continue;
      this.batches.set(key, {
        id: key,
        clinicId: input.clinicId,
        sessionPhone: input.sessionPhone,
        payload: batch.payload,
        status: "pending",
        attempts: 0,
        claimed: false,
      });
      added += 1;
    }
    return added;
  }

  async claimHistoryBatches(
    clinicId: string,
    limit = 5,
    exclude: readonly string[] = [],
  ): Promise<Array<{ id: string; sessionPhone: string; payload: unknown[] }>> {
    const claimed: Array<{ id: string; sessionPhone: string; payload: unknown[] }> = [];
    const excluded = new Set(exclude);
    for (const row of this.batches.values()) {
      if (claimed.length >= limit) break;
      if (row.clinicId !== clinicId || row.status !== "pending" || row.claimed) continue;
      if (excluded.has(row.id)) continue;
      row.claimed = true;
      claimed.push({ id: row.id, sessionPhone: row.sessionPhone, payload: row.payload });
    }
    return claimed;
  }

  async releaseHistoryClaim(clinicId: string, batchId: string): Promise<void> {
    const row = this.batches.get(batchId);
    if (!row || row.clinicId !== clinicId || row.status !== "pending") return;
    // Only the claim. `attempts` and `status` are deliberately untouched — the
    // production statement has the same shape, and a test that let this consume
    // an attempt would stop proving the row is recoverable.
    row.claimed = false;
  }

  async recordHistoryDelivery(input: {
    clinicId: string;
    batchId?: string | null;
    delivered?: boolean | null;
    chats?: number;
    messages?: number;
    error?: string | null;
    finalBatchSeen?: boolean;
  }): Promise<{ status: string; pending: number; failed: number }> {
    const session = this.sessions.get(input.clinicId) ?? { clinic_id: input.clinicId };
    if (input.batchId) {
      const row = this.batches.get(input.batchId);
      if (row) {
        row.attempts += 1;
        row.claimed = false;
        row.status = input.delivered
          ? "delivered"
          : row.attempts >= this.maxHistoryAttempts
            ? "failed"
            : "pending";
      }
    }
    let pending = 0;
    let failed = 0;
    for (const row of this.batches.values()) {
      if (row.clinicId !== input.clinicId) continue;
      if (row.status === "pending") pending += 1;
      if (row.status === "failed") failed += 1;
    }
    const finalSeen =
      Boolean(session.history_final_batch_seen) || Boolean(input.finalBatchSeen);
    const chats = Number(session.history_chats_imported ?? 0) + (input.chats ?? 0);
    const messages = Number(session.history_messages_imported ?? 0) + (input.messages ?? 0);
    const status =
      !finalSeen || pending > 0
        ? "importing"
        : failed > 0
          ? "partial"
          : chats === 0 && messages === 0
            ? "unavailable"
            : "complete";
    this.sessions.set(input.clinicId, {
      ...session,
      clinic_id: input.clinicId,
      history_status: status,
      history_final_batch_seen: finalSeen,
      history_chats_imported: chats,
      history_messages_imported: messages,
    });
    return { status, pending, failed };
  }

  async recordHistoryMetrics(input: {
    clinicId: string;
    batchId: string;
    chatsReceived: number;
    messagesReceived: number;
    deduplicated: number;
    unsupported: number;
  }): Promise<{ status: string; pending: number }> {
    const row = this.batches.get(input.batchId);
    if (row && !(row as HistoryBatchRow & { metricsRecorded?: boolean }).metricsRecorded) {
      (row as HistoryBatchRow & { metricsRecorded?: boolean }).metricsRecorded = true;
      const session = this.sessions.get(input.clinicId) ?? { clinic_id: input.clinicId };
      this.sessions.set(input.clinicId, {
        ...session,
        history_chats_received: Number(session.history_chats_received ?? 0) + input.chatsReceived,
        history_messages_received:
          Number(session.history_messages_received ?? 0) + input.messagesReceived,
        history_messages_deduplicated:
          Number(session.history_messages_deduplicated ?? 0) + input.deduplicated,
        history_messages_unsupported:
          Number(session.history_messages_unsupported ?? 0) + input.unsupported,
        history_messages_pending: 0,
      });
    }
    return {
      status: String(this.sessions.get(input.clinicId)?.history_status ?? "importing"),
      pending: 0,
    };
  }

  async listClinicsWithPendingHistory(): Promise<string[]> {
    return [
      ...new Set(
        [...this.batches.values()].filter((row) => row.status === "pending").map((row) => row.clinicId),
      ),
    ];
  }

  async readHistoryStatus(clinicId: string): Promise<string | null> {
    return (this.sessions.get(clinicId)?.history_status as string | undefined) ?? null;
  }

  /** The manager takes the real class; the shape above is all it uses. */
  asStore(): Store {
    return this as unknown as Store;
  }
}

export type SentRecord = { jid: string; content: Record<string, unknown> & { text?: string } };

export type FakeSocket = WASocket & {
  /** Fires a Baileys event at whatever the manager registered for it. */
  emit: (event: string, payload: unknown) => void;
  ended: boolean;
  /**
   * Whether `logout()` was called — i.e. whether the device was unlinked on the
   * phone. An ownership change must never do this: unlinking destroys a pairing
   * the *other* worker is about to use and costs the clinic a QR scan.
   */
  loggedOut: boolean;
  /** Every `sendMessage` the manager made, in order, with the JID it chose. */
  readonly sends: SentRecord[];
  /** Every on-demand history request the manager made, in order. */
  readonly historyFetches: HistoryFetchRecord[];
  /** Set to make the next `sendMessage` throw, as a transport failure would. */
  sendError: Error | null;
  /** Set to make `fetchMessageHistory` throw, as WhatsApp refusing would. */
  historyFetchError: Error | null;
};

export type HistoryFetchRecord = {
  count: number;
  key: { remoteJid: string; id: string; fromMe: boolean };
  timestampMs: number;
};

export function fakeSocket(
  userJid: string | undefined = undefined,
  options: { ownLid?: string | null } = {},
): FakeSocket {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const sends: SentRecord[] = [];
  const historyFetches: HistoryFetchRecord[] = [];
  let counter = 0;
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => void) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
    },
    user: userJid ? { id: userJid } : undefined,
    // Mirrors the real socket's `authState`, which is where the send path reads
    // this device's own LID from.
    authState: {
      creds: {
        me: {
          id: userJid,
          ...(options.ownLid === undefined ? {} : { lid: options.ownLid ?? undefined }),
        },
      },
    },
    ended: false,
    loggedOut: false,
    sends,
    historyFetches,
    sendError: null as Error | null,
    historyFetchError: null as Error | null,
    end() {
      socket.ended = true;
    },
    async logout() {
      socket.loggedOut = true;
    },
    /**
     * Baileys 6.7.24's on-demand history request. Recorded rather than
     * simulated: what these tests are about is *which* requests the worker
     * makes and under what guards, not what WhatsApp chooses to answer.
     */
    async fetchMessageHistory(
      count: number,
      oldestMsgKey: { remoteJid: string; id: string; fromMe: boolean },
      oldestMsgTimestamp: number,
    ) {
      if (socket.historyFetchError) throw socket.historyFetchError;
      historyFetches.push({ count, key: oldestMsgKey, timestampMs: oldestMsgTimestamp });
      return `pdo-${historyFetches.length}`;
    },
    async sendMessage(jid: string, content: { text?: string }) {
      if (socket.sendError) throw socket.sendError;
      sends.push({ jid, content });
      counter += 1;
      // Shaped like a real Baileys result: the key the caller reports back, and
      // the encoded plaintext the retry cache has to retain.
      return {
        key: { id: `sent-${counter}`, remoteJid: jid, fromMe: true },
        message: { conversation: content.text ?? "" },
      };
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
  return socket as unknown as FakeSocket;
}

/**
 * A socket factory a test drives by hand: the manager's `open()` blocks in it
 * until `release()` is called, which is what "the handshake is still in flight"
 * means throughout this suite.
 */
export function gatedSocketFactory() {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const sockets: FakeSocket[] = [];
  let calls = 0;
  let failure: Error | null = null;

  return {
    get calls() {
      return calls;
    },
    sockets,
    /** Lets the pending handshake finish. */
    release() {
      releaseGate();
    },
    /** Makes the handshake fail instead of succeeding; `null` clears it again. */
    failWith(error: Error | null) {
      failure = error;
    },
    factory: async (): Promise<WASocket> => {
      calls += 1;
      await gate;
      if (failure) throw failure;
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

/**
 * A manager holding one open, identified session for `CLINIC_A`, plus the socket
 * a test fires WhatsApp events at and the callbacks the worker posted.
 *
 * The callback client is not injectable by design — the worker has exactly one
 * way to reach ClinicFlow — so `fetch` itself is replaced. That makes the request
 * line and the signing headers part of what these tests observe, rather than
 * assumptions about them.
 */
export async function connectedSession(
  options: {
    sessionJid?: string;
    /** This device's own LID, as `creds.me.lid`. Omit for an account without one. */
    ownLid?: string | null;
    config?: Partial<WorkerConfig>;
    /** Bytes to hand back for any attachment; omit to make every download fail. */
    media?: Buffer;
    /** Browser-audio normalizer; keeps voice tests independent of local ffmpeg. */
    transcodeVoice?: (bytes: Buffer) => Promise<Buffer>;
    /** Durable Inbox epoch. Defaults old so legacy history tests stay explicit. */
    inboundActiveFrom?: string;
  } = {},
) {
  const store = new FakeStore("worker-under-test");
  const sessionJid = options.sessionJid ?? "201111111111:7@s.whatsapp.net";
  const sessionAccountId = `+${sessionJid.split(":", 1)[0]!.split("@", 1)[0]}`;
  store.seed(CLINIC_A, {
    created_at: options.inboundActiveFrom ?? "1970-01-01T00:00:00.000Z",
    inbound_active_from: options.inboundActiveFrom ?? "1970-01-01T00:00:00.000Z",
    authenticated_account_id: sessionAccountId,
  });
  store.linkedAccounts.set(
    `${CLINIC_A}:${sessionAccountId}`,
    options.inboundActiveFrom ?? "1970-01-01T00:00:00.000Z",
  );
  const socket = fakeSocket(sessionJid, {
    ownLid: options.ownLid === undefined ? "555000111222@lid" : options.ownLid,
  });
  const config = testConfig({ workerId: store.workerId, ...options.config });
  const sessions = new SessionManager(
    config,
    store.asStore(),
    async () => socket,
    async () => {
      if (!options.media) throw new Error("media unavailable in test");
      return options.media;
    },
    options.transcodeVoice,
  );

  const posted: Array<{ url: string; headers: Record<string, string>; body: CallbackBody }> = [];
  const realFetch = globalThis.fetch;
  // What the application answers. A test can make the receiver refuse, so the
  // durable-spool behaviour (retry, `partial`, restart safety) is observable
  // rather than assumed.
  const responder = {
    status: 200 as number,
    /** Overrides the derived summary, so a test can control what is reported. */
    summary: null as Record<string, number> | null,
    /** Refuse only the first N requests, then accept. */
    failFirst: 0,
    /**
     * Answer the way the application does for a clinic with no active
     * linked-device channel: 200, `ignored: true`, and nothing stored.
     */
    ignored: false,
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CallbackBody;
    posted.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    if (responder.failFirst > 0) {
      responder.failFirst -= 1;
      return new Response("upstream", { status: 503 });
    }
    if (responder.status >= 400) {
      return new Response("refused", { status: responder.status });
    }
    if (responder.ignored) {
      // Byte-for-byte what app/api/webhooks/whatsapp/linked-device/route.ts
      // returns when the clinic has no active channel: an acknowledgement with
      // no counters at all, which is exactly why it is indistinguishable from a
      // successful empty batch without the `ignored` flag.
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The counts the worker's bookkeeping now depends on come from the
    // application, not from what the worker parsed — so the stand-in answers
    // like a healthy application would rather than with a bare `{ok:true}`.
    const count = (kind: string) => body.events.filter((event) => event.kind === kind).length;
    const derived = {
      inbound: count("inbound"),
      echoes: count("outbound_echo"),
      replays: 0,
      historyChats: count("history_chat"),
      attachments: 0,
      historyPending: count("history_pending_message"),
      historyReconciled: 0,
      historyDeduplicated: 0,
      historyChatsReceived: body.events
        .filter((event) => event.kind === "history_metrics")
        .reduce((sum, event) => sum + Number(event.chatsReceived ?? 0), 0),
      historyMessagesReceived: body.events
        .filter((event) => event.kind === "history_metrics")
        .reduce((sum, event) => sum + Number(event.messagesReceived ?? 0), 0),
      historyUnsupported: body.events
        .filter((event) => event.kind === "history_metrics")
        .reduce((sum, event) => sum + Number(event.unsupportedMessages ?? 0), 0),
    };
    return new Response(JSON.stringify({ ok: true, ...derived, ...(responder.summary ?? {}) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  await sessions.start(CLINIC_A);
  // `start()` answers before the socket is published, so the events below would
  // otherwise be fired at handlers that are not registered yet.
  await waitFor(() => sessions.clinicIds().includes(CLINIC_A), "the socket to be wired up");
  socket.emit("connection.update", { connection: "open" });
  await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session to identify itself");

  return {
    store,
    socket,
    sessions,
    posted,
    responder,
    /** Fires a `messages.upsert` and waits for the callback it should produce. */
    async upsert(payload: { type: string; messages: unknown[] }): Promise<void> {
      const before = posted.length;
      socket.emit("messages.upsert", payload);
      await waitFor(() => posted.length > before, "a callback to be posted", 500).catch(
        () => undefined,
      );
    },
    /** Fires a `messaging-history.set` and waits for the callbacks it produces. */
    async history(payload: Record<string, unknown>): Promise<void> {
      const before = posted.length;
      socket.emit("messaging-history.set", payload);
      await waitFor(() => posted.length > before, "a history callback to be posted", 1_000).catch(
        () => undefined,
      );
    },
    restore(): void {
      globalThis.fetch = realFetch;
    },
  };
}

export type CallbackBody = {
  clinicId: string;
  sessionPhone: string;
  events: Array<Record<string, unknown>>;
};

/** Every event the worker has posted so far, flattened across callbacks. */
export function postedEvents(
  posted: ReadonlyArray<{ body: CallbackBody }>,
): Array<Record<string, unknown>> {
  return posted.flatMap((request) => request.body.events);
}

/** Waits for an asynchronous effect the manager did not hand us a promise for. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${message}`);
}

/**
 * One socket factory call, held open until the test lets it finish.
 *
 * `gatedSocketFactory` shares a single gate across every call, which is right
 * for "the handshake is slow" but useless for the start/logout race: those tests
 * need the *first* handshake wedged while a *second*, later one runs to
 * completion. Each call here gets its own gate.
 */
export type PendingHandshake = {
  clinicId: string;
  /**
   * The auth state the manager handed the factory. Its `state.creds` is the very
   * object the session holds, so a test can flip `registered` to make the manager
   * treat a drop as an established pairing rather than as a scan that timed out.
   */
  auth: { state: { creds: Record<string, unknown> } };
  /** Lets this one handshake finish and yields the socket it produced. */
  release: () => Promise<FakeSocket>;
  /** Makes this one handshake throw instead of returning a socket. */
  fail: (error: Error) => void;
  /** The socket produced, once released. */
  socket: FakeSocket | null;
};

export function stagedSocketFactory(userJid = "201111111111:7@s.whatsapp.net") {
  const handshakes: PendingHandshake[] = [];

  const factory = async (
    auth: { state: { creds: Record<string, unknown> } },
    _sent: unknown,
    clinicId: string,
  ): Promise<WASocket> => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let failure: Error | null = null;
    let produced: Promise<FakeSocket> | null = null;
    const handshake: PendingHandshake = {
      clinicId,
      auth,
      socket: null,
      fail(error: Error) {
        failure = error;
      },
      release() {
        open();
        // The socket is assigned a tick later, inside the factory body below, so
        // callers get a promise rather than a field that may not be set yet.
        produced ??= (async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await waitFor(() => handshake.socket !== null, "the released handshake to produce a socket");
          return handshake.socket as FakeSocket;
        })();
        return produced;
      },
    };
    handshakes.push(handshake);
    await gate;
    if (failure) throw failure;
    const socket = fakeSocket(userJid);
    handshake.socket = socket;
    return socket as unknown as WASocket;
  };

  return {
    handshakes,
    get calls() {
      return handshakes.length;
    },
    /** The nth call, once the manager has actually reached the factory. */
    async nth(index: number): Promise<PendingHandshake> {
      await waitFor(() => handshakes.length > index, `handshake #${index + 1} to be attempted`);
      return handshakes[index] as PendingHandshake;
    },
    factory,
  };
}

/** A promise plus the handle that settles it, for gating a store call. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
