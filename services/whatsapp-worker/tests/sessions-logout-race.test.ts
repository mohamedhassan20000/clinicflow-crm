import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "../src/sessions.ts";
import {
  CLINIC_A,
  CLINIC_B,
  deferred,
  FakeStore,
  stagedSocketFactory,
  testConfig,
  waitFor,
} from "./harness.ts";

/**
 * The bug this suite exists to prevent, exactly as it was reported.
 *
 *   POST /start  → 200, and the row sits at
 *                  status=starting, desired_state=online, qr_payload=null
 *   POST /logout → 200, and `logout()` calls `clearAuth()`
 *   …and a moment later `whatsapp_linked_device_auth` holds creds again, with a
 *   `created_at` inside the same second the logout ran.
 *
 * Nothing had gone wrong with the logout. The start it raced had been *admitted*
 * — the caller was answered early, by design — and was still running its
 * asynchronous half: load the auth state, write a brand-new device identity,
 * open a socket. `logout()` cancelled reconnects and deleted the `starting`
 * entry, but the promise that entry pointed at went on running, holding its own
 * auth state, and re-created the rows the logout had just deleted.
 *
 * So these tests are not about `logout()` returning; they are about what a start
 * that outlives a logout is still *capable* of. Each one wedges the start at a
 * different asynchronous boundary, runs the logout through it, and then lets the
 * start finish — asserting that it finishes mute.
 */

function manager(store: FakeStore, factory: ReturnType<typeof stagedSocketFactory>) {
  return new SessionManager(testConfig({ workerId: store.workerId }), store.asStore(), factory.factory);
}

/** The row a logged-out clinic must be left in, whatever raced it. */
function assertOffline(store: FakeStore, clinicId: string): void {
  const row = store.row(clinicId);
  assert.equal(row?.status, "disconnected", "status");
  assert.equal(row?.desired_state, "offline", "desired_state");
  assert.equal(row?.qr_payload, null, "qr_payload");
  assert.equal(row?.qr_expires_at, null, "qr_expires_at");
  assert.equal(row?.phone_number, null, "phone_number");
  assert.deepEqual(store.authKeys(clinicId), [], "stored auth rows");
  assert.equal(store.channels.has(clinicId), false, "clinic_channels row");
}

describe("logout beats a start that is still coming up", () => {
  it("leaves auth empty and the session offline when the socket is stalled", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    // The reported sequence: /start is admitted and the row reaches `starting`,
    // with no code yet because the handshake has not returned.
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    const handshake = await handshakes.nth(0);
    assert.equal(store.row(CLINIC_A)?.status, "starting");
    assert.equal(store.row(CLINIC_A)?.desired_state, "online");
    assert.equal(store.row(CLINIC_A)?.qr_payload, null);
    // The start got as far as writing the brand-new device identity, which is
    // the row the bug report found re-created.
    assert.ok(store.authKeys(CLINIC_A).length > 0, "the start wrote a device identity");

    await sessions.logout(CLINIC_A);
    assertOffline(store, CLINIC_A);

    // Now the stalled handshake finally returns — a whole second later, as far as
    // the start is concerned. Its socket must be discarded unwired and unpublished.
    const socket = await handshake.release();
    await waitFor(() => socket.ended, "the discarded socket to be closed");
    assert.equal(sessions.clinicIds().includes(CLINIC_A), false, "no session was published");

    // And the events that socket would have produced reach nothing, because
    // nothing was ever subscribed to it.
    socket.emit("connection.update", { qr: "2@a-code-nobody-asked-for" });
    socket.emit("connection.update", { connection: "open" });
    socket.emit("creds.update", {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertOffline(store, CLINIC_A);
  });

  it("cannot re-create credentials when the logout lands mid-saveCreds", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    // Hold the identity write open. The start is admitted, reaches
    // `open()`'s `if (!auth.restored) await auth.saveCreds()`, and stops there.
    const write = deferred();
    store.authWriteGate = write.promise;
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    await waitFor(() => store.clearAuthCalls.length + store.authWrites.length >= 0, "the start to run");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(store.authKeys(CLINIC_A), [], "the identity write has not landed yet");

    // The logout must not race past a write that is already in flight: it waits
    // for it, then deletes. Releasing it *after* the logout has begun is the
    // ordering the production failure produced.
    const loggedOut = sessions.logout(CLINIC_A);
    await new Promise((resolve) => setTimeout(resolve, 25));
    store.authWriteGate = null;
    write.resolve();
    await loggedOut;

    assertOffline(store, CLINIC_A);

    // The identity write landed inside the barrier and was then deleted, and the
    // stale start — which resumes right after it — gets no further: the currency
    // check that follows `saveCreds` stops it before a socket is ever asked for.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handshakes.calls, 0, "the cancelled start never reached the socket factory");
    assertOffline(store, CLINIC_A);
  });

  it("discards a socket created after the logout without publishing anything", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    await sessions.start(CLINIC_A);
    const handshake = await handshakes.nth(0);
    await sessions.logout(CLINIC_A);

    const postedRows = JSON.stringify(store.row(CLINIC_A));
    const socket = await handshake.release();

    await waitFor(() => socket.ended, "the socket to be discarded");
    // Discarded, not logged out: the clinic's own teardown already unlinked the
    // device, and this connection was never published to anyone.
    assert.equal(sessions.clinicIds().length, 0);
    assert.equal(JSON.stringify(store.row(CLINIC_A)), postedRows, "the row was not touched");
    assert.deepEqual(store.authKeys(CLINIC_A), []);
    assert.equal(store.channels.has(CLINIC_A), false);
  });

  it("lets a fresh start after the logout produce a code normally", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    await sessions.start(CLINIC_A);
    const cancelled = await handshakes.nth(0);
    await sessions.logout(CLINIC_A);
    // The cancelled start is still out there while the clinic tries again — which
    // is the whole point: deleting the `starting` entry must not have handed the
    // next caller the dead start's outcome, and the dead start must not interfere
    // with the live one.

    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    const fresh = await handshakes.nth(1);
    assert.equal(store.row(CLINIC_A)?.status, "starting");
    assert.equal(store.row(CLINIC_A)?.desired_state, "online");

    const socket = await fresh.release();
    await waitFor(() => sessions.clinicIds().includes(CLINIC_A), "the new socket to be published");
    socket.emit("connection.update", { qr: "2@a-real-code" });
    await waitFor(
      () => store.row(CLINIC_A)?.status === "awaiting_scan",
      "the new session to publish its code",
    );
    assert.equal(store.row(CLINIC_A)?.qr_payload, "2@a-real-code");

    // And the abandoned start, released now, still cannot touch any of it.
    const stale = await cancelled.release();
    await waitFor(() => stale.ended, "the abandoned socket to be discarded");
    stale.emit("connection.update", { qr: "2@the-stale-code" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.row(CLINIC_A)?.qr_payload, "2@a-real-code", "the live code survived");
    assert.equal(sessions.clinicIds().length, 1);
  });

  it("still gives concurrent starts one socket and one outcome", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    const [first, second] = await Promise.all([sessions.start(CLINIC_A), sessions.start(CLINIC_A)]);
    const third = await sessions.start(CLINIC_A);

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(third, { ok: true });
    // Reached a few ticks after the answers — the auth state loads first — so it
    // is waited for rather than assumed.
    const handshake = await handshakes.nth(0);
    assert.equal(handshakes.calls, 1, "three starts, one handshake");

    const socket = await handshake.release();
    await waitFor(() => sessions.clinicIds().includes(CLINIC_A), "the socket to be published");
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    assert.equal(handshakes.calls, 1);
    assert.equal(socket.ended, false, "the published socket was not discarded");
  });

  it("does not let a queued reconnect resurrect a logged-out clinic", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    await sessions.start(CLINIC_A);
    const socket = await (await handshakes.nth(0)).release();
    await waitFor(() => sessions.clinicIds().includes(CLINIC_A), "the socket to be published");
    socket.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session to identify itself");
    assert.equal(store.channels.has(CLINIC_A), true);

    // An established pairing drops with a retryable code, so a reconnect is
    // queued. `registered` makes the manager treat it as paired rather than as a
    // scan that timed out — set on the auth state the session itself holds, which
    // is what `onClose` reads.
    (await handshakes.nth(0)).auth.state.creds.registered = true;
    socket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    await waitFor(() => store.row(CLINIC_A)?.status === "connecting", "the reconnect to be queued");

    await sessions.logout(CLINIC_A);
    assertOffline(store, CLINIC_A);

    // Well past the 2s first backoff: the reconnect neither fires nor opens.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(handshakes.calls, 1, "no reconnect handshake was attempted");
    assertOffline(store, CLINIC_A);
    assert.equal(sessions.clinicIds().length, 0);
  });

  it("reports a teardown delete that failed instead of swallowing it", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    await sessions.start(CLINIC_A);
    await handshakes.nth(0);
    store.clearAuthError = new Error("permission denied for table");
    store.removeChannelError = new Error("permission denied for table");

    // A failed delete must not wedge the clinic: the teardown finishes and the
    // row still says offline, so the panel is not stuck on "starting" forever.
    await sessions.logout(CLINIC_A);
    assert.deepEqual(store.clearAuthCalls, [CLINIC_A]);
    assert.deepEqual(store.removeChannelCalls, [CLINIC_A]);
    assert.equal(store.row(CLINIC_A)?.status, "disconnected");
    assert.equal(store.row(CLINIC_A)?.desired_state, "offline");
  });

  it("logging one clinic out leaves another clinic's start alone", async () => {
    const store = new FakeStore("worker-under-test");
    const handshakes = stagedSocketFactory();
    const sessions = manager(store, handshakes);

    await sessions.start(CLINIC_A);
    await sessions.start(CLINIC_B);
    const forA = await handshakes.nth(0);
    const forB = await handshakes.nth(1);
    assert.equal(forA.clinicId, CLINIC_A);
    assert.equal(forB.clinicId, CLINIC_B);

    await sessions.logout(CLINIC_A);

    const socketB = await forB.release();
    await waitFor(() => sessions.clinicIds().includes(CLINIC_B), "clinic B's socket to be published");
    socketB.emit("connection.update", { qr: "2@clinic-b-code" });
    await waitFor(
      () => store.row(CLINIC_B)?.status === "awaiting_scan",
      "clinic B to publish its code",
    );

    assertOffline(store, CLINIC_A);
    assert.equal(store.row(CLINIC_B)?.qr_payload, "2@clinic-b-code");
    assert.equal(store.row(CLINIC_B)?.desired_state, "online");

    await (await handshakes.nth(0)).release();
  });
});
