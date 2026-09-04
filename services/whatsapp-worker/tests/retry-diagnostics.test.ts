import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyConsoleLine,
  installConsoleGuard,
  UNCLASSIFIED_EVENT,
  type GuardedConsoleRecord,
} from "../src/log-guard.ts";
import { SentMessageCache } from "../src/outbound.ts";
import {
  createGetMessage,
  createSocketLogger,
  messageRef,
  translateBaileysLog,
  type DiagnosticSink,
} from "../src/retry-diagnostics.ts";
import { SessionManager } from "../src/sessions.ts";
import { CLINIC_A, fakeSocket, FakeStore, testConfig, waitFor } from "./harness.ts";

/**
 * Two things are pinned here, and they pull in opposite directions.
 *
 * The first is that the retry-repair exchange must be *observable*: a real device
 * stuck on "Waiting for this message. This may take a while." has to produce a
 * log line at every step, or the only way to tell "the receipt never arrived"
 * from "the plaintext was gone" is to guess.
 *
 * The second is that none of that observability may cost a single byte of
 * anything private. The worker runs Baileys, which runs `libsignal`, which
 * narrates Signal session records — `privKey`, `rootKey`, `remoteIdentityKey`,
 * `pendingPreKey` — straight to the global console. That is the leak the guard
 * closes, and the sweep at the end of this suite is what keeps it closed: it
 * pushes realistic key material through every guarded console method and every
 * translator entry, and asserts that not one sentinel byte survives into
 * anything the worker would emit.
 */

/**
 * A `SessionEntry` shaped like the one `libsignal/src/session_record.js` passes
 * to `console.info("Closing session:", session)`, with every field that must
 * never be printed carrying a searchable sentinel.
 */
const SENTINELS = {
  privKey: "SENTINEL-PRIVATE-KEY-a1b2c3",
  rootKey: "SENTINEL-ROOT-KEY-d4e5f6",
  chainKey: "SENTINEL-CHAIN-KEY-090807",
  remoteIdentityKey: "SENTINEL-REMOTE-IDENTITY-112233",
  pendingPreKey: "SENTINEL-PENDING-PREKEY-445566",
  jid: "20100000000@s.whatsapp.net",
  lid: "182736450192837@lid",
  phone: "+20100000000",
  body: "SENTINEL-PATIENT-MESSAGE-BODY",
} as const;

function sessionEntry(): Record<string, unknown> {
  return {
    registrationId: 12345,
    currentRatchet: {
      rootKey: SENTINELS.rootKey,
      ephemeralKeyPair: { privKey: SENTINELS.privKey, pubKey: "pub" },
      lastRemoteEphemeralKey: SENTINELS.remoteIdentityKey,
    },
    indexInfo: {
      baseKey: SENTINELS.privKey,
      remoteIdentityKey: SENTINELS.remoteIdentityKey,
      closed: -1,
    },
    pendingPreKey: { baseKey: SENTINELS.pendingPreKey, preKeyId: 7 },
    chains: { [SENTINELS.jid]: { chainKey: { key: SENTINELS.chainKey, counter: 3 } } },
    _chains: {},
  };
}

/** Every sentinel value, for the "does this text contain anything private" sweep. */
const ALL_SENTINELS = Object.values(SENTINELS);

function assertNothingPrivate(emitted: unknown, what: string): void {
  const text = JSON.stringify(emitted) ?? "";
  for (const sentinel of ALL_SENTINELS) {
    assert.equal(
      text.includes(sentinel),
      false,
      `${what} leaked ${sentinel}\nemitted: ${text}`,
    );
  }
}

/** A console object that records what would have been printed had it not been guarded. */
function spyConsole() {
  const printed: unknown[][] = [];
  const record = (...args: unknown[]) => {
    printed.push(args);
  };
  return {
    printed,
    target: {
      log: record,
      info: record,
      warn: record,
      error: record,
      debug: record,
      trace: record,
      dir: record,
      dirxml: record,
      table: record,
      group: record,
      groupCollapsed: record,
    } as unknown as Partial<Console>,
  };
}

describe("the console guard", () => {
  it("classifies the libsignal line that was leaking session records", () => {
    assert.deepEqual(classifyConsoleLine("Closing session:"), {
      event: "signal_session_closed",
      level: "debug",
    });
    // Built by concatenation in session_cipher.js, so the tail must not matter.
    assert.equal(
      classifyConsoleLine(`Session error:Error: bad mac ${SENTINELS.jid}`).event,
      "signal_session_error",
    );
    assert.equal(classifyConsoleLine("Opening session:").event, "signal_session_opened");
    assert.equal(
      classifyConsoleLine("Failed to decrypt message with any known session...").event,
      "signal_decrypt_failed",
    );
  });

  it("refuses to stringify a non-string first argument in order to classify it", () => {
    // `console.info(sessionEntry)` with no leading string must not cause the
    // object to be formatted — not even to decide what to call the line.
    assert.equal(classifyConsoleLine(sessionEntry()).event, UNCLASSIFIED_EVENT);
    assert.equal(classifyConsoleLine(undefined).event, UNCLASSIFIED_EVENT);
    assert.equal(classifyConsoleLine(Buffer.from("secret")).event, UNCLASSIFIED_EVENT);
  });

  it("never lets a console argument reach the real console", () => {
    const spy = spyConsole();
    const records: GuardedConsoleRecord[] = [];
    const uninstall = installConsoleGuard({ target: spy.target, sink: (r) => records.push(r) });
    try {
      const guarded = spy.target as unknown as Console;
      // The exact call from libsignal/src/session_record.js:273.
      guarded.info("Closing session:", sessionEntry());
      guarded.warn("Session already closed", sessionEntry());
      guarded.error(`Session error:${SENTINELS.privKey}`, `at decrypt (${SENTINELS.jid})`);
    } finally {
      uninstall();
    }

    assert.equal(spy.printed.length, 0, "the underlying console was never called");
    assert.deepEqual(
      records.map((r) => r.event),
      ["signal_session_closed", "signal_session_already_closed", "signal_session_error"],
    );
    assert.deepEqual(
      records.map((r) => r.suppressedArgs),
      [2, 2, 2],
    );
    assertNothingPrivate(records, "the console guard");
  });

  /**
   * The regression guard proper. Signal state is pushed through every guarded
   * method, in first and later argument positions, both as a labelled line and
   * as a bare object — and the emitted records are searched for every sentinel.
   *
   * This is deliberately a sweep rather than a test of the one line that was
   * observed in production: `libsignal` has ten console call sites that pass
   * session records or stacks, and a future version may add an eleventh.
   */
  it("cannot emit Signal or private key material through any console method", () => {
    const spy = spyConsole();
    const records: GuardedConsoleRecord[] = [];
    const uninstall = installConsoleGuard({ target: spy.target, sink: (r) => records.push(r) });
    const methods = [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
      "dir",
      "dirxml",
      "table",
      "group",
      "groupCollapsed",
    ] as const;
    try {
      const guarded = spy.target as unknown as Record<string, (...args: unknown[]) => void>;
      for (const method of methods) {
        guarded[method]!("Closing session:", sessionEntry());
        guarded[method]!(sessionEntry());
        guarded[method]!(SENTINELS.privKey, SENTINELS.body, { lid: SENTINELS.lid });
        guarded[method]!({ creds: { noiseKey: { private: SENTINELS.privKey } } }, "boot");
      }
    } finally {
      uninstall();
    }

    assert.equal(spy.printed.length, 0);
    assert.equal(records.length, methods.length * 4);
    assertNothingPrivate(records, "the console guard sweep");
    // And the *only* strings it can produce are fixed identifiers, never content.
    for (const record of records) {
      assert.match(record.event, /^[a-z_]+$/);
    }
  });

  it("restores the real console when uninstalled", () => {
    const spy = spyConsole();
    const uninstall = installConsoleGuard({ target: spy.target, sink: () => {} });
    (spy.target as unknown as Console).info("while guarded");
    uninstall();
    (spy.target as unknown as Console).info("after uninstall");
    assert.deepEqual(spy.printed, [["after uninstall"]]);
  });
});

describe("message references", () => {
  it("is a per-boot hash, not the id", () => {
    const id = "3EB0C767D82F1B4A5D21";
    const ref = messageRef(id);
    assert.ok(ref);
    assert.notEqual(ref, id);
    assert.equal(ref!.length, 12);
    assert.equal(messageRef(id), ref, "the same id correlates across lines in one run");
    assert.notEqual(messageRef("3EB0C767D82F1B4A5D22"), ref);
  });

  it("refuses anything that is not id-shaped", () => {
    // A JID or a phone number turning up in an id position is a shape this must
    // not quietly accept and hash as though it were a message id.
    assert.equal(messageRef(SENTINELS.jid), null);
    assert.equal(messageRef(SENTINELS.lid), null);
    assert.equal(messageRef(SENTINELS.phone), null);
    assert.equal(messageRef(""), null);
    assert.equal(messageRef(null), null);
    assert.equal(messageRef(undefined), null);
    assert.equal(messageRef({ id: "x" }), null);
    assert.equal(messageRef("x".repeat(65)), null);
  });
});

describe("translating Baileys' own logging", () => {
  /**
   * The exact strings `baileys@6.7.24` logs, pinned so an upgrade that reworded
   * one is caught here rather than by a silently missing log line in production.
   * Sources: `Socket/messages-recv.js` (handleReceipt, sendMessagesAgain) and
   * `Socket/messages-send.js` (assertSessions, relayMessage).
   */
  const CASES: Array<[string, string]> = [
    ["recv retry request", "retry_receipt_received"],
    ["recv retry for not fromMe message", "retry_receipt_not_for_us"],
    ["will not send message again, as sent too many times", "retry_limit_reached"],
    ["forced new session for retry recp", "retry_forced_new_session"],
    ["recv retry request, but message not available", "retry_message_unavailable"],
    ["error in sending message again", "retry_relay_failed"],
    ["sent retry receipt", "inbound_retry_receipt_sent"],
    ["fetching sessions", "signal_sessions_fetched"],
    ["sending message to 2 devices", "relay_stanza_sent"],
  ];

  it("recognises every step of the retry exchange", () => {
    for (const [message, event] of CASES) {
      const translated = translateBaileysLog({}, message);
      assert.equal(translated?.event, event, `"${message}" should translate to ${event}`);
    }
  });

  it("recognises the same steps when Baileys logs them with no bindings", () => {
    // `logger.info('text')` rather than `logger.info(obj, 'text')`. There is no
    // id to reference in that form, and the event must still be reported.
    for (const [message, event] of CASES) {
      const translated = translateBaileysLog(message, undefined);
      assert.equal(translated?.event, event);
      assert.equal(translated?.messageRef, null);
    }
  });

  it("keeps only the message id, and only as a reference", () => {
    // The real bound object from handleReceipt: `logger.debug({ attrs, key }, ...)`,
    // where both halves are made of JIDs.
    const translated = translateBaileysLog(
      {
        attrs: { id: "3EB0C767D82F1B4A5D21", from: SENTINELS.jid, type: "retry", t: "1700000000" },
        key: { remoteJid: SENTINELS.lid, participant: SENTINELS.jid, fromMe: true, id: "" },
      },
      "recv retry request",
    );
    assert.equal(translated?.event, "retry_receipt_received");
    assert.equal(translated?.messageRef, messageRef("3EB0C767D82F1B4A5D21"));
    assert.deepEqual(Object.keys(translated!).sort(), ["event", "level", "messageRef"]);
    assertNothingPrivate(translated, "the Baileys log translator");
  });

  it("reads the id from wherever the particular call site binds it", () => {
    const id = "3EB0C767D82F1B4A5D21";
    assert.equal(
      translateBaileysLog({ jid: SENTINELS.jid, id }, "recv retry request, but message not available")
        ?.messageRef,
      messageRef(id),
    );
    assert.equal(
      translateBaileysLog({ msgId: id }, "sending message to 1 devices")?.messageRef,
      messageRef(id),
    );
    assert.equal(
      translateBaileysLog(
        { key: { remoteJid: SENTINELS.jid }, ids: [id], trace: `at relay (${SENTINELS.jid})` },
        "error in sending message again",
      )?.messageRef,
      messageRef(id),
    );
  });

  it("drops everything it does not recognise", () => {
    // The frame dumps, session fetches and receipt traffic that make up the bulk
    // of Baileys' logging, none of which may reach the worker's output.
    const noisy: Array<[unknown, string]> = [
      [{ xml: `<message to="${SENTINELS.jid}">${SENTINELS.body}</message>` }, "recv xml"],
      [{ unhandled: true, frame: { attrs: { from: SENTINELS.jid } } }, "communication recv"],
      [{ jidsRequiringFetch: [SENTINELS.jid] }, "fetching sessions "],
      [{ session: sessionEntry() }, "closing open session"],
      [{ jid: SENTINELS.jid }, "adding device identity"],
      [{ err: new Error(SENTINELS.privKey) }, "unexpected error in 'handleReceipt'"],
      [{ trace: SENTINELS.privKey }, "connection already closed"],
      [sessionEntry(), "recv retry request extended"],
    ];
    for (const [bound, message] of noisy) {
      assert.equal(
        translateBaileysLog(bound, message),
        null,
        `"${message}" must not be translated into worker output`,
      );
    }
    assert.equal(translateBaileysLog({}, undefined), null);
  });

  it("reports a level Baileys will not serialise whole frames for", () => {
    // Socket/socket.js builds `binaryNodeToString(frame)` — the entire stanza,
    // JIDs and ciphertext included — when the logger says it is at trace or
    // debug. It never needs to do that work here.
    const socketLogger = createSocketLogger(CLINIC_A, () => {});
    assert.notEqual(socketLogger.level, "trace");
    assert.notEqual(socketLogger.level, "debug");
    // Baileys binds a class onto its child loggers; the bindings are discarded.
    assert.equal(socketLogger.child({ class: "baileys" }).level, socketLogger.level);
  });

  it("emits the clinic and nothing else it was not asked for", () => {
    const records: Parameters<DiagnosticSink>[0][] = [];
    const socketLogger = createSocketLogger(CLINIC_A, (record) => records.push(record));
    socketLogger.debug(
      { attrs: { id: "3EB0C767D82F1B4A5D21", from: SENTINELS.jid }, key: { fromMe: true } },
      "recv retry request",
    );
    socketLogger.child({ class: "ns" }).debug({ xml: SENTINELS.body }, "recv xml");
    assert.deepEqual(
      records.map((r) => r.event),
      ["retry_receipt_received"],
    );
    assert.equal(records[0]!.clinicId, CLINIC_A);
    assertNothingPrivate(records, "the socket logger");
  });
});

describe("the getMessage hook", () => {
  it("logs a hit or a miss, and reads nothing but the id", async () => {
    const cache = new SentMessageCache();
    cache.remember("3EB0C767D82F1B4A5D21", { conversation: SENTINELS.body });
    const records: Parameters<DiagnosticSink>[0][] = [];
    const getMessage = createGetMessage(CLINIC_A, cache, (record) => records.push(record));

    // Baileys calls this with the whole receipt-derived key.
    const hit = await getMessage({
      id: "3EB0C767D82F1B4A5D21",
      remoteJid: SENTINELS.lid,
      participant: SENTINELS.jid,
      fromMe: true,
    } as { id?: string | null });
    assert.deepEqual(hit, { conversation: SENTINELS.body });

    const miss = await getMessage({ id: "3EB0C767D82F1B4A5D99" });
    assert.equal(miss, undefined);

    assert.deepEqual(
      records.map((r) => r.event),
      ["retry_cache_hit", "retry_cache_miss"],
    );
    assert.equal(records[0]!.messageRef, messageRef("3EB0C767D82F1B4A5D21"));
    assert.equal(records[0]!.cacheSize, 1);
    assertNothingPrivate(records, "the getMessage hook");
  });

  it("survives a key with no id at all", async () => {
    const records: Parameters<DiagnosticSink>[0][] = [];
    const getMessage = createGetMessage(CLINIC_A, new SentMessageCache(), (r) => records.push(r));
    assert.equal(await getMessage({}), undefined);
    assert.equal(await getMessage({ id: null }), undefined);
    assert.deepEqual(
      records.map((r) => r.event),
      ["retry_cache_miss", "retry_cache_miss"],
    );
  });
});

/**
 * The composition, not the pieces: the id `send()` reports to ClinicFlow must be
 * the id the socket's own `getMessage` hook resolves. These are wired together
 * only inside `connectToWhatsApp`, so the test rebuilds exactly that wiring
 * (`createGetMessage(clinicId, sent)`) over the cache the manager handed the
 * factory, which is the object production closes over.
 */
describe("the id round trip", () => {
  async function connected() {
    const store = new FakeStore("worker-under-test");
    const config = testConfig({ workerId: store.workerId });
    const socket = fakeSocket("201111111111:7@s.whatsapp.net", { ownLid: "555000111222@lid" });
    const handed: Array<{ sent: SentMessageCache; clinicId: string }> = [];
    const manager = new SessionManager(config, store.asStore(), async (_auth, sent, clinicId) => {
      handed.push({ sent, clinicId });
      return socket;
    });
    await manager.start(CLINIC_A);
    await waitFor(() => manager.clinicIds().includes(CLINIC_A), "the socket");
    socket.emit("connection.update", { connection: "open" });
    await waitFor(() => store.row(CLINIC_A)?.status === "connected", "the session");
    return { manager, socket, store, handed };
  }

  it("resolves the plaintext for exactly the id the send reported", async () => {
    const { manager, handed } = await connected();
    const outcome = await manager.send(CLINIC_A, "+20100000000", SENTINELS.body);
    assert.equal(outcome.ok, true);
    const providerMessageId = outcome.ok ? outcome.providerMessageId : null;
    assert.ok(providerMessageId);

    assert.equal(handed.length, 1);
    assert.equal(handed[0]!.clinicId, CLINIC_A, "the factory is told which clinic it is opening");

    // The production hook, over the production cache, asked for the production id.
    const getMessage = createGetMessage(handed[0]!.clinicId, handed[0]!.sent, () => {});
    assert.deepEqual(await getMessage({ id: providerMessageId! }), {
      conversation: SENTINELS.body,
    });
    await manager.shutdown();
  });

  /**
   * A retry receipt can arrive after the recipient's phone has already
   * acknowledged the stanza — "delivered" and "undecryptable" are not exclusive.
   * So neither the outbound echo of our own message nor a delivery/read status
   * update may retire the plaintext: doing so would evict the entry in the
   * seconds before the retry that needs it.
   */
  it("keeps the plaintext through the echo and the status updates for the same message", async () => {
    const { manager, socket, handed } = await connected();
    const outcome = await manager.send(CLINIC_A, "+20100000000", SENTINELS.body);
    const providerMessageId = outcome.ok ? outcome.providerMessageId! : "";
    const cache = handed[0]!.sent;
    assert.equal(cache.size, 1);

    // WhatsApp echoes our own send back as a `fromMe` message...
    socket.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: providerMessageId, fromMe: true, remoteJid: "20100000000@s.whatsapp.net" },
          message: { conversation: SENTINELS.body },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    // ...and then reports it sent, delivered and read.
    for (const status of [2, 3, 4]) {
      socket.emit("messages.update", [
        { key: { id: providerMessageId, fromMe: true }, update: { status } },
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(cache.size, 1, "nothing on the acknowledgement path retires the plaintext");
    const getMessage = createGetMessage(CLINIC_A, cache, () => {});
    assert.deepEqual(await getMessage({ id: providerMessageId }), {
      conversation: SENTINELS.body,
    });
    await manager.shutdown();
  });
});
