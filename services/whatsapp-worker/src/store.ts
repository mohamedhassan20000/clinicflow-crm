import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";
import type { MediaUploadResult } from "./media-types.ts";

/**
 * Every database access this worker makes, in one place.
 *
 * The worker holds the service role, so each function here is written to touch
 * exactly one clinic's rows and always by clinic id — there is no query in this
 * file that can span tenants except the boot-time restore, which reads nothing
 * but the list of clinic ids that asked to be online.
 */

export type SessionStatus =
  | "starting"
  | "awaiting_scan"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type SessionErrorCode = "unavailable" | "pairing_failed" | "logged_out" | "unknown";

/** Which database step of the channel claim ran into trouble. */
export type ChannelClaimStage = "owner_lookup" | "channel_upsert" | "provider_activation";

export type ChannelClaimResult =
  | { ok: true }
  | {
      ok: false;
      reason: "identity_taken" | "database";
      stage: ChannelClaimStage;
      /** PostgREST/Postgres SQLSTATE, e.g. "42804" or "23505". */
      code?: string;
      /** Postgres primary message only — never `details`/`hint`, see below. */
      message?: string;
    };

/**
 * Reduces a PostgREST error to the parts that are safe to put in a log line.
 *
 * `code` and `message` are schema-level facts ("column x is of type y",
 * 'duplicate key value violates unique constraint "..."'). `details` and `hint`
 * are deliberately dropped: Postgres embeds the offending *values* in them —
 * `Key (sender_identity)=(<the clinic's phone number>) already exists` — and a
 * paired number is exactly the kind of identifier this worker must not print.
 */
function safeDbError(
  error: { code?: string; message?: string } | null,
): { code?: string; message?: string } {
  if (!error) return {};
  return { code: error.code, message: error.message };
}

export type SessionRow = {
  clinic_id: string;
  status: string;
  desired_state: string;
  worker_id: string | null;
  last_heartbeat_at: string | null;
  phone_number: string | null;
  handoff_to?: string | null;
  handoff_requested_at?: string | null;
  created_at: string;
  inbound_active_from: string | null;
  authenticated_account_id: string | null;
  authenticated_account_lid: string | null;
};

/**
 * A session row whose worker stopped heart-beating may be taken over.
 *
 * Lives here rather than in `sessions.ts` because the predicate that enforces it
 * is now a SQL `WHERE` clause in `claimSession`, not a comparison in the
 * manager. One definition, one place it is applied.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * How long a handoff request stays binding.
 *
 * A request fences the current owner out of re-claiming the session it just
 * released, which is the whole point — without it the holder's own reconcile
 * sweep would take the clinic straight back before the requester noticed it was
 * free. But a fence with no expiry is a way to leave a clinic dark forever: a
 * developer closes their laptop mid-handoff and the production worker is locked
 * out of a session nobody is holding. Ten minutes is far longer than the ~90
 * seconds a real handoff takes and far shorter than anyone would tolerate an
 * outage.
 */
export const HANDOFF_TTL_MS = 10 * 60_000;

const SESSION_COLUMNS =
  "clinic_id, status, desired_state, worker_id, last_heartbeat_at, phone_number, handoff_to, handoff_requested_at, created_at, inbound_active_from, authenticated_account_id, authenticated_account_lid";

export class Store {
  private readonly client: SupabaseClient;
  // Not a constructor parameter property: `node --experimental-strip-types`
  // runs this source directly in development and cannot desugar those.
  private readonly config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async readSession(clinicId: string): Promise<SessionRow | null> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .select(SESSION_COLUMNS)
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return (result.data as SessionRow | null) ?? null;
  }

  /**
   * Writes this clinic's visible state without ever writing ownership.
   *
   * This used to be an unconditional upsert that stamped `worker_id` with this
   * instance's id, and that was two bugs wearing one coat.
   *
   * The first is an ownership bypass. `claimSession` is documented as the only
   * write that may *take* a session, and the single-owner invariant rests on
   * that being true — but every `setStatus` call was quietly a second one. Most
   * of them happen to run on a row this worker has already claimed, so the
   * stamp was a no-op and the hole stayed invisible. Two are not: `logout()`
   * reaches its no-live-socket branch for any clinic the application names,
   * held by anyone, and `recordStartFailure()` can land after ownership has
   * moved. Either one would hand this worker a row it never claimed.
   *
   * The second is the self-handoff violation. A worker that has asked for a
   * session it does not hold leaves `handoff_to = <its own id>` on a row still
   * owned by somebody else. The moment one of those two paths stamped
   * `worker_id` with the same id, the row read `handoff_to = worker_id` — which
   * `whatsapp_linked_device_sessions_handoff_not_self` refuses (SQLSTATE 23514).
   * The clinic's disconnect failed with a 500 from a check constraint that was
   * doing exactly its job.
   *
   * So the write is split by what it is entitled to touch. If this worker owns
   * the row, the scoped `UPDATE` refreshes the heartbeat along with the state,
   * exactly as before. If it does not, the fallback writes the clinic-visible
   * columns and *nothing else*: no `worker_id`, no `last_heartbeat_at` (which
   * would otherwise keep a dead owner's row looking alive and delay a legitimate
   * adoption), and no `handoff_to`. Ownership and the fence are now unreachable
   * from here, which is what makes the constraint impossible to violate rather
   * than merely unlikely to be.
   */
  async writeSessionState(clinicId: string, patch: Record<string, unknown>): Promise<void> {
    const owned = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ last_heartbeat_at: new Date().toISOString(), ...patch })
      .eq("clinic_id", clinicId)
      .eq("worker_id", this.config.workerId)
      .select("clinic_id");
    if (owned.error) throw new Error(owned.error.message);
    if ((owned.data ?? []).length > 0) return;

    // Not ours — or not there yet. Either way the state is still the clinic's to
    // see, so it is written on its own, with no ownership column in the payload.
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .upsert({ clinic_id: clinicId, ...patch }, { onConflict: "clinic_id" });
    if (result.error) throw new Error(result.error.message);
  }

  async setStatus(
    clinicId: string,
    status: SessionStatus,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    await this.writeSessionState(clinicId, { status, ...patch });
  }

  /**
   * Establishes the ClinicFlow Inbox epoch exactly once. Reconnects, QR
   * rescans, ownership handoffs and logout status changes never move it.
   */
  async ensureInboundActiveFrom(clinicId: string, proposed: string): Promise<string> {
    const updated = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ inbound_active_from: proposed })
      .eq("clinic_id", clinicId)
      .is("inbound_active_from", null)
      .select("inbound_active_from")
      .maybeSingle();
    if (updated.error) throw new Error(updated.error.message);
    const written = (updated.data as { inbound_active_from?: string | null } | null)
      ?.inbound_active_from;
    if (written) return written;
    const existing = await this.readSession(clinicId);
    return existing?.inbound_active_from ?? existing?.created_at ?? proposed;
  }

  /**
   * Binds a live Baileys identity to its durable account boundary.
   *
   * The normalized phone JID is the stable account key. A worker restart or a
   * re-pair of the same number reuses the account row and its Inbox epoch; a
   * different number creates a new boundary without deleting the old one.
   */
  async bindLinkedAccount(input: {
    clinicId: string;
    accountId: string;
    accountLid: string | null;
    proposedBoundary: string;
  }): Promise<{ inboundActiveFrom: string; changed: boolean }> {
    const result = await this.client.rpc("bind_whatsapp_linked_account", {
      p_clinic_id: input.clinicId,
      p_authenticated_account_id: input.accountId,
      p_authenticated_account_lid: input.accountLid ?? undefined,
      p_proposed_boundary: input.proposedBoundary,
    });
    if (result.error) throw new Error(result.error.message);
    const row = (result.data ?? [])[0] as
      | { inbound_active_from: string; account_changed: boolean }
      | undefined;
    if (!row?.inbound_active_from) throw new Error("LINKED_ACCOUNT_BIND_FAILED");
    return {
      inboundActiveFrom: row.inbound_active_from,
      changed: row.account_changed,
    };
  }

  /** Preserves old-account spool rows while making them ineligible for delivery. */
  async supersedeHistoryBatches(clinicId: string, activeAccountId: string): Promise<void> {
    const result = await this.client.rpc("supersede_whatsapp_history_batches", {
      p_clinic_id: clinicId,
      p_active_session_phone: activeAccountId,
    });
    if (result.error) throw new Error(result.error.message);
  }

  /**
   * Refreshes the heartbeat on the rows this worker still owns, and reports
   * **which ones those were**.
   *
   * The `UPDATE` was always scoped to `worker_id = me`, so a worker that had
   * lost a clinic could never stamp it — but the result was discarded, which
   * made the scoping a purely defensive measure and threw away the one signal
   * that says *this worker is no longer the owner*. A laptop suspended past the
   * 90-second stale window and then resumed is precisely that case: Railway
   * reclaimed the clinic while the process was frozen, and on resume the socket,
   * the reconnect timers and the auth writer are all still pointed at a pairing
   * somebody else now holds.
   *
   * Returning the matched ids turns this one statement into both the liveness
   * write and the ownership assertion, with no extra round trip. Anything the
   * caller asked for and does not get back is a clinic it must stop serving —
   * see `SessionManager.heartbeat` and `fenceLostOwnership`.
   */
  async heartbeat(clinicIds: readonly string[]): Promise<string[]> {
    if (clinicIds.length === 0) return [];
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .in("clinic_id", [...clinicIds])
      .eq("worker_id", this.config.workerId)
      .select("clinic_id");
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as Array<{ clinic_id: string }>).map((row) => row.clinic_id);
  }

  /**
   * Gives up this instance's claim on the sessions it was holding.
   *
   * Called on graceful shutdown. `desired_state` is deliberately left alone —
   * the clinics still want to be online — but clearing the ownership stamp lets
   * the replacement instance adopt them at once instead of waiting out the
   * stale-heartbeat window. Scoped to rows this worker actually owns, so a
   * shutting-down instance can never release another's sessions.
   */
  async releaseOwnership(clinicIds: readonly string[]): Promise<void> {
    if (clinicIds.length === 0) return;
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ worker_id: null, last_heartbeat_at: null })
      .in("clinic_id", [...clinicIds])
      .eq("worker_id", this.config.workerId);
    if (result.error) throw new Error(result.error.message);
  }

  /**
   * Becomes this session's owner, or does not — atomically, in one statement.
   *
   * This is the only write in the worker that may *take* a session, and the
   * single-owner invariant rests on it being a compare-and-swap rather than the
   * read-then-write it replaced. The old admission path read the row, decided the
   * owner was stale, and then wrote unconditionally; between those two round
   * trips another worker could claim the clinic and this one would overwrite its
   * stamp and open a second socket on the same device identity. The window was
   * small and entirely real. Here the decision and the write are the same
   * `UPDATE ... WHERE`, so exactly one of two racing workers can come back true.
   *
   * A row may be claimed when it is unowned, already ours, or held by a worker
   * whose heartbeat has gone stale — and, independently, only when no *live*
   * handoff request names somebody else. The second condition is what stops the
   * releasing worker's own reconcile sweep from taking a clinic straight back in
   * the seconds before the requester notices it is free.
   *
   * Claiming clears `handoff_to`: whoever asked has now been answered.
   */
  async claimSession(clinicId: string, patch: Record<string, unknown> = {}): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.valueOf() - HEARTBEAT_STALE_MS).toISOString();
    const handoffExpiredBefore = new Date(now.valueOf() - HANDOFF_TTL_MS).toISOString();
    const worker = this.config.workerId;
    const claim = {
      worker_id: worker,
      last_heartbeat_at: now.toISOString(),
      handoff_to: null,
      handoff_requested_at: null,
      ...patch,
    };
    // Two `or` groups, which PostgREST ANDs: "the seat is available to me" and
    // "nobody else is holding it for themselves". `workerId` is validated
    // against a slug alphabet at boot precisely because it lands in this string.
    const updated = await this.client
      .from("whatsapp_linked_device_sessions")
      .update(claim)
      .eq("clinic_id", clinicId)
      .or(
        `worker_id.is.null,worker_id.eq.${worker},last_heartbeat_at.is.null,last_heartbeat_at.lt.${staleBefore}`,
      )
      .or(
        `handoff_to.is.null,handoff_to.eq.${worker},handoff_requested_at.is.null,handoff_requested_at.lt.${handoffExpiredBefore}`,
      )
      .select("clinic_id");
    if (updated.error) throw new Error(updated.error.message);
    if ((updated.data ?? []).length > 0) return true;

    // Nothing matched. Either a live owner holds it — the ordinary refusal — or
    // this clinic has no row yet, which is every first pairing.
    const existing = await this.readSession(clinicId);
    if (existing) return false;
    const inserted = await this.client
      .from("whatsapp_linked_device_sessions")
      .insert({ clinic_id: clinicId, ...claim });
    if (!inserted.error) return true;
    // Another worker inserted the row between the read and this write. It is now
    // an ordinary contended row, so ask the question the ordinary way exactly
    // once; a second loss means somebody else genuinely owns it.
    if (inserted.error.code !== "23505") throw new Error(inserted.error.message);
    const retry = await this.client
      .from("whatsapp_linked_device_sessions")
      .update(claim)
      .eq("clinic_id", clinicId)
      .or(
        `worker_id.is.null,worker_id.eq.${worker},last_heartbeat_at.is.null,last_heartbeat_at.lt.${staleBefore}`,
      )
      .or(
        `handoff_to.is.null,handoff_to.eq.${worker},handoff_requested_at.is.null,handoff_requested_at.lt.${handoffExpiredBefore}`,
      )
      .select("clinic_id");
    if (retry.error) throw new Error(retry.error.message);
    return (retry.data ?? []).length > 0;
  }

  /**
   * Asks the current owner for this session. Does not take it.
   *
   * Deliberately incapable of causing split brain: it writes `handoff_to` and
   * nothing else, so the holder's socket, its heartbeat and its ownership stamp
   * are all untouched and every send in flight completes normally. The holder
   * decides when to let go, and the requester still has to win `claimSession`
   * afterwards like anyone else.
   *
   * Scoped to rows somebody else actually owns, so it can neither fence an
   * unowned clinic nor let a worker request a session from itself.
   *
   * Returns whether a request was recorded.
   */
  async requestHandoff(clinicId: string): Promise<boolean> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ handoff_to: this.config.workerId, handoff_requested_at: new Date().toISOString() })
      .eq("clinic_id", clinicId)
      .not("worker_id", "is", null)
      .neq("worker_id", this.config.workerId)
      .select("clinic_id");
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).length > 0;
  }

  /** Sessions this worker holds that another worker has asked for. */
  async listHandoffRequests(): Promise<string[]> {
    const expiredBefore = new Date(Date.now() - HANDOFF_TTL_MS).toISOString();
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .select("clinic_id")
      .eq("worker_id", this.config.workerId)
      .not("handoff_to", "is", null)
      .neq("handoff_to", this.config.workerId)
      .gte("handoff_requested_at", expiredBefore);
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as Array<{ clinic_id: string }>).map((row) => row.clinic_id);
  }

  /**
   * Withdraws this worker's outstanding handoff requests.
   *
   * Called on shutdown so a developer who quits mid-handoff hands the fence back
   * immediately instead of leaving the production worker to wait out
   * `HANDOFF_TTL_MS`. The TTL remains the guarantee; this is the courtesy.
   */
  async clearHandoffRequests(): Promise<void> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ handoff_to: null, handoff_requested_at: null })
      .eq("handoff_to", this.config.workerId);
    if (result.error) throw new Error(result.error.message);
  }

  /**
   * Rows already stamped with this worker's id and still heart-beating.
   *
   * Read once at boot, before this process has written anything. A hit means
   * another live process is running under the same `WORKER_ID` — the one
   * configuration mistake that defeats the ownership check completely, because
   * two workers with one id each read the other's stamp as their own and both
   * open a socket.
   */
  async listLiveSessionsOwnedByThisWorkerId(): Promise<string[]> {
    const freshSince = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .select("clinic_id")
      .eq("worker_id", this.config.workerId)
      .gte("last_heartbeat_at", freshSince);
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as Array<{ clinic_id: string }>).map((row) => row.clinic_id);
  }

  /** The clinics that asked to stay connected — the boot-time restore list. */
  async listRestorableClinics(): Promise<string[]> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .select("clinic_id")
      .eq("desired_state", "online");
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as Array<{ clinic_id: string }>).map((row) => row.clinic_id);
  }

  // -- Authentication state ------------------------------------------------

  async readAuthValue(clinicId: string, keyType: string, keyId: string): Promise<string | null> {
    const result = await this.client
      .from("whatsapp_linked_device_auth")
      .select("value_encrypted")
      .eq("clinic_id", clinicId)
      .eq("key_type", keyType)
      .eq("key_id", keyId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return (result.data as { value_encrypted: string } | null)?.value_encrypted ?? null;
  }

  async writeAuthValues(
    clinicId: string,
    rows: ReadonlyArray<{ keyType: string; keyId: string; value: string }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const result = await this.client.from("whatsapp_linked_device_auth").upsert(
      rows.map((row) => ({
        clinic_id: clinicId,
        key_type: row.keyType,
        key_id: row.keyId,
        value_encrypted: row.value,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "clinic_id,key_type,key_id" },
    );
    if (result.error) throw new Error(result.error.message);
  }

  async deleteAuthValues(
    clinicId: string,
    rows: ReadonlyArray<{ keyType: string; keyId: string }>,
  ): Promise<void> {
    for (const row of rows) {
      const result = await this.client
        .from("whatsapp_linked_device_auth")
        .delete()
        .eq("clinic_id", clinicId)
        .eq("key_type", row.keyType)
        .eq("key_id", row.keyId);
      if (result.error) throw new Error(result.error.message);
    }
  }

  async clearAuth(clinicId: string): Promise<void> {
    const result = await this.client
      .from("whatsapp_linked_device_auth")
      .delete()
      .eq("clinic_id", clinicId);
    if (result.error) throw new Error(result.error.message);
  }

  // -- The clinic's messaging channel --------------------------------------

  /**
   * Claims the paired number as this clinic's active WhatsApp channel.
   *
   * The globally unique sender-identity index is what makes this safe across
   * tenants: if another clinic already holds this number the insert fails and
   * the pairing is reported as failed rather than silently stealing it.
   */
  async activateChannel(input: {
    clinicId: string;
    phoneNumber: string;
    credentialsEncrypted: string;
  }): Promise<ChannelClaimResult> {
    const owner = await this.client
      .from("clinic_channels")
      .select("clinic_id")
      .eq("channel", "whatsapp")
      .eq("sender_identity", input.phoneNumber)
      .maybeSingle();
    if (owner.error) {
      return { ok: false, reason: "database", stage: "owner_lookup", ...safeDbError(owner.error) };
    }
    const ownerClinicId = (owner.data as { clinic_id: string } | null)?.clinic_id;
    if (ownerClinicId && ownerClinicId !== input.clinicId) {
      return { ok: false, reason: "identity_taken", stage: "owner_lookup" };
    }

    const now = new Date().toISOString();
    const stored = await this.client.from("clinic_channels").upsert(
      {
        clinic_id: input.clinicId,
        channel: "whatsapp",
        provider: "linked_device",
        sender_identity: input.phoneNumber,
        credentials_encrypted: input.credentialsEncrypted,
        status: "pending",
        connection_state: "connected",
        connected_at: now,
        last_signal_at: now,
        last_state_reason: null,
        onboarding_flow: null,
        webhook_subscribed: false,
      },
      { onConflict: "clinic_id,channel,provider" },
    );
    if (stored.error) {
      return {
        ok: false,
        reason: stored.error.code === "23505" ? "identity_taken" : "database",
        stage: "channel_upsert",
        ...safeDbError(stored.error),
      };
    }

    // One active WhatsApp transport per clinic, decided by the same reviewed
    // RPC the Meta flows use.
    const activated = await this.client.rpc("activate_whatsapp_provider", {
      p_clinic_id: input.clinicId,
      p_provider: "linked_device",
    });
    if (activated.error) {
      return {
        ok: false,
        reason: "database",
        stage: "provider_activation",
        ...safeDbError(activated.error),
      };
    }
    return { ok: true };
  }

  // -- Attachments and history bookkeeping ---------------------------------

  /**
   * Writes one downloaded attachment into the private bucket.
   *
   * The path is built by the caller from the clinic id it was authorized for and
   * a fresh identifier, and `upsert: false` is what makes a replayed callback
   * unable to overwrite bytes already stored. `contentType` is the *sniffed*
   * type, so the bucket's own allowed-mime list is checked against what the file
   * really is rather than what the sender claimed.
   */
  async uploadAttachment(input: {
    clinicId: string;
    path: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<MediaUploadResult> {
    if (!input.path.startsWith(`${input.clinicId}/`)) {
      return { ok: false, errorCategory: "validation", errorCode: "tenant_path" };
    }
    const result = await this.client.storage
      .from(this.config.attachmentBucket)
      .upload(input.path, input.bytes, {
        contentType: input.contentType,
        upsert: false,
      });
    if (!result.error) return { ok: true };
    const error = result.error as unknown as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const rawCode = error.code ?? error.statusCode ?? error.status;
    const errorCode =
      (typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode)) ||
      (typeof rawCode === "number" && Number.isInteger(rawCode))
        ? String(rawCode)
        : "unknown";
    return { ok: false, errorCategory: "storage_api", errorCode };
  }

  /**
   * Downloads one application-authorized outbound object. The worker repeats
   * the bucket and tenant-prefix checks so a compromised caller cannot turn its
   * service role into an arbitrary storage reader.
   */
  async downloadOutboundMedia(input: {
    clinicId: string;
    bucket: string;
    storagePath: string;
  }): Promise<Buffer | null> {
    const prefixes: Record<string, string> = {
      "whatsapp-outbound": `${input.clinicId}/`,
      "patient-assets": `documents/${input.clinicId}/`,
      "clinic-documents": `documents/${input.clinicId}/`,
    };
    const prefix = prefixes[input.bucket];
    if (
      !prefix ||
      !input.storagePath.startsWith(prefix) ||
      input.storagePath.startsWith("/") ||
      input.storagePath.includes("..")
    ) {
      return null;
    }
    const result = await this.client.storage.from(input.bucket).download(input.storagePath);
    if (
      result.error ||
      !result.data ||
      result.data.size <= 0 ||
      result.data.size > this.config.outboundMediaMaxBytes
    ) {
      return null;
    }
    const bytes = Buffer.from(await result.data.arrayBuffer());
    return bytes.length > 0 && bytes.length <= this.config.outboundMediaMaxBytes ? bytes : null;
  }

  /** Writes observed contact labels only; the RPC creates neither patients nor links. */
  async upsertContacts(
    clinicId: string,
    authenticatedAccountId: string,
    contacts: ReadonlyArray<{ participantAddress: string; displayName: string | null }>,
  ): Promise<void> {
    if (contacts.length === 0) return;
    for (let offset = 0; offset < contacts.length; offset += 200) {
      const result = await this.client.rpc("upsert_linked_device_contacts", {
        p_clinic_id: clinicId,
        p_authenticated_account_id: authenticatedAccountId,
        p_contacts: contacts.slice(offset, offset + 200).map((contact) => ({
          participantAddress: contact.participantAddress,
          displayName: contact.displayName,
        })),
      });
      if (result.error) throw new Error(result.error.message);
    }
  }

  /** Durable WhatsApp-asserted identity pairs; never derived from LID digits. */
  async upsertLidMappings(
    clinicId: string,
    authenticatedAccountId: string,
    mappings: ReadonlyArray<{ lid: string; phone: string }>,
  ): Promise<void> {
    if (mappings.length === 0) return;
    const result = await this.client.rpc("upsert_linked_device_lid_mappings", {
      p_clinic_id: clinicId,
      p_authenticated_account_id: authenticatedAccountId,
      p_mappings: mappings.map((mapping) => ({ lid: mapping.lid, participant: mapping.phone })),
    });
    if (result.error) throw new Error(result.error.message);
  }

  async loadLidMappings(
    clinicId: string,
    authenticatedAccountId: string,
  ): Promise<Array<{ lid: string; phone: string }>> {
    const result = await this.client
      .from("whatsapp_lid_mappings")
      .select("lid_jid, participant_address")
      .eq("clinic_id", clinicId)
      .eq("authenticated_account_id", authenticatedAccountId);
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as Array<{ lid_jid: string; participant_address: string }>).map(
      (row) => ({ lid: row.lid_jid, phone: row.participant_address }),
    );
  }

  /**
   * The oldest message this clinic holds per conversation, for the *currently
   * authenticated account only*.
   *
   * These are the anchors an on-demand history request has to be hung on — see
   * history-resync.ts for why WhatsApp offers no anchorless form. Two reads
   * rather than one embedded join, so the account scope is a literal `WHERE` on
   * `conversations.whatsapp_account_id` that cannot be widened by a PostgREST
   * embedding rule: a conversation that is not stamped with this account never
   * enters the candidate set, and therefore can never be resynced.
   *
   * Bounded on both sides. The conversation page is the account's most recent
   * threads; the message scan is ascending by occurrence, so the first row seen
   * for a conversation *is* its oldest. A truncated scan yields fewer anchors,
   * never wrong ones.
   */
  async loadHistoryResyncAnchors(
    clinicId: string,
    authenticatedAccountId: string,
    limits: { conversations?: number; messages?: number } = {},
  ): Promise<
    Array<{
      participantAddress: string;
      providerMessageId: string;
      fromMe: boolean;
      occurredAt: string;
    }>
  > {
    const conversations = await this.client
      .from("conversations")
      .select("id, participant_address")
      .eq("clinic_id", clinicId)
      .eq("channel", "whatsapp")
      .eq("whatsapp_account_id", authenticatedAccountId)
      .not("participant_address", "is", null)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limits.conversations ?? 200);
    if (conversations.error) throw new Error(conversations.error.message);
    const rows = (conversations.data ?? []) as Array<{
      id: string;
      participant_address: string | null;
    }>;
    const addresses = new Map<string, string>();
    for (const row of rows) {
      if (row.participant_address) addresses.set(row.id, row.participant_address);
    }
    if (addresses.size === 0) return [];

    const messages = await this.client
      .from("inbound_messages")
      .select("conversation_id, provider_message_id, received_at")
      .eq("clinic_id", clinicId)
      .eq("channel", "whatsapp")
      .in("conversation_id", [...addresses.keys()])
      .not("provider_message_id", "is", null)
      .order("received_at", { ascending: true })
      .limit(limits.messages ?? 2_000);
    if (messages.error) throw new Error(messages.error.message);

    const oldest = new Map<string, {
      participantAddress: string;
      providerMessageId: string;
      fromMe: boolean;
      occurredAt: string;
    }>();
    for (const row of (messages.data ?? []) as Array<{
      conversation_id: string;
      provider_message_id: string | null;
      received_at: string;
    }>) {
      const participantAddress = addresses.get(row.conversation_id);
      if (!participantAddress || !row.provider_message_id) continue;
      if (oldest.has(row.conversation_id)) continue;
      oldest.set(row.conversation_id, {
        participantAddress,
        providerMessageId: row.provider_message_id,
        // Inbound by construction: this reads the patient's own messages, which
        // is the anchor form WhatsApp answers most reliably.
        fromMe: false,
        occurredAt: row.received_at,
      });
    }
    return [...oldest.values()];
  }

  /**
   * Marks the import as started. Everything after this point is decided by
   * {@link recordHistoryDelivery}, which computes the status from the delivery
   * spool rather than from what the worker believes it sent.
   */
  async beginHistoryImport(clinicId: string): Promise<void> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({
        history_status: "importing",
        history_started_at: new Date().toISOString(),
        history_last_error: null,
      })
      .eq("clinic_id", clinicId)
      .in("history_status", ["idle", "importing", "partial", "unavailable"]);
    if (result.error) throw new Error(result.error.message);
  }

  /**
   * Writes interpreted history batches to the durable spool.
   *
   * Called *before* any delivery is attempted, which is the whole point: from
   * here on the unit of recovery is a row, not a stack frame. `batchKey` is
   * derived from the batch's own contents *and the authenticated account that
   * produced them*, so re-interpreting the same `messaging-history.set` payload
   * after a restart enqueues nothing new, while the same payload under a
   * different account is a distinct row rather than a silent duplicate.
   *
   * Returns how many rows were newly enqueued.
   */
  async enqueueHistoryBatches(input: {
    clinicId: string;
    sessionPhone: string;
    batches: ReadonlyArray<{ batchKey: string; payload: unknown[]; eventCount: number }>;
  }): Promise<number> {
    if (input.batches.length === 0) return 0;
    const result = await this.client
      .from("whatsapp_history_delivery_batches")
      .upsert(
        input.batches.map((batch) => ({
          clinic_id: input.clinicId,
          session_phone: input.sessionPhone,
          batch_key: batch.batchKey,
          payload: batch.payload,
          event_count: batch.eventCount,
        })),
        { onConflict: "clinic_id,batch_key", ignoreDuplicates: true },
      )
      .select("id");
    if (result.error) throw new Error(result.error.message);
    return result.data?.length ?? 0;
  }

  /**
   * Takes up to `limit` undelivered batches for this worker to post.
   *
   * `exclude` is the set this drain pass has already attempted. A failed batch
   * has its claim released so the *next* pass can take it; without the exclusion
   * the pass that just failed it would be handed it straight back.
   */
  async claimHistoryBatches(
    clinicId: string,
    limit = 5,
    exclude: readonly string[] = [],
  ): Promise<Array<{ id: string; sessionPhone: string; payload: unknown[] }>> {
    const result = await this.client.rpc("claim_whatsapp_history_batches", {
      p_clinic_id: clinicId,
      p_worker_id: this.config.workerId,
      p_limit: limit,
      p_exclude_ids: [...exclude],
    });
    if (result.error) throw new Error(result.error.message);
    const rows = (result.data ?? []) as Array<{
      id: string;
      session_phone: string;
      payload: unknown;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionPhone: row.session_phone,
      payload: Array.isArray(row.payload) ? row.payload : [],
    }));
  }

  /**
   * Puts a claimed batch back exactly as it was found.
   *
   * Deliberately *not* {@link recordHistoryDelivery} with `delivered: false`:
   * that counts an attempt, and eight of those retire the row as `failed`. This
   * is for the case where the worker never processed the batch at all — the
   * application answered "no active channel, I ignored it" — so consuming an
   * attempt would slowly destroy an import that is merely waiting for its clinic
   * to re-link. Nothing but the claim stamp is touched: `status` stays
   * `pending`, `attempts` stays where it was, and any later drain (this worker's
   * or another's) picks the row up untouched.
   *
   * The claim would expire on its own after the stale window; releasing it here
   * simply stops a row sitting falsely claimed for five minutes by a worker that
   * has already moved on.
   */
  async releaseHistoryClaim(clinicId: string, batchId: string): Promise<void> {
    const result = await this.client
      .from("whatsapp_history_delivery_batches")
      .update({ claimed_by: null, claimed_at: null })
      .eq("id", batchId)
      .eq("clinic_id", clinicId)
      .eq("status", "pending");
    if (result.error) throw new Error(result.error.message);
  }

  /**
   * Records one batch's outcome and recomputes the clinic-visible import status.
   *
   * The status is decided in the database because that is the only place that
   * can see the whole spool: `complete` requires both that the phone reported its
   * last batch and that no batch is still pending. A batch whose retries are
   * exhausted leaves the import `partial` rather than silently `complete`.
   */
  async recordHistoryDelivery(input: {
    clinicId: string;
    batchId?: string | null;
    delivered?: boolean | null;
    chats?: number;
    messages?: number;
    error?: string | null;
    finalBatchSeen?: boolean;
  }): Promise<{ status: string; pending: number; failed: number }> {
    const result = await this.client.rpc("record_whatsapp_history_delivery", {
      p_clinic_id: input.clinicId,
      p_batch_id: input.batchId ?? undefined,
      p_delivered: input.delivered ?? undefined,
      p_chats: input.chats ?? 0,
      p_messages: input.messages ?? 0,
      p_error: input.error ?? undefined,
      p_final_batch_seen: input.finalBatchSeen ?? false,
    });
    if (result.error) throw new Error(result.error.message);
    const row = (result.data ?? [])[0] as
      | { history_status: string; pending_batches: number; failed_batches: number }
      | undefined;
    return {
      status: row?.history_status ?? "importing",
      pending: row?.pending_batches ?? 0,
      failed: row?.failed_batches ?? 0,
    };
  }

  async recordHistoryMetrics(input: {
    clinicId: string;
    batchId: string;
    chatsReceived: number;
    messagesReceived: number;
    deduplicated: number;
    unsupported: number;
  }): Promise<{ status: string; pending: number }> {
    const result = await this.client.rpc("record_whatsapp_history_metrics", {
      p_clinic_id: input.clinicId,
      p_batch_id: input.batchId,
      p_chats_received: input.chatsReceived,
      p_messages_received: input.messagesReceived,
      p_deduplicated: input.deduplicated,
      p_unsupported: input.unsupported,
    });
    if (result.error) throw new Error(result.error.message);
    const row = (result.data ?? [])[0] as
      | { history_status: string; messages_pending: number }
      | undefined;
    return { status: row?.history_status ?? "importing", pending: row?.messages_pending ?? 0 };
  }

  /** Clinics with history batches still waiting to be delivered. */
  async listClinicsWithPendingHistory(): Promise<string[]> {
    const result = await this.client
      .from("whatsapp_history_delivery_batches")
      .select("clinic_id")
      .eq("status", "pending");
    if (result.error) throw new Error(result.error.message);
    return [
      ...new Set(((result.data ?? []) as Array<{ clinic_id: string }>).map((row) => row.clinic_id)),
    ];
  }

  /** Whether this clinic has already completed a history import. */
  async readHistoryStatus(clinicId: string): Promise<string | null> {
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .select("history_status")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return (result.data as { history_status: string } | null)?.history_status ?? null;
  }

  async removeChannel(clinicId: string): Promise<void> {
    const result = await this.client
      .from("clinic_channels")
      .delete()
      .eq("clinic_id", clinicId)
      .eq("channel", "whatsapp")
      .eq("provider", "linked_device");
    if (result.error) throw new Error(result.error.message);
  }
}
