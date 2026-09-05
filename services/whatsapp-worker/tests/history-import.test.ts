import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretHistoryBatch } from "../src/history.ts";
import { LidDirectory, NameDirectory } from "../src/jids.ts";
import { CLINIC_A, connectedSession, postedEvents, waitFor } from "./harness.ts";

/**
 * P8 §1 — importing the chats a phone hands its new linked device.
 *
 * What the platform actually provides, and what it does not, is set out in
 * `src/history.ts`. These tests pin the part that is ours: which chats are
 * carried, which are refused, what a message keeps, and the fact that running the
 * import twice is not a way to get two copies of a conversation.
 */

const PATIENT_PN = "201111111111@s.whatsapp.net";
const OTHER_PN = "201222222222@s.whatsapp.net";
const PATIENT_LID = "998877665544332@lid";
const GROUP = "120363000000000000@g.us";
const STATUS = "status@broadcast";
const BROADCAST = "123456789@broadcast";
const NEWSLETTER = "120363111111111111@newsletter";
const META_AI = "13135550002@c.us";

function historyMessage(
  remoteJid: string,
  options: {
    id?: string;
    fromMe?: boolean;
    text?: string;
    at?: number;
    pushName?: string;
    senderPn?: string;
    media?: Record<string, unknown>;
  } = {},
) {
  return {
    key: {
      remoteJid,
      id: options.id ?? "HIST-1",
      fromMe: options.fromMe ?? false,
      ...(options.senderPn ? { senderPn: options.senderPn } : {}),
    },
    messageTimestamp: options.at ?? Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000),
    ...(options.pushName ? { pushName: options.pushName } : {}),
    message: options.media ?? { conversation: options.text ?? "مساء الخير" },
  } as never;
}

function interpret(batch: Record<string, unknown>, now = Date.parse("2026-08-17T09:00:00Z")) {
  return interpretHistoryBatch({
    batch: { chats: [], contacts: [], messages: [], ...batch } as never,
    directory: new LidDirectory(),
    names: new NameDirectory(),
    now,
  });
}

function persistedEvents(result: ReturnType<typeof interpret>) {
  return result.events.filter((event) => event.kind !== "history_metrics");
}

describe("history import — which chats are carried", () => {
  it("opens a thread for each one-to-one chat", () => {
    const result = interpret({
      chats: [{ id: PATIENT_PN, name: "Fatima Ahmed", conversationTimestamp: 1_780_000_000 }],
    });
    assert.equal(result.chats, 1);
    assert.deepEqual(persistedEvents(result), [
      {
        kind: "history_chat",
        participant: "+201111111111",
        displayName: "Fatima Ahmed",
        lastMessageAt: new Date(1_780_000_000_000).toISOString(),
      },
    ]);
  });

  it("refuses groups, status, broadcasts, newsletters and Meta AI", () => {
    const result = interpret({
      chats: [
        { id: GROUP, name: "Clinic staff" },
        { id: STATUS },
        { id: BROADCAST },
        { id: NEWSLETTER },
        { id: META_AI },
      ],
    });
    assert.equal(result.chats, 0);
    assert.equal(result.skippedChats, 5);
    assert.deepEqual(persistedEvents(result), []);
  });

  it("leaves out a LID chat whose number WhatsApp has never asserted", () => {
    // The digits of a LID are an opaque server identifier. Publishing them as a
    // phone number would file a stranger's conversation under someone else's.
    const result = interpret({ chats: [{ id: PATIENT_LID, name: "Unknown" }] });
    assert.equal(result.chats, 0);
    assert.equal(result.unresolvedChats, 1);
  });

  it("carries a LID chat once the mapping has been asserted", () => {
    const directory = new LidDirectory();
    const result = interpretHistoryBatch({
      batch: {
        chats: [{ id: PATIENT_LID, name: "Fatima" }],
        contacts: [{ id: PATIENT_LID, lid: PATIENT_LID, jid: PATIENT_PN, name: "Fatima" }],
        messages: [],
      } as never,
      directory,
      names: new NameDirectory(),
    });
    assert.equal(result.chats, 1);
    assert.equal(
      (result.events[0] as { participant: string }).participant,
      "+201111111111",
    );
  });

  it("uses the PN/LID pair carried directly on a history Conversation", () => {
    const result = interpret({
      chats: [{ id: PATIENT_LID, pnJid: PATIENT_PN, name: "Fatima" }],
      messages: [historyMessage(PATIENT_LID, { id: "LID-HISTORY-1" })],
    });
    assert.equal(result.messages, 1);
    assert.equal(result.pendingMessages, 0);
    assert.ok(result.events.some((event) => event.kind === "history_identity"));
    assert.ok(result.events.some((event) => event.kind === "inbound"));
  });

  it("spools an unresolved LID chat and message instead of dropping either", () => {
    const result = interpret({
      chats: [{ id: PATIENT_LID, name: "Fatima" }],
      messages: [historyMessage(PATIENT_LID, { id: "LID-PENDING-1" })],
    });
    assert.equal(result.unresolvedChats, 1);
    assert.equal(result.pendingMessages, 1);
    assert.ok(result.events.some((event) => event.kind === "history_pending_chat"));
    assert.ok(result.events.some((event) =>
      event.kind === "history_pending_message" &&
      event.providerMessageId === "LID-PENDING-1"));
  });

  it("does not impose an application-side age cutoff on history WhatsApp supplied", () => {
    const result = interpretHistoryBatch({
      batch: {
        chats: [{ id: PATIENT_PN, conversationTimestamp: Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000) }],
        contacts: [],
        messages: [],
      } as never,
      directory: new LidDirectory(),
      names: new NameDirectory(),
      now: Date.parse("2026-08-17T09:00:00Z"),
    });
    assert.equal(result.chats, 1);
    assert.ok(result.events.some((event) => event.kind === "history_chat"));
  });
});

describe("history import — names", () => {
  it("prefers the name the clinic saved over the one the contact publishes", () => {
    const result = interpret({
      chats: [{ id: PATIENT_PN, name: "Fatima (patient)" }],
      contacts: [{ id: PATIENT_PN, jid: PATIENT_PN, notify: "fofa" }],
    });
    assert.equal((result.events[0] as { displayName: string }).displayName, "Fatima (patient)");
  });

  it("falls back to the contact's own published name", () => {
    const result = interpret({
      chats: [{ id: PATIENT_PN }],
      contacts: [{ id: PATIENT_PN, jid: PATIENT_PN, notify: "Fatima A." }],
    });
    assert.equal((result.events[0] as { displayName: string }).displayName, "Fatima A.");
  });

  it("reports no name rather than inventing one", () => {
    const result = interpret({ chats: [{ id: PATIENT_PN }] });
    assert.equal((result.events[0] as { displayName: string | null }).displayName, null);
  });
});

describe("history import — messages", () => {
  it("carries both directions with their original timestamps", () => {
    const at = Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000);
    const result = interpret({
      chats: [{ id: PATIENT_PN, name: "Fatima" }],
      messages: [
        historyMessage(PATIENT_PN, { id: "IN-1", text: "عندكم موعد بكرا؟", at }),
        historyMessage(PATIENT_PN, { id: "OUT-1", fromMe: true, text: "أهلا بحضرتك", at: at + 60 }),
      ],
    });
    assert.equal(result.messages, 2);
    const messages = result.events.filter(
      (event) => event.kind === "inbound" || event.kind === "outbound_echo",
    );
    assert.deepEqual(
      messages.map((event) => event.kind),
      ["inbound", "outbound_echo"],
    );
    assert.equal(
      (messages[0] as { receivedAt: string }).receivedAt,
      new Date(at * 1000).toISOString(),
    );
    assert.equal((messages[0] as { historical: boolean }).historical, true);
    assert.equal((messages[1] as { historical: boolean }).historical, true);
  });

  it("opens a thread for a chat only the messages mentioned", () => {
    // The chat list and the message list do not always agree; a message must
    // never arrive for a conversation that was never opened.
    const result = interpret({
      messages: [historyMessage(OTHER_PN, { id: "IN-2", pushName: "Mohamed" })],
    });
    assert.equal(result.events[0]?.kind, "history_chat");
    assert.equal((result.events[0] as { participant: string }).participant, "+201222222222");
    assert.equal((result.events[0] as { displayName: string }).displayName, "Mohamed");
  });

  it("does not apply the offline-flush staleness bound to history", () => {
    // Every history message is old by construction. The seven-day guard that
    // protects the live path would discard the entire import.
    const at = Math.floor(Date.parse("2026-02-01T10:00:00Z") / 1000);
    const result = interpret({
      chats: [{ id: PATIENT_PN }],
      messages: [historyMessage(PATIENT_PN, { id: "OLD-1", at })],
    });
    assert.equal(result.messages, 1);
  });

  it("normalizes historical PTT metadata through the same audio classifier", () => {
    const result = interpret({
      chats: [{ id: PATIENT_PN }],
      messages: [historyMessage(PATIENT_PN, {
        id: "VOICE-HISTORY-1",
        media: {
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
            seconds: 23,
          },
        },
      })],
    });
    const event = result.events.find(
      (item) => item.kind === "inbound" && item.providerMessageId === "VOICE-HISTORY-1",
    );
    assert.equal(event?.kind, "inbound");
    assert.equal(event?.kind === "inbound" && event.body, "[voice message]");
    assert.deepEqual(event?.kind === "inbound" && event.attachments?.[0], {
      mediaKind: "audio",
      voiceNote: true,
      durationSeconds: 23,
      mimeType: "audio/ogg; codecs=opus",
      originalFilename: null,
      byteSize: 0,
      sha256: null,
      storagePath: null,
      status: "rejected",
      failureReason: "historical_media_unavailable",
    });
  });

  it("refuses group messages even when the chat list did not mention the group", () => {
    const result = interpret({ messages: [historyMessage(GROUP, { id: "G-1" })] });
    assert.equal(result.messages, 0);
    assert.deepEqual(persistedEvents(result), []);
  });

  it("orders chats ahead of messages, oldest message first", () => {
    const base = Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000);
    const result = interpret({
      chats: [{ id: PATIENT_PN }],
      messages: [
        historyMessage(PATIENT_PN, { id: "B", at: base + 600 }),
        historyMessage(PATIENT_PN, { id: "A", at: base }),
      ],
    });
    assert.equal(result.events[0]?.kind, "history_chat");
    assert.deepEqual(
      result.events
        .filter((event) => event.kind === "inbound" || event.kind === "outbound_echo")
        .map((event) => event.providerMessageId),
      ["A", "B"],
    );
  });
});

describe("history import — on a live session", () => {
  it("posts the import and reports completion, and a replay adds no new threads", async () => {
    const session = await connectedSession();
    try {
      const at = Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000);
      const batch = {
        chats: [{ id: PATIENT_PN, name: "Fatima Ahmed", conversationTimestamp: at }],
        contacts: [{ id: PATIENT_PN, jid: PATIENT_PN, name: "Fatima Ahmed" }],
        messages: [historyMessage(PATIENT_PN, { id: "HIST-A", at })],
        isLatest: true,
      };
      await session.history(batch);
      await waitFor(
        () => session.store.row(CLINIC_A)?.history_status === "complete",
        "the import to complete",
      );

      const events = postedEvents(session.posted);
      const chats = events.filter((event) => event.kind === "history_chat");
      const messages = events.filter((event) => event.kind === "inbound");
      assert.equal(chats.length, 1);
      assert.equal(chats[0]?.displayName, "Fatima Ahmed");
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.historical, true);
      // The provider message id is what the application dedupes on, so it has to
      // survive the trip.
      assert.equal(messages[0]?.providerMessageId, "HIST-A");
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 1);
      assert.equal(session.store.row(CLINIC_A)?.history_messages_imported, 1);

      // A reconnect that receives the same sync again produces the same batch
      // key, so the durable spool recognises it and nothing is posted twice.
      // (Before the spool the worker re-posted the whole sync and relied purely
      // on the application's unique index to absorb it.) The ids are unchanged
      // either way, which is the contract the application dedupes on.
      const before = postedEvents(session.posted).length;
      await session.history(batch);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(postedEvents(session.posted).length, before);
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 1);
      assert.equal(session.store.row(CLINIC_A)?.history_messages_imported, 1);
    } finally {
      session.restore();
    }
  });

  it("reports an import the phone sent nothing for as unavailable", async () => {
    const session = await connectedSession();
    try {
      await session.history({ chats: [], contacts: [], messages: [], isLatest: true });
      await waitFor(
        () => session.store.row(CLINIC_A)?.history_status === "unavailable",
        "the import to report unavailable",
      );
      // Nothing is fabricated: no chats, no messages, and an honest status.
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 0);
    } finally {
      session.restore();
    }
  });

  it("keeps carrying live messages during and after a history sync", async () => {
    const session = await connectedSession();
    try {
      await session.history({
        chats: [{ id: PATIENT_PN, name: "Fatima" }],
        contacts: [],
        messages: [historyMessage(PATIENT_PN, { id: "HIST-B" })],
        isLatest: false,
      });
      await session.upsert({
        type: "notify",
        messages: [historyMessage(PATIENT_PN, { id: "LIVE-1", text: "انا في الطريق" })],
      });
      const live = postedEvents(session.posted).filter(
        (event) => event.kind === "inbound" && event.providerMessageId === "LIVE-1",
      );
      assert.equal(live.length, 1);
      // A live message is not marked historical, so it still notifies staff and
      // still reaches the patient agent.
      assert.equal(live[0]?.historical, undefined);
    } finally {
      session.restore();
    }
  });
});
