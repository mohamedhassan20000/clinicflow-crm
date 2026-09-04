import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WASocket } from "baileys";
import { BufferJSON, initAuthCreds } from "baileys";
import { decryptAuthValue, encryptAuthValue } from "../src/crypto.ts";
import { SessionManager } from "../src/sessions.ts";
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
 * What a handoff must cost the clinic: **nothing.**
 *
 * `ownership-handoff.test.ts` proves the ownership column moves correctly. This
 * one proves the thing the clinic actually experiences, which is a different
 * claim and is not implied by the first: the WhatsApp device identity survives
 * the transfer intact, nobody is asked to scan a QR code, and the worker taking
 * over connects from the stored credentials rather than minting a new pairing.
 *
 * That distinction is not academic. A worker that fails to restore auth does not
 * error — it calls `initAuthCreds()`, persists a brand-new identity, and asks
 * WhatsApp for a pairing code. Every ownership assertion in the other suite
 * would still pass, and the clinic would be staring at a QR screen with their
 * inbox dark. The load-bearing assertions here are therefore: the auth state
 * handed to the handshake reads `registered: true`, no fresh `creds:state` was
 * ever written, and the decrypted identity is unchanged end to end.
 *
 * The ciphertext deliberately is *not* compared: `encryptAuthValue` draws a
 * random 12-byte nonce per call, so two envelopes around identical plaintext
 * differ by construction. The comparison is on the decrypted contents, which is
 * what "the same device identity" actually means.
 */

const PROD = "railway-prod";
const DEV = "local-dev";
const SESSION_JID = "201111111111:7@s.whatsapp.net";
const CREDENTIALS_KEY = testConfig().credentialsKey;

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

function seedRegisteredAuth(auth: Map<string, string>): void {
  const creds = {
    ...initAuthCreds(),
    registered: true,
    me: { id: SESSION_JID, name: "Registered Device" },
  } as unknown as Record<string, unknown>;
  auth.set(
    `${CLINIC_A}:creds:state`,
    encryptAuthValue(JSON.stringify(creds, BufferJSON.replacer), CREDENTIALS_KEY),
  );
}

function storedCreds(auth: Map<string, string>): Record<string, unknown> {
  const stored = auth.get(`${CLINIC_A}:creds:state`);
  assert.ok(stored, "the clinic should still have a stored device identity");
  return JSON.parse(decryptAuthValue(stored, CREDENTIALS_KEY), BufferJSON.reviver) as Record<
    string,
    unknown
  >;
}

/** Every auth row the clinic has, decrypted — the whole identity, not just creds. */
function decryptedAuth(auth: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of auth) {
    if (!key.startsWith(`${CLINIC_A}:`)) continue;
    out[key] = JSON.parse(decryptAuthValue(value, CREDENTIALS_KEY), BufferJSON.reviver) as unknown;
  }
  return out;
}

/** The write a *fresh* identity always makes before its first socket opens. */
function credsWrites(store: FakeStore): number {
  return store.authWrites.filter((write) => write === "creds:state").length;
}

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

function assertNoScanWasRequested(database: Map<string, StoredSession>, when: string): void {
  const current = row(database);
  assert.notEqual(current.status, "awaiting_scan", `a QR scan was requested ${when}`);
  assert.equal(current.qr_payload ?? null, null, `a QR code was published ${when}`);
}

describe("a registered pairing survives a handoff in both directions", () => {
  it("moves production → laptop → production with no scan and no new identity", async () => {
    const { database, auth, prodStore, devStore, prod, dev, prodSockets, devSockets } = twoWorkers();
    seedRegisteredAuth(auth);
    const identityAtRest = decryptedAuth(auth);

    // ---- Railway owns a registered session --------------------------------
    const prodSocket = await connect(prod, prodSockets, prodStore);
    assert.equal(row(database).worker_id, PROD);
    assert.equal((prodSockets.auths[0] as { state: { creds: Record<string, unknown> } }).state.creds.registered, true, "production minted a new identity");
    assert.equal(credsWrites(prodStore), 0, "production persisted a fresh identity");

    // ---- The laptop asks; it does not take --------------------------------
    assert.deepEqual(await dev.start(CLINIC_A), { ok: false, code: "OWNED_ELSEWHERE" });
    assert.equal(row(database).handoff_to, DEV);
    assert.equal(row(database).worker_id, PROD);
    assert.equal(prodSocket.ended, false, "the holder dropped its socket on being asked");

    // ---- Railway honours it on its next tick ------------------------------
    await prod.honorHandoffs();
    assert.equal(prodSocket.ended, true, "the holder kept its socket");
    assert.equal(prodSocket.loggedOut, false, "the holder unlinked the device");
    assert.equal(row(database).worker_id, null);
    assert.equal(row(database).desired_state, "online", "the clinic was taken offline by a handoff");
    assert.deepEqual(prodStore.clearAuthCalls, [], "the holder destroyed the stored identity");

    // ---- The laptop wins the ordinary fenced claim ------------------------
    await dev.reconcile();
    await waitFor(() => dev.clinicIds().includes(CLINIC_A), "the laptop's socket");
    assert.equal(row(database).worker_id, DEV);
    assert.equal(row(database).handoff_to, null);

    // The claims that matter: it connected *from storage*, wrote no new
    // identity, and asked nobody to scan anything.
    assert.equal((devSockets.auths[0] as { state: { creds: Record<string, unknown> } }).state.creds.registered, true, "the laptop minted a new identity");
    assert.equal(credsWrites(devStore), 0, "the laptop persisted a fresh identity");
    assertNoScanWasRequested(database, "on the way to the laptop");
    assert.deepEqual(decryptedAuth(auth), identityAtRest, "the stored identity changed");

    // ---- And back again, on an ordinary Ctrl+C ----------------------------
    await dev.shutdown();
    assert.equal((devSockets.sockets[0] as FakeSocket).ended, true);
    assert.equal((devSockets.sockets[0] as FakeSocket).loggedOut, false, "Ctrl+C unlinked the device");
    assert.equal(row(database).worker_id, null);
    assert.equal(row(database).handoff_to, null, "a fence was left behind");

    await prod.reconcile();
    await waitFor(() => prod.clinicIds().includes(CLINIC_A), "production's socket");
    assert.equal(row(database).worker_id, PROD);
    assert.equal((prodSockets.auths[1] as { state: { creds: Record<string, unknown> } }).state.creds.registered, true, "production minted a new identity");
    assert.equal(credsWrites(prodStore), 0, "production persisted a fresh identity");
    assert.equal(row(database).desired_state, "online");
    assertNoScanWasRequested(database, "on the way back to production");
    assert.deepEqual(decryptedAuth(auth), identityAtRest, "the stored identity changed");
    assert.equal(storedCreds(auth).registered, true);
  });

  it("does not ask for a scan when ownership is lost rather than handed over", async () => {
    // The uncooperative version of the same journey: nobody released anything,
    // the laptop simply went away and came back to a clinic somebody else owns.
    // A fence is not a pairing failure and must not be reported as one.
    const { database, auth, prodStore, devStore, prod, dev, prodSockets, devSockets } = twoWorkers();
    seedRegisteredAuth(auth);
    const identityAtRest = decryptedAuth(auth);

    await connect(dev, devSockets, devStore);
    database.set(CLINIC_A, {
      ...row(database),
      last_heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
    });
    await prod.reconcile();
    await waitFor(() => prod.clinicIds().includes(CLINIC_A), "production to adopt the clinic");
    (prodSockets.sockets[0] as FakeSocket).emit("connection.update", { connection: "open" });
    await waitFor(
      () => prodStore.row(CLINIC_A)?.status === "connected",
      "production to identify itself",
    );

    await dev.heartbeat();

    assert.equal(dev.clinicIds().length, 0);
    assert.equal(row(database).worker_id, PROD);
    assert.equal(row(database).status, "connected", "the fence overwrote the new owner's status");
    assert.equal(row(database).last_error ?? null, null, "the fence was reported as an error");
    assertNoScanWasRequested(database, "after an ownership loss");
    assert.deepEqual(decryptedAuth(auth), identityAtRest, "the stored identity changed");
    assert.equal(credsWrites(devStore), 0);
    assert.equal(credsWrites(prodStore), 0);
    assert.equal((prodSockets.auths[0] as { state: { creds: Record<string, unknown> } }).state.creds.registered, true);
  });
});
