import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WAMessage } from "baileys";
import { connectedSession, postedEvents, waitFor } from "./harness.ts";

/**
 * P15 §4 — a stranger's first message must reach the inbox.
 *
 * ### The failure this suite exists to prevent
 *
 * WhatsApp addresses an increasing share of chats by LID (`<opaque>@lid`)
 * rather than by phone number, and the number behind a LID reaches us only when
 * WhatsApp chooses to assert it: the `sender_pn` attribute on a message stanza,
 * a `chats.phoneNumberShare` event, or a contact record carrying both
 * spellings.
 *
 * For somebody the clinic has already spoken to, one of those has always
 * happened by the time they write again, and the session's directory answers.
 * For somebody writing to the clinic for the *first* time there is, by
 * definition, no earlier assertion — so a first stanza that happens to omit
 * `sender_pn` had nothing to resolve against. The worker decrypted it,
 * acknowledged it to WhatsApp, logged `unresolved_counterparty`, and discarded
 * it. No message row, no conversation, no assistant, nothing for staff to see:
 * a stranger messages the clinic and ClinicFlow behaves as though they never
 * did. Being a patient was never a prerequisite for a reply, and this was not a
 * decision about patients at all — the message was gone before anything could
 * ask.
 *
 * ### What the fix is, and what it deliberately is not
 *
 * Nothing here guesses. A LID's digits are still never published as a phone
 * number, and a message is still never attributed to a number WhatsApp has not
 * asserted — guessing is how one patient's message ends up in another's thread.
 * The message *waits*, in memory, bounded in count and in time, and is replayed
 * through the ordinary pipeline the moment any of the existing assertion
 * channels names its sender.
 */

const PATIENT_PN = "20100000000@s.whatsapp.net";
const PATIENT_LID = "182736450192837@lid";
const OTHER_LID = "999888777666555@lid";

function textMessage(
  key: Partial<WAMessage["key"]>,
  text = "hello, do you treat children?",
  timestamp = Math.floor(Date.now() / 1000),
): WAMessage {
  return {
    key: { id: "3EB0P15AAA", fromMe: false, ...key },
    message: { conversation: text },
    messageTimestamp: timestamp,
  } as WAMessage;
}

describe("P15 §4 — a live inbound whose sender is not yet named", () => {
  it("is not discarded, and is carried once a later stanza asserts the number", async () => {
    const session = await connectedSession();
    try {
      // The reproduction: a first message from a stranger, on a LID chat, with
      // no `sender_pn` on the stanza and nothing in the directory.
      await session.upsert({
        type: "notify",
        messages: [textMessage({ remoteJid: PATIENT_LID })],
      });
      assert.deepEqual(
        postedEvents(session.posted).filter((event) => event.kind === "inbound"),
        [],
        "nothing can be attributed yet, so nothing is posted yet",
      );

      // Their next message carries the assertion WhatsApp withheld from the
      // first one. Both must now arrive.
      await session.upsert({
        type: "notify",
        messages: [
          textMessage(
            { id: "3EB0P15BBB", remoteJid: PATIENT_LID, senderPn: PATIENT_PN },
            "anyone there?",
          ),
        ],
      });

      const inbound = postedEvents(session.posted).filter(
        (event) => event.kind === "inbound",
      );
      assert.equal(inbound.length, 2, "the parked message and the new one");
      // In the order they were written, not the order their identities resolved.
      assert.equal(inbound[0]!.body, "hello, do you treat children?");
      assert.equal(inbound[1]!.body, "anyone there?");
      for (const event of inbound) {
        assert.equal(event.sender, "+20100000000");
        // Live, never historical: a parked message is a live message that
        // waited, and flagging it as history would suppress the assistant, the
        // staff notification and the service window all at once.
        assert.equal(event.historical, undefined);
      }
    } finally {
      session.restore();
    }
  });

  it("is carried when the assertion arrives out of band, with no further message", async () => {
    const session = await connectedSession();
    try {
      await session.upsert({
        type: "notify",
        messages: [textMessage({ remoteJid: PATIENT_LID })],
      });
      assert.deepEqual(
        postedEvents(session.posted).filter((event) => event.kind === "inbound"),
        [],
      );

      // `chats.phoneNumberShare` is one of the two assertions that does not
      // ride on a message. The parked message must not sit there waiting for
      // traffic that may never come.
      session.socket.emit("chats.phoneNumberShare", {
        lid: PATIENT_LID,
        jid: PATIENT_PN,
      });

      await waitFor(
        () => postedEvents(session.posted).some((event) => event.kind === "inbound"),
        "the parked message to be carried after the out-of-band assertion",
      );
      const inbound = postedEvents(session.posted).filter(
        (event) => event.kind === "inbound",
      );
      assert.equal(inbound.length, 1);
      assert.equal(inbound[0]!.sender, "+20100000000");
      assert.equal(inbound[0]!.body, "hello, do you treat children?");
    } finally {
      session.restore();
    }
  });

  it("never attributes a parked message to a different contact's assertion", async () => {
    const session = await connectedSession();
    try {
      await session.upsert({
        type: "notify",
        messages: [textMessage({ remoteJid: PATIENT_LID })],
      });
      // Somebody else's LID is resolved. The parked message belongs to a
      // different chat and must stay parked rather than being filed against
      // the number that happened to arrive.
      session.socket.emit("chats.phoneNumberShare", {
        lid: OTHER_LID,
        jid: "20999999999@s.whatsapp.net",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(
        postedEvents(session.posted).filter((event) => event.kind === "inbound"),
        [],
      );
    } finally {
      session.restore();
    }
  });

  it("parks a message once however many times it is redelivered", async () => {
    const session = await connectedSession();
    try {
      const duplicate = textMessage({ remoteJid: PATIENT_LID });
      await session.upsert({ type: "notify", messages: [duplicate] });
      await session.upsert({ type: "notify", messages: [duplicate] });
      session.socket.emit("chats.phoneNumberShare", {
        lid: PATIENT_LID,
        jid: PATIENT_PN,
      });
      await waitFor(
        () => postedEvents(session.posted).some((event) => event.kind === "inbound"),
        "the parked message to be carried",
      );
      assert.equal(
        postedEvents(session.posted).filter((event) => event.kind === "inbound").length,
        1,
        "one message in, one message out",
      );
    } finally {
      session.restore();
    }
  });

  it("does not park an offline flush, which has its own path", async () => {
    const session = await connectedSession();
    try {
      // `append` is a queue WhatsApp flushed, not live traffic. Its identities
      // are reconciled by the history/pending machinery, which is durable;
      // duplicating that in an in-memory buffer would be a second answer to one
      // question.
      await session.upsert({
        type: "append",
        messages: [textMessage({ remoteJid: PATIENT_LID })],
      });
      session.socket.emit("chats.phoneNumberShare", {
        lid: PATIENT_LID,
        jid: PATIENT_PN,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(
        postedEvents(session.posted).filter((event) => event.kind === "inbound"),
        [],
      );
    } finally {
      session.restore();
    }
  });
});
