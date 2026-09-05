import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createWorkerServer } from "../src/server.ts";
import { SessionManager } from "../src/sessions.ts";
import {
  CLINIC_A,
  FakeStore,
  gatedSocketFactory,
  testConfig,
  waitFor,
} from "./harness.ts";

/**
 * The bug this suite exists to prevent: `POST /v1/sessions/:clinicId/start` used
 * to wait for the whole Baileys handshake — auth state, protocol version,
 * socket, event wiring — before answering. The application calls it from inside
 * a request with roughly eight seconds to live, so a slow handshake showed the
 * clinic "the WhatsApp connection service is unavailable" while the worker went
 * on to publish a perfectly good code seconds later.
 *
 * So what is asserted here is *when* the caller is answered and what is durable
 * by then, separately from what the socket does afterwards — plus the four
 * properties that early answer must not cost: one socket per clinic, an
 * idempotent second click, an intact refusal when another worker owns the
 * pairing, and a late failure that is written down rather than lost.
 */

/** Comfortably inside the caller's budget, comfortably above scheduling noise. */
const PROMPT_MS = 1_000;

function manager(store: FakeStore, factory: ReturnType<typeof gatedSocketFactory>) {
  const config = testConfig({ workerId: store.workerId });
  return new SessionManager(config, store.asStore(), factory.factory);
}

describe("start acknowledgement", () => {
  it("answers while the socket handshake is still in flight", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);

    const startedAt = Date.now();
    const outcome = await sessions.start(CLINIC_A);
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(outcome, { ok: true });
    assert.ok(elapsed < PROMPT_MS, `start took ${elapsed}ms`);
    // The handshake is genuinely still blocked: this is an early answer, not a
    // fast socket. (It is reached a few ticks after the answer — the auth state
    // is loaded first — so it is waited for rather than assumed.)
    await waitFor(() => handshake.calls === 1, "the handshake to be attempted");
    assert.equal(handshake.sockets.length, 0);

    // And the answer is not a promise — the intent is durable, which is what
    // the panel's poll reads.
    const row = store.row(CLINIC_A);
    assert.equal(row?.status, "starting");
    assert.equal(row?.desired_state, "online");
    assert.equal(row?.worker_id, "worker-under-test");
    assert.equal(row?.last_error, null);

    handshake.release();
  });

  it("returns 200 from POST /start before the handshake completes", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const config = testConfig({ workerId: store.workerId });
    const sessions = new SessionManager(config, store.asStore(), handshake.factory);
    const server = createWorkerServer(config, sessions, store.asStore());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.ok(elapsed < PROMPT_MS, `POST /start took ${elapsed}ms`);
    assert.equal(handshake.sockets.length, 0);

    handshake.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("still refuses a caller with no worker token", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const config = testConfig({ workerId: store.workerId });
    const sessions = new SessionManager(config, store.asStore(), handshake.factory);
    const server = createWorkerServer(config, sessions, store.asStore());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/start`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
    });

    assert.equal(response.status, 401);
    // Nothing was started, and no row was written for the clinic it named.
    assert.equal(handshake.calls, 0);
    assert.equal(store.row(CLINIC_A), undefined);

    handshake.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("the code arrives through the durable session row", () => {
  it("publishes the QR after the caller has already been answered", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);

    await sessions.start(CLINIC_A);
    assert.equal(store.row(CLINIC_A)?.qr_payload, null);

    // The handshake finishes long after the HTTP request that asked for it.
    handshake.release();
    await waitFor(() => handshake.sockets.length === 1, "socket to be published");
    handshake.sockets[0]?.emit("connection.update", { qr: "2@pairing-payload" });

    await waitFor(
      () => store.row(CLINIC_A)?.status === "awaiting_scan",
      "session row to reach awaiting_scan",
    );
    const row = store.row(CLINIC_A);
    assert.equal(row?.qr_payload, "2@pairing-payload");
    assert.equal(row?.last_error, null);
    // The panel counts the code down, so the expiry has to be in the future.
    assert.ok(new Date(String(row?.qr_expires_at)).valueOf() > Date.now());
  });
});

describe("idempotency", () => {
  it("gives concurrent starts one socket and one outcome", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);

    // A double-clicked "Generate QR code": both land while the first handshake
    // is still blocked, which is precisely the window the early answer opened.
    const [first, second] = await Promise.all([
      sessions.start(CLINIC_A),
      sessions.start(CLINIC_A),
    ]);
    const third = await sessions.start(CLINIC_A);

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(third, { ok: true });
    await waitFor(() => handshake.calls === 1, "the handshake to be attempted");

    handshake.release();
    await waitFor(() => handshake.sockets.length === 1, "socket to be published");
    // Three starts, one handshake.
    assert.equal(handshake.calls, 1);

    // And once the socket is up, a fourth start is answered from it rather than
    // opening a rival.
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    assert.equal(handshake.calls, 1);
    assert.equal(handshake.sockets.length, 1);
  });
});

describe("ownership", () => {
  it("refuses a clinic another live worker is holding", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);
    store.seed(CLINIC_A, {
      status: "connected",
      desired_state: "online",
      worker_id: "another-worker",
      last_heartbeat_at: new Date().toISOString(),
      phone_number: "+201000000000",
    });

    assert.deepEqual(await sessions.start(CLINIC_A), { ok: false, code: "OWNED_ELSEWHERE" });
    // No socket, and the other worker's claim is left exactly as it was.
    assert.equal(handshake.calls, 0);
    const row = store.row(CLINIC_A);
    assert.equal(row?.worker_id, "another-worker");
    assert.equal(row?.status, "connected");

    handshake.release();
  });

  it("returns 409 for an owned clinic over HTTP", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const config = testConfig({ workerId: store.workerId });
    const sessions = new SessionManager(config, store.asStore(), handshake.factory);
    const server = createWorkerServer(config, sessions, store.asStore());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    store.seed(CLINIC_A, {
      status: "connected",
      desired_state: "online",
      worker_id: "another-worker",
      last_heartbeat_at: new Date().toISOString(),
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiToken}` },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "owned_elsewhere" });

    handshake.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("adopts a clinic whose owner stopped heart-beating", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);
    store.seed(CLINIC_A, {
      status: "connected",
      desired_state: "online",
      worker_id: "a-worker-that-died",
      last_heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    assert.equal(store.row(CLINIC_A)?.worker_id, "worker-under-test");

    handshake.release();
  });
});

describe("failures on the asynchronous half", () => {
  it("records a handshake that fails after the acknowledgement", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const sessions = manager(store, handshake);
    handshake.failWith(new Error("baileys refused the connection"));

    // The caller is answered, because at that point nothing had gone wrong.
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    handshake.release();

    await waitFor(
      () => store.row(CLINIC_A)?.status === "error",
      "the failed startup to reach the session row",
    );
    const row = store.row(CLINIC_A);
    assert.equal(row?.last_error, "unavailable");
    assert.equal(row?.qr_payload, null);
    // Still wanted online: the clinic asked for a pairing and the reconcile
    // sweep is what retries it. Marking it offline here would strand them.
    assert.equal(row?.desired_state, "online");
  });

  it("lets a later start recover a clinic whose handshake failed", async () => {
    const store = new FakeStore("worker-under-test");
    const failing = gatedSocketFactory();
    const sessions = manager(store, failing);
    failing.failWith(new Error("transient"));
    await sessions.start(CLINIC_A);
    failing.release();
    await waitFor(() => store.row(CLINIC_A)?.status === "error", "the failure to be recorded");

    // The failed start released its slot, so the clinic is not wedged: asking
    // again really does open a socket rather than returning the dead start's
    // outcome.
    failing.failWith(null);
    assert.deepEqual(await sessions.start(CLINIC_A), { ok: true });
    await waitFor(() => failing.sockets.length === 1, "the retry to publish a socket");
    assert.equal(failing.calls, 2);
    assert.equal(store.row(CLINIC_A)?.last_error, null);
  });

  it("still rejects when the durable write itself fails", async () => {
    const store = new FakeStore("worker-under-test");
    const handshake = gatedSocketFactory();
    const config = testConfig({ workerId: store.workerId });
    const sessions = new SessionManager(config, store.asStore(), handshake.factory);
    const server = createWorkerServer(config, sessions, store.asStore());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    // Nothing durable could be written, so there is no state for the panel to
    // poll and the caller must be told — the early answer must not paper over
    // a start that never happened.
    store.upsertError = new Error("database unavailable");

    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiToken}` },
    });

    assert.equal(response.status, 500);
    assert.equal(handshake.calls, 0);

    handshake.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
