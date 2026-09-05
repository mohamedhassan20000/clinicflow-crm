import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager, type StartOutcome } from "../src/sessions.ts";
import { HANDOFF_TTL_MS, HEARTBEAT_STALE_MS } from "../src/store.ts";
import {
  CLINIC_A,
  FakeStore,
  type StoredSession,
  gatedSocketFactory,
  testConfig,
  waitFor,
} from "./harness.ts";

/**
 * The invariant this suite exists to protect: **one live worker per clinic, ever.**
 *
 * A linked-device pairing is one WhatsApp device identity with one Signal
 * session state. Two processes holding sockets on it do not split the traffic
 * between them — they corrupt each other's ratchets, and WhatsApp's own
 * resolution is to tear the device down, which costs the clinic a rescan and
 * every message in flight. So "who owns this clinic" is not bookkeeping; it is
 * the correctness property the whole worker is arranged around.
 *
 * P11K adds one thing to it: ownership can now move *deliberately*, so a
 * developer can drive the real linked device from a laptop without stopping the
 * deployment or editing the database by hand. What is asserted below is that the
 * new path moves ownership only ever in one direction at a time, only with the
 * holder's cooperation, and only through the same fenced claim every other
 * adoption uses — and that with takeover off, none of it changes anything.
 */

const PROD = "railway-prod";
const DEV = "local-dev";

/** Two workers, one database — the topology every assertion here is about. */
function twoWorkers(options: { devTakeover?: boolean } = {}) {
  const database = new Map<string, StoredSession>();
  const prodStore = new FakeStore(PROD, database);
  const devStore = new FakeStore(DEV, database);
  const prodSockets = gatedSocketFactory();
  const devSockets = gatedSocketFactory();
  prodSockets.release();
  devSockets.release();
  const prod = new SessionManager(
    testConfig({ workerId: PROD }),
    prodStore.asStore(),
    prodSockets.factory,
  );
  const dev = new SessionManager(
    testConfig({ workerId: DEV, devTakeover: options.devTakeover ?? true }),
    devStore.asStore(),
    devSockets.factory,
  );
  return { database, prodStore, devStore, prod, dev, prodSockets, devSockets };
}

/**
 * Starts a clinic and waits until the manager is genuinely holding it.
 *
 * `start()` answers while the handshake is still in flight and memoises that
 * answer, so a second `start()` on the same manager would be handed the first
 * one's outcome rather than re-testing ownership — and the handoff sweep
 * deliberately skips a clinic whose start has not finished. Both are correct
 * behaviours, and both would quietly hollow out these assertions.
 */
async function held(manager: SessionManager, expected: StartOutcome = { ok: true }) {
  assert.deepEqual(await manager.start(CLINIC_A), expected);
  await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket to be published");
}

function row(database: Map<string, StoredSession>): StoredSession {
  const found = database.get(CLINIC_A);
  assert.ok(found, "the clinic should have a session row");
  return found;
}

/** Backdates a row's heartbeat, as a worker that stopped running would leave it. */
function ageHeartbeat(database: Map<string, StoredSession>, byMs: number): void {
  const current = row(database);
  database.set(CLINIC_A, {
    ...current,
    last_heartbeat_at: new Date(Date.now() - byMs).toISOString(),
  });
}

describe("single-owner invariant", () => {
  it("refuses a second worker while the first is heart-beating", async () => {
    const { database, prod, dev, devSockets } = twoWorkers({ devTakeover: false });

    await held(prod);
    assert.equal(row(database).worker_id, PROD);

    // An ordinary second worker — takeover off — is told no, and has not opened
    // anything. The refusal is the product behaviour: the app turns it into a
    // 409 and the send path records a normal provider failure.
    assert.deepEqual(await dev.start(CLINIC_A), { ok: false, code: "OWNED_ELSEWHERE" });
    assert.equal(row(database).worker_id, PROD);
    assert.equal(devSockets.calls, 0);
  });

  it("adopts a session whose owner stopped heart-beating", async () => {
    const { database, prod, dev } = twoWorkers({ devTakeover: false });
    await held(prod);

    // The owner is gone without a graceful shutdown — a SIGKILL, an OOM, a
    // platform that pulled the container. Nobody released anything, so the stale
    // window is the only thing that can free the clinic.
    ageHeartbeat(database, HEARTBEAT_STALE_MS + 1_000);

    await held(dev);
    assert.equal(row(database).worker_id, DEV);
  });

  it("hands ownership over on a graceful shutdown", async () => {
    const { database, prod, dev } = twoWorkers({ devTakeover: false });
    await held(prod);

    await prod.shutdown();

    // Released, not logged out: the clinic still wants to be online, so the
    // replacement adopts it at once instead of waiting out the stale window.
    assert.equal(row(database).worker_id, null);
    assert.equal(row(database).desired_state, "online");
    await held(dev);
    assert.equal(row(database).worker_id, DEV);
  });

  it("does not let a shut-down worker keep its old sessions alive", async () => {
    const { database, prodStore, prod, dev } = twoWorkers({ devTakeover: false });
    await held(prod);
    await prod.shutdown();
    await held(dev);

    // A heartbeat timer that outlived the teardown must not be able to stamp a
    // row somebody else now owns, or the new owner would look stale to a third
    // worker while the old one looked alive.
    await prodStore.heartbeat([CLINIC_A]);
    assert.equal(row(database).worker_id, DEV);

    // Nor may it simply take the clinic back.
    assert.deepEqual(await prod.start(CLINIC_A), { ok: false, code: "OWNED_ELSEWHERE" });
    assert.equal(row(database).worker_id, DEV);
  });

  it("does not let a reconcile sweep steal a live session", async () => {
    const { database, prod, dev } = twoWorkers({ devTakeover: false });
    await held(prod);

    // The sweep that makes a redeploy self-healing must stay incapable of
    // interrupting a healthy clinic somebody else is serving.
    await dev.reconcile();

    assert.equal(row(database).worker_id, PROD);
    assert.equal(dev.clinicIds().length, 0);
  });
});

describe("development takeover", () => {
  it("asks for a session instead of taking it", async () => {
    const { database, prod, dev, prodSockets } = twoWorkers();
    await held(prod);

    const refused = await dev.start(CLINIC_A);

    // The request is recorded and the refusal still stands. Crucially the holder
    // is untouched: same owner, same socket, still able to send.
    assert.deepEqual(refused, { ok: false, code: "OWNED_ELSEWHERE" });
    assert.equal(row(database).worker_id, PROD);
    assert.equal(row(database).handoff_to, DEV);
    assert.equal(prodSockets.sockets[0]?.ended, false);
  });

  it("transfers ownership only after the holder has closed its socket", async () => {
    const { database, prod, dev, prodSockets, devSockets } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);

    // The holder's heartbeat tick. This is the only moment ownership moves, and
    // the order inside it is the safety property: socket closed, *then* released.
    await prod.honorHandoffs();

    assert.equal(prodSockets.sockets[0]?.ended, true);
    assert.equal(prod.clinicIds().length, 0);
    assert.equal(row(database).worker_id, null);
    assert.equal(row(database).desired_state, "online");
    // Nothing was logged out and no identity was destroyed — the whole point is
    // that the developer does not rescan.
    assert.equal(row(database).phone_number, undefined);
    assert.equal(devSockets.calls, 0);

    // And only now can the requester win it, through the ordinary fenced claim.
    await held(dev);
    assert.equal(row(database).worker_id, DEV);
    assert.equal(row(database).handoff_to, null);
    assert.equal(devSockets.sockets.length, 1);
  });

  it("never lets both workers hold the clinic at once", async () => {
    const { database, prod, dev, prodSockets, devSockets } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);

    // Walk the whole handoff one step at a time and assert the invariant after
    // every single step: at no point do two managers hold this clinic, and at no
    // point are two sockets open on it.
    const bothHold = () => prod.clinicIds().includes(CLINIC_A) && dev.clinicIds().includes(CLINIC_A);
    const liveSockets = () =>
      prodSockets.sockets.filter((socket) => !socket.ended).length +
      devSockets.sockets.filter((socket) => !socket.ended).length;

    assert.equal(bothHold(), false);
    assert.ok(liveSockets() <= 1);

    await prod.honorHandoffs();
    assert.equal(bothHold(), false);
    assert.ok(liveSockets() <= 1);

    await dev.reconcile();
    await waitFor(() => devSockets.sockets.length === 1, "the developer's socket to open");
    assert.equal(bothHold(), false);
    assert.ok(liveSockets() <= 1);
    assert.equal(row(database).worker_id, DEV);
  });

  it("keeps the releasing worker from taking the clinic straight back", async () => {
    const { database, prod, dev } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);
    await prod.honorHandoffs();

    // The row is unowned for as long as it takes the requester to notice, and
    // the holder's own sweep runs in that window. Without the fence it would win
    // the race it just conceded, and the developer would never get the session.
    await prod.reconcile();
    assert.equal(row(database).worker_id, null);

    await dev.reconcile();
    assert.equal(row(database).worker_id, DEV);
  });

  it("returns the session to production when the developer stops", async () => {
    const { database, prod, dev, devSockets } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);
    await prod.honorHandoffs();
    await held(dev);

    await dev.shutdown();

    // Ordinary release — no request left standing, nothing logged out — so the
    // deployed worker's next reconcile picks the clinic straight back up.
    assert.equal(devSockets.sockets[0]?.ended, true);
    assert.equal(row(database).worker_id, null);
    assert.equal(row(database).handoff_to, null);

    await prod.reconcile();
    assert.equal(row(database).worker_id, PROD);
    assert.equal(row(database).desired_state, "online");
  });

  it("withdraws a request abandoned before the handoff completed", async () => {
    const { database, prod, dev } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);
    assert.equal(row(database).handoff_to, DEV);

    // The developer closes the laptop between asking and being answered.
    await dev.shutdown();

    assert.equal(row(database).handoff_to, null);
    assert.equal(row(database).worker_id, PROD);
    // The holder is not asked to release a session nobody is waiting for.
    await prod.honorHandoffs();
    assert.equal(row(database).worker_id, PROD);
  });

  it("expires a request that was never withdrawn, rather than fencing a clinic forever", async () => {
    const { database, prod, dev } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);
    await prod.honorHandoffs();
    assert.equal(row(database).worker_id, null);

    // The developer's machine died without a shutdown, leaving the fence up over
    // an unowned clinic. The TTL is the guarantee that this ends by itself.
    database.set(CLINIC_A, {
      ...row(database),
      handoff_requested_at: new Date(Date.now() - HANDOFF_TTL_MS - 1_000).toISOString(),
    });

    await prod.reconcile();
    assert.equal(row(database).worker_id, PROD);
    assert.equal(row(database).handoff_to, null);
  });
});

describe("production is unchanged when takeover is off", () => {
  it("logs a refusal and asks for nothing", async () => {
    const { database, prod, dev } = twoWorkers({ devTakeover: false });
    await held(prod);

    await dev.start(CLINIC_A);
    await dev.reconcile();

    // No request was written, so the holder's sweep has nothing to honour and
    // the clinic never changes hands.
    assert.equal(row(database).handoff_to, null);
    await prod.honorHandoffs();
    assert.equal(row(database).worker_id, PROD);
    assert.equal(prod.clinicIds().length, 1);
  });

  it("keeps a redeploy handoff working exactly as before", async () => {
    const { database, prod, dev, devSockets } = twoWorkers({ devTakeover: false });
    await held(prod);

    // The deployment sequence: old instance drains, new instance boots and
    // restores every clinic marked online. No request, no takeover — just the
    // release the outgoing process performs on its way out.
    await prod.shutdown();
    await dev.restoreAll();

    assert.equal(row(database).worker_id, DEV);
    assert.equal(row(database).desired_state, "online");
    await waitFor(() => devSockets.sockets.length === 1, "the new instance's socket to open");
  });

  it("still refuses an overlapping deploy that has not released yet", async () => {
    const { database, prod, dev, devSockets } = twoWorkers({ devTakeover: false });
    await held(prod);

    // Railway's rolling deploy with a non-zero overlap: the new instance boots
    // while the old one is still serving. It must wait, not fight.
    await dev.restoreAll();
    assert.equal(row(database).worker_id, PROD);
    assert.equal(devSockets.calls, 0);

    // And pick the clinic up on a later sweep, once the old one has gone.
    await prod.shutdown();
    await dev.reconcile();
    assert.equal(row(database).worker_id, DEV);
  });
});

/**
 * P11M. Two defects lived in the same line of `Store.upsertSession`: it stamped
 * `worker_id` with this instance's id on *every* status write, whether or not
 * this instance had ever claimed the row.
 *
 * On a row this worker had asked for — `handoff_to` already naming it — that
 * stamp produced `handoff_to = worker_id`, which the table's own
 * `whatsapp_linked_device_sessions_handoff_not_self` check refuses with SQLSTATE
 * 23514. The clinic's action failed with a 500 raised by a constraint doing
 * precisely its job. And on any row at all it was a second way to become the
 * owner, bypassing the fenced compare-and-swap that the single-owner invariant
 * is supposed to rest on entirely.
 *
 * Both are now unreachable rather than merely unlikely: no write outside
 * `claimSession` puts `worker_id` in its payload, and `FakeStore` throws the
 * constraint the way Postgres does, so a regression fails here rather than in a
 * clinic.
 */
describe("ownership is written in exactly one place", () => {
  it("does not violate the self-handoff constraint when logging out a requested clinic", async () => {
    const { database, prod, dev } = twoWorkers();
    await held(prod);
    await dev.start(CLINIC_A);
    assert.equal(row(database).handoff_to, DEV);
    assert.equal(row(database).worker_id, PROD);

    // The clinic presses Disconnect while the developer's request is standing.
    // This threw `handoff_to = worker_id` before the split, and the 500 reached
    // the panel.
    await dev.logout(CLINIC_A);

    // The state the clinic asked for is written…
    assert.equal(row(database).status, "disconnected");
    assert.equal(row(database).desired_state, "offline");
    // …and nothing about ownership moved. The holder still holds it.
    assert.equal(row(database).worker_id, PROD);
    assert.notEqual(row(database).handoff_to, row(database).worker_id);
  });

  it("never takes a session through a status write", async () => {
    const { database, prod, dev, devSockets } = twoWorkers({ devTakeover: false });
    await held(prod);
    const heldSince = row(database).last_heartbeat_at;

    // A worker that never won a claim writes the visible state and no more —
    // not the owner column, and not the heartbeat that would make a dead owner
    // look alive and postpone a legitimate adoption.
    await dev.logout(CLINIC_A);

    assert.equal(row(database).worker_id, PROD);
    assert.equal(row(database).last_heartbeat_at, heldSince);
    assert.equal(devSockets.calls, 0);
  });

  it("keeps refreshing the heartbeat on rows it does own", async () => {
    const { database, prod } = twoWorkers();
    await held(prod);
    const before = row(database).last_heartbeat_at as string;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await prod.logout(CLINIC_A);

    // The owner's own writes are unchanged by the split: same row, same
    // ownership, heartbeat moved forward.
    assert.equal(row(database).worker_id, PROD);
    assert.ok((row(database).last_heartbeat_at as string) > before);
  });

  it("survives repeated local → production → local handoffs", async () => {
    const database = new Map<string, StoredSession>();
    const prodStore = new FakeStore(PROD, database);
    const prodSockets = gatedSocketFactory();
    prodSockets.release();
    const prod = new SessionManager(
      testConfig({ workerId: PROD }),
      prodStore.asStore(),
      prodSockets.factory,
    );
    await held(prod);

    const invariant = (dev: SessionManager, devSockets: ReturnType<typeof gatedSocketFactory>) => {
      const live =
        prodSockets.sockets.filter((socket) => !socket.ended).length +
        devSockets.sockets.filter((socket) => !socket.ended).length;
      assert.ok(live <= 1, "two sockets were open on one linked device");
      assert.equal(
        prod.clinicIds().includes(CLINIC_A) && dev.clinicIds().includes(CLINIC_A),
        false,
        "both managers held the clinic at once",
      );
      const current = row(database);
      if (current.handoff_to && current.worker_id) {
        assert.notEqual(current.handoff_to, current.worker_id, "a worker requested itself");
      }
    };

    // Three full round trips, each with a *fresh* laptop process — `shutdown()`
    // is terminal, and Ctrl+C followed by `pnpm whatsapp:worker:dev` is a new
    // process, not a revived one. The failure this guards against is cumulative:
    // a fence, a heartbeat or a request left behind by one cycle is what breaks
    // the next, so a single pass proves much less than it appears to.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const devSockets = gatedSocketFactory();
      devSockets.release();
      const dev = new SessionManager(
        testConfig({ workerId: DEV, devTakeover: true }),
        new FakeStore(DEV, database).asStore(),
        devSockets.factory,
      );

      // The laptop asks; production answers on its next tick; the laptop wins.
      assert.deepEqual(await dev.start(CLINIC_A), { ok: false, code: "OWNED_ELSEWHERE" });
      assert.equal(row(database).handoff_to, DEV, `cycle ${cycle}: the request was recorded`);
      invariant(dev, devSockets);

      await prod.honorHandoffs();
      assert.equal(row(database).worker_id, null, `cycle ${cycle}: production let go`);
      invariant(dev, devSockets);

      await dev.reconcile();
      await waitFor(() => dev.clinicIds().includes(CLINIC_A), `cycle ${cycle}: the laptop's socket`);
      assert.equal(row(database).worker_id, DEV, `cycle ${cycle}: the laptop owns it`);
      assert.equal(row(database).handoff_to, null, `cycle ${cycle}: the request was answered`);
      assert.equal(row(database).desired_state, "online");
      invariant(dev, devSockets);

      // Ctrl+C. Ownership goes back with no rescan and no fence left standing,
      // and production picks the clinic up on its next sweep.
      await dev.shutdown();
      assert.equal(row(database).worker_id, null);
      assert.equal(row(database).handoff_to, null, `cycle ${cycle}: no fence left behind`);
      invariant(dev, devSockets);

      await prod.reconcile();
      await waitFor(() => prod.clinicIds().includes(CLINIC_A), `cycle ${cycle}: production's socket`);
      assert.equal(row(database).worker_id, PROD, `cycle ${cycle}: production has it back`);
      invariant(dev, devSockets);
    }
  });
});
