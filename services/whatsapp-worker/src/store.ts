import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";

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

export type SessionRow = {
  clinic_id: string;
  status: string;
  desired_state: string;
  worker_id: string | null;
  last_heartbeat_at: string | null;
  phone_number: string | null;
};

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
      .select("clinic_id, status, desired_state, worker_id, last_heartbeat_at, phone_number")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return (result.data as SessionRow | null) ?? null;
  }

  /** Creates or updates this clinic's single session row. */
  async upsertSession(
    clinicId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.client.from("whatsapp_linked_device_sessions").upsert(
      {
        clinic_id: clinicId,
        worker_id: this.config.workerId,
        last_heartbeat_at: new Date().toISOString(),
        ...patch,
      },
      { onConflict: "clinic_id" },
    );
    if (result.error) throw new Error(result.error.message);
  }

  async setStatus(
    clinicId: string,
    status: SessionStatus,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    await this.upsertSession(clinicId, { status, ...patch });
  }

  async heartbeat(clinicIds: readonly string[]): Promise<void> {
    if (clinicIds.length === 0) return;
    const result = await this.client
      .from("whatsapp_linked_device_sessions")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .in("clinic_id", [...clinicIds])
      .eq("worker_id", this.config.workerId);
    if (result.error) throw new Error(result.error.message);
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
  }): Promise<{ ok: true } | { ok: false; reason: "identity_taken" | "database" }> {
    const owner = await this.client
      .from("clinic_channels")
      .select("clinic_id")
      .eq("channel", "whatsapp")
      .eq("sender_identity", input.phoneNumber)
      .maybeSingle();
    if (owner.error) return { ok: false, reason: "database" };
    const ownerClinicId = (owner.data as { clinic_id: string } | null)?.clinic_id;
    if (ownerClinicId && ownerClinicId !== input.clinicId) {
      return { ok: false, reason: "identity_taken" };
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
      };
    }

    // One active WhatsApp transport per clinic, decided by the same reviewed
    // RPC the Meta flows use.
    const activated = await this.client.rpc("activate_whatsapp_provider", {
      p_clinic_id: input.clinicId,
      p_provider: "linked_device",
    });
    if (activated.error) return { ok: false, reason: "database" };
    return { ok: true };
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
