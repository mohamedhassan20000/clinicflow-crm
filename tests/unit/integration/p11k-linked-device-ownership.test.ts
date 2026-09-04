/**
 * P11K — the single-owner invariant, against real Postgres through real PostgREST.
 *
 * The worker's own suite proves the *manager's* control flow with an in-memory
 * store. What it cannot prove is the half of the fix that is not TypeScript:
 * `Store.claimSession` decides ownership inside a single conditional `UPDATE`,
 * expressed as two PostgREST `or` groups, and the entire safety argument rests
 * on those groups being ANDed and on the update being atomic. A hand-written
 * fake will agree with whatever the author believed. Only the real filter,
 * against the real table and the real check constraint, can disagree.
 *
 * So this suite runs the actual `Store` class the worker ships, pointed at the
 * local Supabase stack, and asserts the four things the invariant is made of:
 * a live owner cannot be displaced, a dead one can, a handoff request is a
 * request and not a seizure, and an expired request stops fencing.
 *
 * Requires the local Supabase stack (`supabase start`). Never point it at a
 * hosted project: it writes session rows.
 */

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store, HANDOFF_TTL_MS, HEARTBEAT_STALE_MS } from "../../../services/whatsapp-worker/src/store";
import type { WorkerConfig } from "../../../services/whatsapp-worker/src/config";
import { DEV_CLINIC, seedDevClinic } from "@/scripts/seed-dev-clinic";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;

const CLINIC = DEV_CLINIC.id;
const PROD = "railway-prod";
const DEV = "local-dev";

function workerStore(workerId: string): Store {
  // Only the four fields `Store` reads; the rest of `WorkerConfig` belongs to
  // the socket and the callback paths, which this suite does not exercise.
  const config = {
    workerId,
    supabaseUrl: url,
    supabaseServiceRoleKey: secretKey as string,
    credentialsKey: Buffer.alloc(32, 7),
  } as unknown as WorkerConfig;
  return new Store(config);
}

const service = createClient<Database>(url, secretKey ?? "missing", {
  auth: { autoRefreshToken: false, persistSession: false },
});

type SessionUpdate = Database["public"]["Tables"]["whatsapp_linked_device_sessions"]["Update"];

/** Rewrites the row's clocks directly, standing in for the passage of time. */
async function backdate(patch: SessionUpdate) {
  const result = await service
    .from("whatsapp_linked_device_sessions")
    .update(patch)
    .eq("clinic_id", CLINIC);
  expect(result.error).toBeNull();
}

async function readRow() {
  const result = await service
    .from("whatsapp_linked_device_sessions")
    .select("worker_id, handoff_to, handoff_requested_at, desired_state, status")
    .eq("clinic_id", CLINIC)
    .maybeSingle();
  expect(result.error).toBeNull();
  return result.data;
}

async function clearRow() {
  await service.from("whatsapp_linked_device_sessions").delete().eq("clinic_id", CLINIC);
}

describe.runIf(Boolean(secretKey))("P11K linked-device ownership (local Postgres)", () => {
  beforeAll(async () => {
    await seedDevClinic();
    await clearRow();
  });
  afterAll(clearRow);

  it("gives a contested first claim to exactly one worker", async () => {
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);

    // Both workers boot at once against a clinic with no row at all — the
    // insert path, which is the one place two workers can race to *create*
    // ownership rather than take it.
    const outcomes = await Promise.all([
      prod.claimSession(CLINIC, { status: "starting", desired_state: "online" }),
      dev.claimSession(CLINIC, { status: "starting", desired_state: "online" }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const row = await readRow();
    expect([PROD, DEV]).toContain(row?.worker_id);
  });

  it("refuses a live owner and admits a stale one", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);

    expect(await prod.claimSession(CLINIC, { status: "starting", desired_state: "online" })).toBe(
      true,
    );
    expect(await dev.claimSession(CLINIC)).toBe(false);
    expect((await readRow())?.worker_id).toBe(PROD);

    // The owner stopped without releasing anything — a crash, an OOM, a killed
    // container. The stale window is the only thing that frees the clinic.
    await backdate({
      last_heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 5_000).toISOString(),
    });
    expect(await dev.claimSession(CLINIC)).toBe(true);
    expect((await readRow())?.worker_id).toBe(DEV);
  });

  it("records a handoff request without taking the session", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);
    await prod.claimSession(CLINIC, { status: "connected", desired_state: "online" });

    expect(await dev.requestHandoff(CLINIC)).toBe(true);

    // Asked, not taken: the holder still owns it, its status is untouched, and
    // it can still see the request on its own sweep.
    const row = await readRow();
    expect(row?.worker_id).toBe(PROD);
    expect(row?.handoff_to).toBe(DEV);
    expect(row?.status).toBe("connected");
    expect(await prod.listHandoffRequests()).toEqual([CLINIC]);
    // And the requester still cannot simply claim it while the holder is live.
    expect(await dev.claimSession(CLINIC)).toBe(false);
  });

  it("fences the releasing worker out, then admits the requester", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);
    await prod.claimSession(CLINIC, { status: "connected", desired_state: "online" });
    await dev.requestHandoff(CLINIC);
    await prod.releaseOwnership([CLINIC]);

    // The window the fence exists for: the row is unowned, and the worker that
    // just let go runs its own reconcile sweep before the requester notices.
    expect(await prod.claimSession(CLINIC)).toBe(false);
    expect((await readRow())?.worker_id).toBeNull();

    expect(await dev.claimSession(CLINIC, { status: "starting" })).toBe(true);
    const row = await readRow();
    expect(row?.worker_id).toBe(DEV);
    // Answered, so the request is gone and the clinic is nobody's to fence.
    expect(row?.handoff_to).toBeNull();
    expect(row?.handoff_requested_at).toBeNull();
  });

  it("stops fencing once the request has expired", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);
    await prod.claimSession(CLINIC, { status: "connected", desired_state: "online" });
    await dev.requestHandoff(CLINIC);
    await prod.releaseOwnership([CLINIC]);

    // The requester never came back — a laptop that slept, a process that died
    // between asking and adopting. Without an expiry this clinic would be dark
    // until somebody noticed a column nobody looks at.
    await backdate({
      handoff_requested_at: new Date(Date.now() - HANDOFF_TTL_MS - 60_000).toISOString(),
    });

    expect(await prod.claimSession(CLINIC, { status: "starting" })).toBe(true);
    const row = await readRow();
    expect(row?.worker_id).toBe(PROD);
    expect(row?.handoff_to).toBeNull();
    // An expired request is also not worth honouring.
    expect(await prod.listHandoffRequests()).toEqual([]);
  });

  it("withdraws requests on shutdown and refuses a self-directed one", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    const dev = workerStore(DEV);
    await prod.claimSession(CLINIC, { status: "connected", desired_state: "online" });

    // A worker cannot request a session from itself. The query refuses it here;
    // the table's check constraint refuses it even if the query ever stopped.
    expect(await prod.requestHandoff(CLINIC)).toBe(false);

    await dev.requestHandoff(CLINIC);
    await dev.clearHandoffRequests();
    expect((await readRow())?.handoff_to).toBeNull();
    expect(await prod.listHandoffRequests()).toEqual([]);
  });

  it("sees a live worker id collision and ignores a stale one", async () => {
    await clearRow();
    const prod = workerStore(PROD);
    await prod.claimSession(CLINIC, { status: "connected", desired_state: "online" });

    // A second process booting under the same WORKER_ID: its own stamp is
    // already on a row, still beating, and it has written nothing yet.
    expect(await workerStore(PROD).listLiveSessionsOwnedByThisWorkerId()).toEqual([CLINIC]);

    await backdate({
      last_heartbeat_at: new Date(Date.now() - HEARTBEAT_STALE_MS - 5_000).toISOString(),
    });
    expect(await workerStore(PROD).listLiveSessionsOwnedByThisWorkerId()).toEqual([]);
  });
});
