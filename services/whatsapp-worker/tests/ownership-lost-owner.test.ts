import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WASocket } from "baileys";
import { BufferJSON, initAuthCreds } from "baileys";
import { decryptAuthValue, encryptAuthValue } from "../src/crypto.ts";
import { SessionManager } from "../src/sessions.ts";
import { HEARTBEAT_STALE_MS } from "../src/store.ts";
import {
  CLINIC_A,
  FakeStore,
  type FakeSocket,
  type StoredSession,
  fakeSocket,
  testConfig,
  waitFor,
} from "./harness.ts";

/**
 * The gap this suite closes: **a worker that has lost a clinic must stop being a
 * worker for it, immediately and by itself.**
 *
 * `ownership-handoff.test.ts` proves ownership only ever moves cooperatively or
 * after a stale window. That is the *transfer* half of the invariant, and it was
 * complete. What was missing is the half that runs on the side that lost:
 *
 *   a developer's Mac owns a clinic. The lid closes. The process is frozen — no
 *   heartbeat, no shutdown, no release — for longer than `HEARTBEAT_STALE_MS`,
 *   so the deployed worker legitimately adopts the clinic. Then the lid opens.
 *
 * At that instant the resumed process still has a live Baileys socket on the
 * linked device, a reconnect backoff that is about to fire, a send path that
 * will happily use the socket, and — worst of all — an auth writer that will
 * overwrite the Signal key material the *new* owner is now ratcheting. None of
 * those paths consulted ownership: they consulted local memory, and local memory
 * was three hours out of date. Nothing in the worker noticed until a reconcile
 * sweep happened to run, and reconcile never looked at sessions it believed it
 * already held.
 *
 * The heartbeat is the natural place to notice, because it is already a scoped
 * `UPDATE ... WHERE worker_id = me` — it simply threw away the answer. It now
 * reports which rows it renewed, and everything it did not renew is fenced on
 * the spot. Every assertion below is about that fence holding on all five paths:
 * reconnect, send, inbound, auth writes, and the socket itself.
 */

const PROD = "railway-prod";
const DEV = "local-dev";
const PATIENT = "+201234567890";
const SESSION_JID = "201111111111:7@s.whatsapp.net";
const CREDENTIALS_KEY = testConfig().credentialsKey;

/**
 * A socket factory that never blocks and keeps what it was handed.
 *
 * `gatedSocketFactory` would do for the sockets alone, but these tests have to
 * assert on the *auth state* the manager passed into the handshake — that is
 * where "did this worker connect from stored credentials, or mint a new
 * identity?" is actually visible — and they drive managers through `reconcile()`,
 * which awaits the start it admits and would deadlock on a gated handshake.
 */
function recordingFactory(userJid: string = SESSION_JID) {
  const sockets: FakeSocket[] = [];
  const auths: Array<{ state: { creds: Record<string, unknown> } }> = [];
  return {
    sockets,
    auths,
    get calls() {
      return sockets.length;
    },
    factory: async (auth: unknown): Promise<WASocket> => {
      auths.push(auth as { state: { creds: Record<string, unknown> } });
      const socket = fakeSocket(userJid);
      sockets.push(socket);
      return socket as unknown as WASocket;
    },
  };
}

/**
 * A registered linked device, exactly as a completed QR scan leaves it.
 *
 * Seeded straight into the shared auth table rather than produced by a pairing,
 * because what these tests are about is what happens to an identity that
 * *already exists*: a handoff that quietly mints a new one looks identical from
 * the outside right up until the clinic is asked to scan again.
 */
function seedRegisteredAuth(auth: Map<string, string>): Record<string, unknown> {
  const creds = {
    ...initAuthCreds(),
    registered: true,
    me: { id: SESSION_JID, name: "Registered Device" },
  } as unknown as Record<string, unknown>;
  auth.set(
    `${CLINIC_A}:creds:state`,
    encryptAuthValue(JSON.stringify(creds, BufferJSON.replacer), CREDENTIALS_KEY),
  );
  return storedCreds(auth);
}

/** The stored identity as plaintext. Ciphertext is nonce-randomised; this is not. */
function storedCreds(auth: Map<string, string>): Record<string, unknown> {
  const stored = auth.get(`${CLINIC_A}:creds:state`);
  assert.ok(stored, "the clinic should have a stored device identity");
  return JSON.parse(decryptAuthValue(stored, CREDENTIALS_KEY), BufferJSON.reviver) as Record<
    string,
    unknown
  >;
}

/** Two workers, one session table and — crucially — one auth table. */
function twoWorkers() {
  const database = new Map<string, StoredSession>();
  const auth = new Map<string, string>();
  const prodStore = new FakeStore(PROD, database, auth);
  const devStore = new FakeStore(DEV, database, auth);
  const prodSockets = recordingFactory();
  const devSockets = recordingFactory();
  return {
    database,
    auth,
    prodStore,
    devStore,
    prodSockets,
    devSockets,
    prod: new SessionManager(testConfig({ workerId: PROD }), prodStore.asStore(), prodSockets.factory),
    dev: new SessionManager(
      testConfig({ workerId: DEV, devTakeover: true }),
      devStore.asStore(),
      devSockets.factory,
    ),
  };
}

function row(database: Map<string, StoredSession>): StoredSession {
  const found = database.get(CLINIC_A);
  assert.ok(found, "the clinic should have a session row");
  return found;
}

/** Backdates the heartbeat, exactly as a suspended process would leave it. */
function ageHeartbeat(database: Map<string, StoredSession>, byMs: number): void {
  database.set(CLINIC_A, {
    ...row(database),
    last_heartbeat_at: new Date(Date.now() - byMs).toISOString(),
  });
}

/** Brings a manager up to a live, identified socket for the clinic. */
async function connect(
  manager: SessionManager,
  sockets: ReturnType<typeof recordingFactory>,
  store: FakeStore,
): Promise<FakeSocket> {
  assert.deepEqual(await manager.start(CLINIC_A), { ok: true });
  await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket to be published");
  const socket = sockets.sockets[sockets.sockets.length - 1] as FakeSocket;
  socket.emit("connection.update", { connection: "open" });
  await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session to identify itself");
  return socket;
}

/**
 * Nothing here may ever put a clinic back on the scan screen. A QR is a *person*
 * walking to a phone, and an ownership change is not a reason to ask for one.
 */
function assertNoScanWasRequested(database: Map<string, StoredSession>): void {
  const current = row(database);
  assert.notEqual(current.status, "awaiting_scan", "a QR scan was requested");
  assert.equal(current.qr_payload ?? null, null, "a QR code was published");
}

describe("a worker that loses ownership while suspended fences itself", () => {
  it("stops serving the clinic the moment its heartbeat stops matching", async () => {
    const { database, auth, devStore, dev, devSockets, prod, prodSockets } = twoWorkers();
    seedRegisteredAuth(auth);

    // ---- The developer is driving the clinic from their Mac ----------------
    const devSocket = await connect(dev, devSockets, devStore);
    assert.equal(row(database).worker_id, DEV);
    const beforeSleep = await dev.send(CLINIC_A, PATIENT, "before the lid closed");
    assert.equal(beforeSleep.ok, true);
    assert.equal(devSocket.sends.length, 1);
    const authWritesBeforeSleep = devStore.authWrites.length;

    // ---- The lid closes ----------------------------------------------------
    // No shutdown, no release, no heartbeat: the process is simply frozen. All
    // the database can observe is a heartbeat that stops advancing.
    ageHeartbeat(database, HEARTBEAT_STALE_MS + 1_000);

    // ---- Railway adopts the clinic, correctly -----------------------------
    await prod.reconcile();
    await waitFor(() => prod.clinicIds().includes(CLINIC_A), "production to adopt the clinic");
    assert.equal(row(database).worker_id, PROD);

    // ---- The lid opens -----------------------------------------------------
    // The very next thing the resumed process does is its heartbeat tick. The
    // scoped update matches nothing, and that is the whole signal.
    await dev.heartbeat();

    // 1. The socket is closed — and *not* logged out. Unlinking here would
    //    destroy the identity production is now using.
    assert.equal(devSocket.ended, true, "the stale socket was left open");
    assert.equal(devSocket.loggedOut, false, "the resumed worker unlinked the device");
    assert.equal(dev.clinicIds().length, 0, "the resumed worker still holds the clinic");
    assert.deepEqual(devStore.clearAuthCalls, [], "the resumed worker destroyed stored auth");

    // 2. No outbound send. A duplicate message from a worker that no longer owns
    //    the device is exactly the visible symptom of split brain.
    assert.deepEqual(await dev.send(CLINIC_A, PATIENT, "after waking up"), {
      ok: false,
      code: "NO_SESSION",
    });
    assert.equal(devSocket.sends.length, 1, "a fenced worker sent a message");

    // 3. No auth writes. Baileys goes on emitting `creds.update` at a socket for
    //    as long as it is alive, and this is the write that corrupts the *other*
    //    worker's Signal state rather than merely duplicating traffic.
    devSocket.emit("creds.update", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      devStore.authWrites.length,
      authWritesBeforeSleep,
      "a fenced worker wrote auth state",
    );

    // 4. No reconnect. The drop that follows an `end()` is delivered to a
    //    handler that has to refuse to schedule anything.
    devSocket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(devSockets.calls, 1, "a fenced worker opened a second socket");

    // 5. No inbound processing: a message delivered to the dying socket must not
    //    be posted a second time by a worker that no longer serves the clinic.
    devSocket.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "3EB0STALE", fromMe: false, remoteJid: "201234567890@s.whatsapp.net" },
          message: { conversation: "hello" },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 6. Production is still the sole owner, still holding its socket, and
    //    nobody was asked to scan anything.
    assert.equal(row(database).worker_id, PROD);
    assert.equal(prod.clinicIds().includes(CLINIC_A), true);
    assert.equal(prodSockets.sockets.filter((socket) => !socket.ended).length, 1);
    assert.equal(row(database).desired_state, "online");
    assertNoScanWasRequested(database);
    assert.deepEqual(storedCreds(auth).registered, true);
  });

  it("does not reconnect on a backoff that expired while the clinic changed hands", async () => {
    const { database, auth, devStore, dev, devSockets, prod } = twoWorkers();
    seedRegisteredAuth(auth);
    const devSocket = await connect(dev, devSockets, devStore);

    // An established pairing drops, so a reconnect is queued with the ordinary
    // 2s backoff. This is the path that has no heartbeat tick in it at all: the
    // clinic is no longer in `clinicIds()`, so the sweep above cannot fence it,
    // and the timer is the only thing that will run.
    (devSockets.auths[0] as { state: { creds: Record<string, unknown> } }).state.creds.registered = true;
    devSocket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    await waitFor(() => devStore.row(CLINIC_A)?.status === "connecting", "the reconnect to queue");

    // The clinic changes hands inside the backoff window.
    ageHeartbeat(database, HEARTBEAT_STALE_MS + 1_000);
    await prod.reconcile();
    assert.equal(row(database).worker_id, PROD);

    // The timer fires. It must prove ownership before opening anything.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(devSockets.calls, 1, "the reconnect opened a socket on a clinic it had lost");
    assert.equal(dev.clinicIds().length, 0);
    assert.equal(row(database).worker_id, PROD);
    assertNoScanWasRequested(database);
  });

  it("keeps serving a clinic it still owns when the database is briefly unreachable", async () => {
    // The fence must be driven by a definite answer — "your row was not
    // matched" — never by the absence of one. A worker that abandoned its
    // clinics on a transient PostgREST failure would turn a database blip into
    // an outage, which is a worse bug than the one being fixed.
    const { database, auth, devStore, dev, devSockets } = twoWorkers();
    seedRegisteredAuth(auth);
    const devSocket = await connect(dev, devSockets, devStore);

    const realHeartbeat = devStore.heartbeat.bind(devStore);
    devStore.heartbeat = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    await dev.heartbeat();
    devStore.heartbeat = realHeartbeat;

    assert.equal(dev.clinicIds().includes(CLINIC_A), true, "an outage fenced a healthy session");
    assert.equal(devSocket.ended, false);
    assert.equal(row(database).worker_id, DEV);
  });
});
