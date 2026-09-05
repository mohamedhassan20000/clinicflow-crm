import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { after, before, describe, it } from "node:test";
import { HANDOFF_TTL_MS, HEARTBEAT_STALE_MS, Store } from "../src/store.ts";
import { testConfig } from "./harness.ts";

/**
 * The ownership predicate against a **real** Postgres and a real PostgREST.
 *
 * `tests/ownership-handoff.test.ts` proves the manager's control flow against an
 * in-memory store, and that is the right tool for it — but it cannot prove the
 * two things this file exists for, because both live below the store's own API:
 *
 *  1. `Store.claimSession` builds its predicate from **two** chained `.or()`
 *     calls ("the seat is free for me" AND "nobody else is holding it"). Whether
 *     PostgREST really ANDs two `or=` parameters rather than letting the second
 *     replace the first is a property of PostgREST, not of this codebase, and a
 *     hand-written fake will agree with whatever the fake's author assumed. If
 *     the second group were dropped, every assertion about the fence would still
 *     pass in the fake suite and the fence would not exist in production.
 *  2. The P11M trigger and the P11K check constraint are SQL. A fake store can
 *     imitate them; only the database can be them.
 *
 * Runs against the local Supabase stack and **skips itself** when that stack is
 * not up, so `npm test` stays green on a machine with no Docker and in CI.
 * Nothing here touches a hosted project: the URL must be loopback or the suite
 * refuses to run at all.
 */

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
const CLINIC = process.env.TEST_CLINIC_ID ?? "93000000-0000-4000-8000-000000000001";

const PROD = "p11m-prod";
const DEV = "p11m-dev";

/** Loopback only. A hosted URL here would write to somebody's live clinic. */
function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

async function reachable(): Promise<boolean> {
  if (!SERVICE_ROLE_KEY || !isLoopback(SUPABASE_URL)) return false;
  return await fetch(`${SUPABASE_URL}/rest/v1/`, {
    signal: AbortSignal.timeout(2_000),
    headers: { apikey: SERVICE_ROLE_KEY },
  })
    .then((response) => response.ok)
    .catch(() => false);
}

const available = await reachable();
const admin = available
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

function storeFor(workerId: string): Store {
  return new Store(
    testConfig({
      workerId,
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SERVICE_ROLE_KEY,
    }),
  );
}

/** Puts the row into an exact known state, bypassing every worker code path. */
async function seed(row: Record<string, unknown>): Promise<void> {
  const result = await admin!.from("whatsapp_linked_device_sessions").upsert(
    {
      clinic_id: CLINIC,
      status: "connected",
      desired_state: "online",
      handoff_to: null,
      handoff_requested_at: null,
      ...row,
    },
    { onConflict: "clinic_id" },
  );
  assert.equal(result.error, null, result.error?.message);
}

async function read(): Promise<Record<string, unknown>> {
  const result = await admin!
    .from("whatsapp_linked_device_sessions")
    .select("worker_id, last_heartbeat_at, handoff_to, handoff_requested_at, status, desired_state")
    .eq("clinic_id", CLINIC)
    .maybeSingle();
  assert.equal(result.error, null, result.error?.message);
  assert.ok(result.data, "the session row should exist");
  return result.data as Record<string, unknown>;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Postgres renders `+00:00` where JavaScript renders `Z`; the instant is what matters. */
function sameInstant(actual: unknown, expected: string, message: string): void {
  assert.equal(new Date(actual as string).valueOf(), new Date(expected).valueOf(), message);
}

describe("ownership against the real database", { skip: !available }, () => {
  let restore: Record<string, unknown> | null = null;

  before(async () => {
    // Whatever this developer's stack had, it gets back.
    const existing = await admin!
      .from("whatsapp_linked_device_sessions")
      .select("*")
      .eq("clinic_id", CLINIC)
      .maybeSingle();
    restore = (existing.data as Record<string, unknown> | null) ?? null;
  });

  after(async () => {
    if (restore) await admin!.from("whatsapp_linked_device_sessions").upsert(restore, { onConflict: "clinic_id" });
    else await admin!.from("whatsapp_linked_device_sessions").delete().eq("clinic_id", CLINIC);
  });

  it("refuses a claim while the holder is heart-beating", async () => {
    await seed({ worker_id: PROD, last_heartbeat_at: new Date().toISOString() });
    assert.equal(await storeFor(DEV).claimSession(CLINIC), false);
    assert.equal((await read()).worker_id, PROD);
  });

  it("grants a claim once the holder's heartbeat has gone stale", async () => {
    await seed({ worker_id: PROD, last_heartbeat_at: ago(HEARTBEAT_STALE_MS + 5_000) });
    assert.equal(await storeFor(DEV).claimSession(CLINIC), true);
    assert.equal((await read()).worker_id, DEV);
  });

  it("fences the releasing worker out with the second predicate group", async () => {
    // The load-bearing case for chained `.or()`. The seat is free — group one
    // says yes to everybody — and only group two keeps production out. If
    // PostgREST let the second `or=` replace the first, production would win
    // here and the whole handoff would be decorative.
    await seed({
      worker_id: null,
      last_heartbeat_at: null,
      handoff_to: DEV,
      handoff_requested_at: new Date().toISOString(),
    });

    assert.equal(await storeFor(PROD).claimSession(CLINIC), false, "production must stay fenced out");
    assert.equal((await read()).worker_id, null);

    assert.equal(await storeFor(DEV).claimSession(CLINIC), true, "the requester wins it");
    const row = await read();
    assert.equal(row.worker_id, DEV);
    assert.equal(row.handoff_to, null, "claiming answers the request");
  });

  it("lets an expired request lapse rather than fencing a clinic forever", async () => {
    await seed({
      worker_id: null,
      last_heartbeat_at: null,
      handoff_to: DEV,
      handoff_requested_at: ago(HANDOFF_TTL_MS + 60_000),
    });
    assert.equal(await storeFor(PROD).claimSession(CLINIC), true);
    const row = await read();
    assert.equal(row.worker_id, PROD);
    assert.equal(row.handoff_to, null);
  });

  it("records a request without touching the holder", async () => {
    const heartbeat = new Date().toISOString();
    await seed({ worker_id: PROD, last_heartbeat_at: heartbeat });

    assert.equal(await storeFor(DEV).requestHandoff(CLINIC), true);

    const row = await read();
    assert.equal(row.worker_id, PROD, "ownership did not move");
    sameInstant(row.last_heartbeat_at, heartbeat, "the holder's heartbeat is untouched");
    assert.equal(row.handoff_to, DEV);
  });

  it("cannot request a session from itself", async () => {
    await seed({ worker_id: PROD, last_heartbeat_at: new Date().toISOString() });
    assert.equal(await storeFor(PROD).requestHandoff(CLINIC), false);
    assert.equal((await read()).handoff_to, null);
  });

  it("normalises a self-handoff written directly, rather than raising 23514", async () => {
    // The P11M trigger, exercised past every worker code path: a writer that
    // *tries* to build `handoff_to = worker_id` gets a clean row, not an error.
    // Before the trigger this same statement failed the not-self check.
    await seed({ worker_id: null, last_heartbeat_at: null });
    const written = await admin!
      .from("whatsapp_linked_device_sessions")
      .update({ worker_id: DEV, handoff_to: DEV, handoff_requested_at: new Date().toISOString() })
      .eq("clinic_id", CLINIC);
    assert.equal(written.error, null, written.error?.message);

    const row = await read();
    assert.equal(row.worker_id, DEV);
    assert.equal(row.handoff_to, null, "the self-request was collapsed");
    assert.equal(row.handoff_requested_at, null);
  });

  it("writes state without taking a session it does not own", async () => {
    const heartbeat = ago(10_000);
    await seed({
      worker_id: PROD,
      last_heartbeat_at: heartbeat,
      handoff_to: DEV,
      handoff_requested_at: new Date().toISOString(),
    });

    // The exact write that used to raise 23514: a status write from the worker
    // whose id is already sitting in `handoff_to`.
    await storeFor(DEV).setStatus(CLINIC, "disconnected", { desired_state: "offline" });

    const row = await read();
    assert.equal(row.status, "disconnected", "the clinic's state was written");
    assert.equal(row.desired_state, "offline");
    assert.equal(row.worker_id, PROD, "ownership was not taken");
    sameInstant(row.last_heartbeat_at, heartbeat, "a dead owner is not kept alive by our write");
    assert.equal(row.handoff_to, DEV, "the fence still stands");
  });

  it("refreshes the heartbeat on a row it does own", async () => {
    const heartbeat = ago(10_000);
    await seed({ worker_id: DEV, last_heartbeat_at: heartbeat });

    await storeFor(DEV).setStatus(CLINIC, "connected");

    const row = await read();
    assert.equal(row.worker_id, DEV);
    assert.ok(
      new Date(row.last_heartbeat_at as string).valueOf() > new Date(heartbeat).valueOf(),
      "the owner's heartbeat moved forward",
    );
  });

  /**
   * The lost-owner signal, at the level it is actually produced.
   *
   * `SessionManager.heartbeat` fences a clinic on the strength of one thing: the
   * scoped `UPDATE ... WHERE worker_id = me` came back without that clinic's id
   * in it. Whether a PostgREST `UPDATE` with `.select()` really returns *only*
   * the rows it matched — and returns an empty array rather than an error when
   * it matches none — is a property of PostgREST, not of this codebase. A fake
   * store agrees with whatever its author assumed; if the real one answered
   * differently, a resumed laptop would either fence clinics it still owns
   * (an outage) or fail to fence one it has lost (split brain).
   */
  it("reports exactly the rows a heartbeat renewed, and nothing else", async () => {
    const stamped = ago(30_000);
    await seed({ worker_id: PROD, last_heartbeat_at: stamped });

    // The owner renews and is told which clinic it renewed.
    assert.deepEqual(await storeFor(PROD).heartbeat([CLINIC]), [CLINIC]);
    const renewed = await read();
    assert.notEqual(renewed.last_heartbeat_at, stamped, "the heartbeat did not move");

    // A worker that no longer owns the row gets an empty answer — not an error,
    // not a silent success — and the owner's stamp is untouched by the attempt.
    assert.deepEqual(await storeFor(DEV).heartbeat([CLINIC]), []);
    const after = await read();
    assert.equal(after.worker_id, PROD, "a non-owner's heartbeat took the row");
    assert.equal(
      after.last_heartbeat_at,
      renewed.last_heartbeat_at,
      "a non-owner's heartbeat refreshed the row",
    );
  });

  it("does not renew a row whose owner released it", async () => {
    // The other way a worker discovers it has lost a clinic: nobody took it, the
    // row was simply released out from under it. An unowned row must not match
    // either, or a suspended worker could keep a clinic alive that it has in
    // fact stopped serving.
    await seed({ worker_id: null, last_heartbeat_at: null });
    assert.deepEqual(await storeFor(PROD).heartbeat([CLINIC]), []);
    assert.equal((await read()).worker_id, null);
  });

  it("completes a whole handoff cycle three times over", async () => {
    const prod = storeFor(PROD);
    const dev = storeFor(DEV);
    await seed({ worker_id: PROD, last_heartbeat_at: new Date().toISOString() });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Laptop asks. Production still holds it.
      assert.equal(await dev.requestHandoff(CLINIC), true, `cycle ${cycle}: asked`);
      assert.equal(await dev.claimSession(CLINIC), false, `cycle ${cycle}: still refused`);

      // Production's heartbeat tick sees the request and lets go.
      assert.deepEqual(await prod.listHandoffRequests(), [CLINIC], `cycle ${cycle}: seen`);
      await prod.releaseOwnership([CLINIC]);
      assert.equal((await read()).worker_id, null);

      // Production's own sweep must not win the race it just conceded.
      assert.equal(await prod.claimSession(CLINIC), false, `cycle ${cycle}: fenced out`);
      assert.equal(await dev.claimSession(CLINIC), true, `cycle ${cycle}: laptop owns it`);
      assert.equal((await read()).handoff_to, null, `cycle ${cycle}: request answered`);

      // Ctrl+C on the laptop: released, no fence left standing.
      await dev.releaseOwnership([CLINIC]);
      await dev.clearHandoffRequests();
      const released = await read();
      assert.equal(released.worker_id, null);
      assert.equal(released.handoff_to, null, `cycle ${cycle}: nothing left behind`);

      // Production picks it straight back up.
      assert.equal(await prod.claimSession(CLINIC), true, `cycle ${cycle}: production has it back`);
      assert.equal((await read()).desired_state, "online", `cycle ${cycle}: never logged out`);
    }
  });
});
