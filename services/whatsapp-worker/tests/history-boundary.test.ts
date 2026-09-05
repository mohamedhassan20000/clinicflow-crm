import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretHistoryBatch } from "../src/history.ts";
import { LidDirectory, NameDirectory } from "../src/jids.ts";
import { connectedSession, postedEvents } from "./harness.ts";

const PATIENT = "201222222222@s.whatsapp.net";

function message(at: string, id: string) {
  return {
    key: { remoteJid: PATIENT, id, fromMe: false },
    messageTimestamp: Math.floor(Date.parse(at) / 1000),
    pushName: "WhatsApp Name",
    message: { conversation: "hello" },
  } as never;
}

describe("linked-device Inbox boundary", () => {
  it("sets the durable epoch once and never moves it on a later connection", async () => {
    const session = await connectedSession({
      inboundActiveFrom: "2026-07-01T00:00:00.000Z",
    });
    try {
      const later = await session.store.ensureInboundActiveFrom(
        "11111111-1111-4111-8111-111111111111",
        "2026-08-01T00:00:00.000Z",
      );
      assert.equal(later, "2026-07-01T00:00:00.000Z");
      assert.equal(
        session.store.row("11111111-1111-4111-8111-111111111111")?.inbound_active_from,
        "2026-07-01T00:00:00.000Z",
      );
    } finally {
      session.restore();
    }
  });

  it("learns identities and names while suppressing pre-boundary chats and messages", () => {
    const result = interpretHistoryBatch({
      batch: {
        chats: [{
          id: PATIENT,
          name: "Saved Name",
          conversationTimestamp: Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000),
        }],
        contacts: [{ id: PATIENT, jid: PATIENT, name: "Saved Name" }],
        messages: [message("2026-06-01T10:00:00Z", "OLD-1")],
      } as never,
      directory: new LidDirectory(),
      names: new NameDirectory(),
      inboundActiveFrom: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(result.chats, 0);
    assert.equal(result.messages, 0);
    assert.deepEqual(
      result.events.filter((event) =>
        event.kind === "history_chat" || event.kind === "inbound" || event.kind === "outbound_echo"),
      [],
    );
  });

  it("admits post-boundary history and never promotes missing timestamps to now", () => {
    const result = interpretHistoryBatch({
      batch: {
        chats: [],
        contacts: [],
        messages: [
          message("2026-07-02T10:00:00Z", "NEW-1"),
          {
            key: { remoteJid: PATIENT, id: "NO-TIME", fromMe: false },
            messageTimestamp: undefined,
            message: { conversation: "hello" },
          } as never,
        ],
      } as never,
      directory: new LidDirectory(),
      names: new NameDirectory(),
      inboundActiveFrom: "2026-07-01T00:00:00.000Z",
      now: Date.parse("2026-08-01T00:00:00Z"),
    });
    assert.equal(result.messages, 1);
    assert.equal(result.events.filter((event) => event.kind === "inbound").length, 1);
  });

  it("applies the durable boundary before the history spool", async () => {
    const session = await connectedSession({
      inboundActiveFrom: "2026-07-01T00:00:00.000Z",
    });
    try {
      await session.history({
        chats: [{
          id: PATIENT,
          name: "Saved Name",
          conversationTimestamp: Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000),
        }],
        contacts: [{ id: PATIENT, jid: PATIENT, name: "Saved Name" }],
        messages: [message("2026-06-01T10:00:00Z", "OLD-SPOOL")],
        isLatest: true,
      });
      const events = postedEvents(session.posted);
      assert.equal(events.some((event) => event.kind === "history_chat"), false);
      assert.equal(events.some((event) => event.kind === "inbound"), false);
      assert.equal(session.store.row("11111111-1111-4111-8111-111111111111")?.inbound_active_from,
        "2026-07-01T00:00:00.000Z");
    } finally {
      session.restore();
    }
  });
});
