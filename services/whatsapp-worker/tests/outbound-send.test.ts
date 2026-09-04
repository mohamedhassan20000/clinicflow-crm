import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WAMessage } from "baileys";
import { LidDirectory } from "../src/jids.ts";
import { SentMessageCache, selectSendTarget } from "../src/outbound.ts";
import { SessionManager } from "../src/sessions.ts";
import { CLINIC_A, connectedSession, fakeSocket, FakeStore, testConfig, waitFor } from "./harness.ts";

/**
 * The bug this suite exists to prevent: a message that ClinicFlow reports as sent,
 * that WhatsApp accepts and returns a message id for, and that then sits on the
 * recipient's phone forever as "Waiting for this message. This may take a while."
 *
 * Two independent causes, neither of which produces an error anywhere:
 *
 *   1. **The retry was never answered.** A recipient who cannot decrypt asks the
 *      sender to re-send. Baileys answers that receipt by calling the `getMessage`
 *      hook for the plaintext, and the library default returns `undefined`, so the
 *      worker consumed every retry and re-sent nothing. The placeholder is then
 *      permanent by construction.
 *
 *   2. **The address space was forced.** The send path hard-coded
 *      `${digits}@s.whatsapp.net` regardless of how the conversation was actually
 *      addressed. Baileys 6.7.24 keys Signal sessions on the JID's user part alone,
 *      so a LID-addressed chat and a phone-addressed one are two unrelated session
 *      records for the same device, with nothing in this version reconciling them.
 *
 * The other half of the suite is what must *not* change while fixing that: a LID is
 * only ever used when WhatsApp asserted it, one contact's LID is never reachable
 * from another contact's number, and an account with no LID of its own keeps to the
 * phone-number path — the LID branch of `relayMessage` dereferences `me.lid`
 * unguarded and would throw the send away.
 */

const PATIENT_PHONE = "+20100000000";
const PATIENT_PN_JID = "20100000000@s.whatsapp.net";
const PATIENT_LID_JID = "182736450192837@lid";

const OTHER_PHONE = "+20155555555";
const OTHER_PN_JID = "20155555555@s.whatsapp.net";

const OWN_LID = "555000111222@lid";

/** An inbound stanza on a LID chat carrying the `sender_pn` WhatsApp asserts with it. */
function lidMessageWithAssertedPhone(lidJid: string, pnJid: string): WAMessage {
  return {
    key: { id: "3EB0ABCDEF", fromMe: false, remoteJid: lidJid, senderPn: pnJid },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as unknown as WAMessage;
}

describe("outbound address selection", () => {
  it("sends to a PN-only contact over the phone-number path", () => {
    const target = selectSendTarget({
      phone: PATIENT_PHONE,
      directory: new LidDirectory(),
      ownLid: OWN_LID,
      lidRoutingEnabled: true,
    });
    assert.equal(target.jid, PATIENT_PN_JID);
    assert.equal(target.addressKind, "pn");
    assert.equal(target.mappingSource, "none");
  });

  it("sends to the LID address once WhatsApp has asserted the mapping", () => {
    const directory = new LidDirectory();
    directory.remember(PATIENT_LID_JID, PATIENT_PN_JID);

    const target = selectSendTarget({
      phone: PATIENT_PHONE,
      directory,
      ownLid: OWN_LID,
      lidRoutingEnabled: true,
    });
    assert.equal(target.jid, PATIENT_LID_JID);
    assert.equal(target.addressKind, "lid");
    assert.equal(target.mappingSource, "directory");
  });

  it("never guesses an identifier it was not given", () => {
    const directory = new LidDirectory();
    // One contact's mapping is known...
    directory.remember(PATIENT_LID_JID, PATIENT_PN_JID);

    // ...which must tell us nothing whatsoever about a different contact.
    const other = selectSendTarget({
      phone: OTHER_PHONE,
      directory,
      ownLid: OWN_LID,
      lidRoutingEnabled: true,
    });
    assert.equal(other.jid, OTHER_PN_JID);
    assert.equal(other.addressKind, "pn");
    assert.equal(other.mappingSource, "none");

    // A LID is not derivable from a phone number, so the number's own digits
    // must never turn up in the LID namespace.
    assert.notEqual(other.jid, "20155555555@lid");
    assert.equal(directory.lidJidFor(OTHER_PHONE), null);
  });

  it("keeps to the phone-number path when this device has no LID of its own", () => {
    const directory = new LidDirectory();
    directory.remember(PATIENT_LID_JID, PATIENT_PN_JID);

    // `relayMessage` does `creds?.me?.lid.split(':')[0]` on the LID branch — the
    // optional chain stops before `.lid`, so an absent LID throws the send away.
    for (const ownLid of [null, undefined, ""]) {
      const target = selectSendTarget({
        phone: PATIENT_PHONE,
        directory,
        ownLid,
        lidRoutingEnabled: true,
      });
      assert.equal(target.addressKind, "pn", `ownLid=${String(ownLid)} must not take the LID path`);
    }
  });

  it("can be pinned to the phone-number path from configuration", () => {
    const directory = new LidDirectory();
    directory.remember(PATIENT_LID_JID, PATIENT_PN_JID);

    const target = selectSendTarget({
      phone: PATIENT_PHONE,
      directory,
      ownLid: OWN_LID,
      lidRoutingEnabled: false,
    });
    assert.equal(target.jid, PATIENT_PN_JID);
    assert.equal(target.addressKind, "pn");
  });
});

describe("LID directory", () => {
  it("resolves in both directions from one asserted pair, and invents neither", () => {
    const directory = new LidDirectory();
    assert.equal(directory.lidJidFor(PATIENT_PHONE), null);

    directory.remember(PATIENT_LID_JID, PATIENT_PN_JID);
    assert.equal(directory.lookup(PATIENT_LID_JID), PATIENT_PHONE);
    assert.equal(directory.lidJidFor(PATIENT_PHONE), PATIENT_LID_JID);

    // Device suffixes address the same person, not a different one.
    assert.equal(directory.lookup("182736450192837:3@lid"), PATIENT_PHONE);

    // Nothing was learned about anyone else.
    assert.equal(directory.lidJidFor(OTHER_PHONE), null);
    assert.equal(directory.lookup("999999999999999@lid"), null);
  });

  it("refuses a pairing that is missing either half", () => {
    const directory = new LidDirectory();
    directory.remember(PATIENT_LID_JID, null);
    directory.remember(null, PATIENT_PN_JID);
    // A phone-number JID is not a LID, so this is not a pairing either.
    directory.remember(PATIENT_PN_JID, PATIENT_PN_JID);
    assert.equal(directory.size, 0);
    assert.equal(directory.lidJidFor(PATIENT_PHONE), null);
  });
});

describe("the retry-repair cache", () => {
  it("hands back the plaintext Baileys needs to answer a retry receipt", () => {
    const cache = new SentMessageCache();
    cache.remember("MSG1", { conversation: "your appointment is confirmed" });
    assert.deepEqual(cache.lookup("MSG1"), { conversation: "your appointment is confirmed" });
    // An id we never sent is a miss, not a throw.
    assert.equal(cache.lookup("MSG-UNKNOWN"), undefined);
    assert.equal(cache.lookup(null), undefined);
  });

  it("ignores an entry it could not key or has no content for", () => {
    const cache = new SentMessageCache();
    cache.remember(null, { conversation: "x" });
    cache.remember("", { conversation: "x" });
    cache.remember("MSG1", null);
    assert.equal(cache.size, 0);
  });

  it("stays bounded, evicting oldest first", () => {
    const cache = new SentMessageCache(3);
    for (const id of ["a", "b", "c", "d"]) cache.remember(id, { conversation: id });
    assert.equal(cache.size, 3);
    assert.equal(cache.lookup("a"), undefined, "the oldest send is evicted");
    assert.deepEqual(cache.lookup("d"), { conversation: "d" });
  });
});

describe("sending through a live session", () => {
  it("addresses a PN-only contact by phone number and retains it for retry", async () => {
    const harness = await connectedSession({ ownLid: OWN_LID });
    try {
      const outcome = await harness.sessions.send(CLINIC_A, PATIENT_PHONE, "hello");
      assert.equal(outcome.ok, true);
      assert.deepEqual(
        harness.socket.sends.map((send) => send.jid),
        [PATIENT_PN_JID],
      );
    } finally {
      harness.restore();
    }
  });

  it("switches to the LID address after an inbound message asserts the mapping", async () => {
    const harness = await connectedSession({ ownLid: OWN_LID });
    try {
      // Before WhatsApp has said anything, the only address we have is the number.
      await harness.sessions.send(CLINIC_A, PATIENT_PHONE, "first");
      assert.equal(harness.socket.sends[0]?.jid, PATIENT_PN_JID);

      // The patient writes in on a LID-addressed chat; the stanza carries the
      // `sender_pn` that ties the two together.
      await harness.upsert({
        type: "notify",
        messages: [lidMessageWithAssertedPhone(PATIENT_LID_JID, PATIENT_PN_JID)],
      });

      await harness.sessions.send(CLINIC_A, PATIENT_PHONE, "second");
      assert.equal(
        harness.socket.sends[1]?.jid,
        PATIENT_LID_JID,
        "the reply must go to the address space the conversation is being held in",
      );
    } finally {
      harness.restore();
    }
  });

  it("does not let one contact's LID capture another contact's number", async () => {
    const harness = await connectedSession({ ownLid: OWN_LID });
    try {
      await harness.upsert({
        type: "notify",
        messages: [lidMessageWithAssertedPhone(PATIENT_LID_JID, PATIENT_PN_JID)],
      });

      await harness.sessions.send(CLINIC_A, PATIENT_PHONE, "to the mapped patient");
      await harness.sessions.send(CLINIC_A, OTHER_PHONE, "to the unmapped patient");

      assert.deepEqual(
        harness.socket.sends.map((send) => send.jid),
        [PATIENT_LID_JID, OTHER_PN_JID],
      );
      // The unmapped contact's message must not have been addressed into the LID
      // namespace at all — that would deliver a patient's message to a stranger.
      assert.equal(harness.socket.sends[1]?.content.text, "to the unmapped patient");
    } finally {
      harness.restore();
    }
  });

  it("reports a transport failure without leaking the recipient", async () => {
    const harness = await connectedSession({ ownLid: OWN_LID });
    try {
      harness.socket.sendError = new Error("boom");
      const outcome = await harness.sessions.send(CLINIC_A, PATIENT_PHONE, "hello");
      assert.deepEqual(outcome, { ok: false, code: "SEND_FAILED" });
    } finally {
      harness.restore();
    }
  });

  it("refuses a recipient that is not a usable number", async () => {
    const harness = await connectedSession({ ownLid: OWN_LID });
    try {
      for (const recipient of ["", "+12", "not-a-number"]) {
        const outcome = await harness.sessions.send(CLINIC_A, recipient, "hello");
        assert.deepEqual(outcome, { ok: false, code: "INVALID_RECIPIENT" });
      }
      assert.equal(harness.socket.sends.length, 0);
    } finally {
      harness.restore();
    }
  });
});

describe("answering a retry receipt", () => {
  /**
   * The wiring, not just the cache: the object handed to the socket factory —
   * which production closes over as `getMessage: async key => sent.lookup(key.id)`
   * — must be the very object the send path writes into. A cache populated on one
   * instance and read on another would leave `getMessage` returning undefined and
   * the placeholder permanent, which is the original bug wearing a passing unit
   * test.
   */
  it("leaves the sent plaintext where the socket's getMessage hook will find it", async () => {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });
    const socket = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });

    const caches: SentMessageCache[] = [];
    const manager = new SessionManager(config, store.asStore(), async (_auth, sent) => {
      caches.push(sent);
      return socket;
    });
    await manager.start(CLINIC_A);
    await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket");
    socket.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session");

    const outcome = await manager.send(CLINIC_A, PATIENT_PHONE, "your appointment is confirmed");
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.providerMessageId);

    assert.equal(caches.length, 1);
    // This is exactly what `getMessage({ id })` resolves to in production.
    assert.deepEqual(caches[0]!.lookup(outcome.providerMessageId!), {
      conversation: "your appointment is confirmed",
    });

    await manager.shutdown();
  });

  /**
   * A dropped socket is precisely what produces undecryptable messages, so the
   * reconnected socket must still be able to answer retries for what the previous
   * one sent. If the cache were rebuilt per socket, the repair would be disarmed
   * at the only moment it matters.
   */
  it("still answers retries for messages sent before a reconnect", async () => {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });

    const caches: SentMessageCache[] = [];
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const manager = new SessionManager(config, store.asStore(), async (_auth, sent) => {
      caches.push(sent);
      const socket = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });
      sockets.push(socket);
      return socket;
    });

    await manager.start(CLINIC_A);
    await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the first socket");
    sockets[0]!.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the first session");

    const sent = await manager.send(CLINIC_A, PATIENT_PHONE, "sent before the drop");
    assert.equal(sent.ok, true);
    const pendingId = sent.ok ? sent.providerMessageId! : "";

    // Baileys asks for a clean restart after pairing; the manager reopens in place.
    sockets[0]!.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await waitFor(() => sockets.length === 2, "the socket to be reopened");

    assert.equal(caches.length, 2);
    assert.equal(caches[1], caches[0], "the reconnected socket shares the clinic's retry cache");
    assert.deepEqual(
      caches[1]!.lookup(pendingId),
      { conversation: "sent before the drop" },
      "a retry arriving after the reconnect can still be repaired",
    );

    await manager.shutdown();
  });

  it("forgets a clinic's plaintext once the pairing itself ends", async () => {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });
    const socket = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });

    const caches: SentMessageCache[] = [];
    const manager = new SessionManager(config, store.asStore(), async (_auth, sent) => {
      caches.push(sent);
      return socket;
    });
    await manager.start(CLINIC_A);
    await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket");
    socket.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session");

    await manager.send(CLINIC_A, PATIENT_PHONE, "hello");
    assert.equal(caches[0]!.size, 1);

    await manager.logout(CLINIC_A);
    // A subsequent start gets a clean cache rather than the retired pairing's.
    const socketB = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });
    const managerB = new SessionManager(config, store.asStore(), async (_auth, sent) => {
      caches.push(sent);
      return socketB;
    });
    await managerB.start(CLINIC_A);
    await waitFor(() => managerB.clinicIds().includes(CLINIC_A), "the new socket");
    assert.equal(caches[1]!.size, 0);

    await managerB.shutdown();
  });
});

describe("a worker restart", () => {
  /**
   * The full round trip the real thing performs on a redeploy: a second
   * `SessionManager` over the *same* store, restoring the device identity the
   * first one persisted, then sending.
   *
   * The auth state is deliberately not rewritten by this suite — it is read back
   * through the same `useSupabaseAuthState` the worker uses, so what is asserted
   * is that the persisted keys survive a process boundary, not that some test
   * double round-trips its own input.
   */
  it("restores the persisted identity and sends on the new socket", async () => {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });

    const first = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });
    const managerA = new SessionManager(config, store.asStore(), async () => first);
    await managerA.start(CLINIC_A);
    await waitFor(() => managerA.clinicIds().includes(CLINIC_A), "the first socket");
    first.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the first session to open");

    // Something must actually have been written, or the restore below would be
    // vacuously satisfied by a fresh identity.
    const persisted = [...store.auth.keys()].filter((key) => key.startsWith(`${CLINIC_A}:creds:`));
    assert.equal(persisted.length, 1, "the device identity is persisted under the clinic");
    const credsBefore = store.auth.get(persisted[0]!);

    await managerA.shutdown();
    assert.equal(first.ended, true);
    // A redeploy must not destroy the pairing.
    assert.equal(store.row(CLINIC_A)?.desired_state, "online");
    assert.equal(
      store.auth.get(persisted[0]!),
      credsBefore,
      "shutdown leaves the stored identity untouched",
    );

    // --- the new process ---
    const restoredAuth: boolean[] = [];
    const second = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });
    const managerB = new SessionManager(config, store.asStore(), async (auth) => {
      restoredAuth.push(auth.restored);
      return second;
    });
    await managerB.restoreAll();
    await waitFor(() => managerB.clinicIds().includes(CLINIC_A), "the restored socket");
    second.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the restored session");

    assert.deepEqual(restoredAuth, [true], "the second process reuses the stored device identity");

    const outcome = await managerB.send(CLINIC_A, PATIENT_PHONE, "after the restart");
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      second.sends.map((send) => send.jid),
      [PATIENT_PN_JID],
    );
    assert.equal(first.sends.length, 0, "nothing went out on the retired socket");

    await managerB.shutdown();
  });

  /**
   * A LID the *previous* process learned is not carried across the restart, and
   * that is correct rather than a gap: the directory holds only assertions the
   * live socket received, and the new socket re-learns each chat from its next
   * message. Inventing a LID for a contact this process has heard nothing about
   * is exactly the guess that must never happen.
   */
  it("re-learns mappings rather than assuming the previous process's", async () => {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });

    const socket = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: OWN_LID });
    const manager = new SessionManager(config, store.asStore(), async () => socket);
    await manager.start(CLINIC_A);
    await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket");
    socket.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session");

    await manager.send(CLINIC_A, PATIENT_PHONE, "cold start");
    assert.equal(
      socket.sends[0]?.jid,
      PATIENT_PN_JID,
      "a session that has learned nothing yet uses the supported phone-number path",
    );

    await manager.shutdown();
  });
});
