import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WAMessage } from "baileys";
import { interpretMessage, messageText } from "../src/inbound.ts";
import { classifyJid, LidDirectory, phoneFromJid } from "../src/jids.ts";
import { connectedSession, postedEvents } from "./harness.ts";

/**
 * The bug this suite exists to prevent: a paired device that reached "connected"
 * and then carried nothing into the inbox.
 *
 * Two independent causes, both of which silently discarded real patient messages
 * after WhatsApp had already been told they were delivered:
 *
 *   1. the direct-chat filter was `jid.endsWith("@s.whatsapp.net")`, which drops
 *      every chat WhatsApp has migrated to LID addressing (`<opaque>@lid`), and
 *   2. only upsert type `notify` was carried, so every message WhatsApp had queued
 *      for an offline device and flushed on the handshake — type `append` — was
 *      thrown away. That is precisely the traffic a redeploy produces.
 *
 * The other half of the suite is what must *not* change while fixing that: groups,
 * status updates, broadcasts, newsletters and Meta AI are not patient
 * conversations, a LID's own digits are never published as a phone number, and the
 * clinic's own messages stay outbound echoes rather than becoming inbound ones.
 */

const PATIENT_PN = "20100000000@s.whatsapp.net";
const PATIENT_LID = "182736450192837@lid";
const SESSION_PN = "201111111111@s.whatsapp.net";

function textMessage(
  key: Partial<WAMessage["key"]>,
  text = "hello",
  timestamp = Math.floor(Date.now() / 1000),
): WAMessage {
  return {
    key: { id: "3EB0ABCDEF", fromMe: false, ...key },
    message: { conversation: text },
    messageTimestamp: timestamp,
  } as WAMessage;
}

function interpret(message: WAMessage, options: { type?: string; directory?: LidDirectory } = {}) {
  return interpretMessage({
    upsertType: options.type ?? "notify",
    message,
    directory: options.directory ?? new LidDirectory(),
  });
}

describe("JID classification", () => {
  it("recognizes both spellings of a one-to-one chat", () => {
    assert.equal(classifyJid(PATIENT_PN), "pn");
    assert.equal(classifyJid("20100000000:14@s.whatsapp.net"), "pn");
    // The legacy spelling normalizes onto s.whatsapp.net.
    assert.equal(classifyJid("20100000000@c.us"), "pn");
    assert.equal(classifyJid(PATIENT_LID), "lid");
    assert.equal(classifyJid("182736450192837:3@lid"), "lid");
  });

  it("keeps every non-direct address space out of the patient path", () => {
    assert.equal(classifyJid("123456789-1600000000@g.us"), "group");
    assert.equal(classifyJid("status@broadcast"), "status");
    assert.equal(classifyJid("1600000000@broadcast"), "broadcast");
    assert.equal(classifyJid("120363000000000000@newsletter"), "newsletter");
    // Meta AI wears an ordinary-looking user JID; it is still not a patient.
    assert.equal(classifyJid("13135550002@c.us"), "bot");
    assert.equal(classifyJid("someone@bot"), "bot");
    assert.equal(classifyJid(""), "unknown");
    assert.equal(classifyJid(null), "unknown");
  });

  it("never reads a phone number out of a LID", () => {
    assert.equal(phoneFromJid(PATIENT_PN), "+20100000000");
    assert.equal(phoneFromJid("20100000000:14@s.whatsapp.net"), "+20100000000");
    // The digits of a LID are an opaque server identifier. Publishing them as a
    // phone number would file a patient's message against a stranger.
    assert.equal(phoneFromJid(PATIENT_LID), null);
    assert.equal(phoneFromJid("182736450192837@lid"), null);
  });
});

describe("direct messages on a phone-number JID", () => {
  it("is carried into the inbox as inbound", () => {
    const result = interpret(textMessage({ remoteJid: PATIENT_PN }, "my tooth hurts"));
    assert.deepEqual(result, {
      outcome: "event",
      event: {
        kind: "inbound",
        providerMessageId: "3EB0ABCDEF",
        sender: "+20100000000",
        body: "my tooth hurts",
        receivedAt: (result as { event: { receivedAt: string } }).event.receivedAt,
      },
      // Carried messages report the same shape-only diagnostic as dropped ones.
      // `chat_jid` is the whole answer to "why is there no LID for this
      // contact": the conversation is being held in the phone-number address
      // space, so WhatsApp has never asserted one and none exists to find.
      diagnostic: {
        upsertType: "notify",
        jidKind: "pn",
        fromMe: false,
        hasContent: true,
        counterpartySource: "chat_jid",
        assertedMappings: 0,
        mediaKind: null,
        hasAttachment: false,
        mimeFamily: null,
        ptt: false,
        durationPresent: false,
      },
      // A text message has no file hanging off it.
      media: null,
    });
  });

  it("carries the messages WhatsApp flushed from its offline queue", () => {
    // The redeploy case. These arrive as `append` because the device was not
    // connected when the patient wrote, and used to be discarded wholesale.
    const result = interpret(textMessage({ remoteJid: PATIENT_PN }), { type: "append" });
    assert.equal(result.outcome, "event");
    assert.equal(result.outcome === "event" && result.event.kind, "inbound");
  });

  it("does not resurrect a pathologically stale queue as a fresh thread", () => {
    const monthOld = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const result = interpret(textMessage({ remoteJid: PATIENT_PN }, "hello", monthOld), {
      type: "append",
    });
    assert.equal(result.outcome, "dropped");
    assert.equal(result.outcome === "dropped" && result.reason, "stale_offline_message");
  });

  it("reads text through the envelopes WhatsApp wraps content in", () => {
    assert.equal(messageText({ conversation: "plain" }), "plain");
    assert.equal(messageText({ extendedTextMessage: { text: "quoted reply" } }), "quoted reply");
    // Disappearing messages and both generations of view-once.
    assert.equal(messageText({ ephemeralMessage: { message: { conversation: "vanishing" } } }), "vanishing");
    assert.equal(
      messageText({ viewOnceMessageV2: { message: { imageMessage: { caption: "x-ray" } } } }),
      "x-ray",
    );
    assert.equal(
      messageText({ documentWithCaptionMessage: { message: { documentMessage: { caption: "report" } } } }),
      "report",
    );
    // Media with no caption still has to reach the inbox as *something*.
    assert.equal(messageText({ audioMessage: { ptt: true, seconds: 4 } }), "[voice message]");
    assert.equal(messageText({ audioMessage: { ptt: false, seconds: 4 } }), "[audio]");
    assert.equal(messageText({ imageMessage: {} }), "[image]");
    // And a message with nothing to show is not an empty inbox row.
    assert.equal(messageText({ reactionMessage: { text: "👍" } }), null);
    assert.equal(messageText(null), null);
  });

  it("drops a message with nothing renderable, and says so", () => {
    const result = interpret({
      key: { id: "3EB0", fromMe: false, remoteJid: PATIENT_PN },
      message: { reactionMessage: { text: "👍" } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as WAMessage);
    assert.equal(result.outcome, "dropped");
    assert.equal(result.outcome === "dropped" && result.reason, "no_recognized_content");
    assert.equal(result.outcome === "dropped" && result.diagnostic.hasContent, false);
  });
});

describe("direct messages on a LID", () => {
  it("is carried, attributed to the number WhatsApp asserted on the stanza", () => {
    const result = interpret(
      textMessage({ remoteJid: PATIENT_LID, senderLid: PATIENT_LID, senderPn: PATIENT_PN }),
    );
    assert.equal(result.outcome, "event");
    assert.equal(
      result.outcome === "event" && result.event.kind === "inbound" && result.event.sender,
      "+20100000000",
    );
    // The diagnostic says the mapping came from this stanza — which is the only
    // thing that distinguishes a LID chat WhatsApp has explained from one it has
    // not, and the log line that would prove a real conversation is LID-routed.
    assert.equal(result.outcome === "event" && result.diagnostic.counterpartySource, "asserted_stanza");
    assert.equal(result.outcome === "event" && result.diagnostic.jidKind, "lid");
  });

  it("remembers the pairing, so later messages on the same chat need no assertion", () => {
    const directory = new LidDirectory();
    interpret(
      textMessage({ remoteJid: PATIENT_LID, senderLid: PATIENT_LID, senderPn: PATIENT_PN }),
      { directory },
    );
    // The follow-up carries no sender_pn — WhatsApp only sends it sometimes.
    const later = interpret(textMessage({ remoteJid: PATIENT_LID, id: "3EB0SECOND" }), {
      directory,
    });
    assert.equal(
      later.outcome === "event" && later.event.kind === "inbound" && later.event.sender,
      "+20100000000",
    );
    assert.equal(later.outcome === "event" && later.diagnostic.counterpartySource, "directory");
    assert.equal(later.outcome === "event" && later.diagnostic.assertedMappings, 1);
  });

  it("learns the pairing from a device suffix on either side", () => {
    const directory = new LidDirectory();
    directory.remember("182736450192837:3@lid", "20100000000:14@s.whatsapp.net");
    assert.equal(directory.lookup(PATIENT_LID), "+20100000000");
  });

  it("refuses to guess when the number was never asserted", () => {
    const result = interpret(textMessage({ remoteJid: PATIENT_LID }));
    assert.equal(result.outcome, "dropped");
    assert.equal(result.outcome === "dropped" && result.reason, "unresolved_counterparty");
    // The diagnostic names the address space and nothing else about the chat.
    assert.deepEqual(result.outcome === "dropped" && result.diagnostic, {
      upsertType: "notify",
      jidKind: "lid",
      fromMe: false,
      hasContent: true,
      counterpartySource: "unresolved",
      assertedMappings: 0,
      mediaKind: null,
      hasAttachment: false,
      mimeFamily: null,
      ptt: false,
      durationPresent: false,
    });
  });

  it("ignores a phone number asserted for our own side of an outgoing message", () => {
    // The echo of a message typed on the clinic's handset into a LID chat carries
    // *our* sender_pn, not the patient's. Attributing the chat to it would file
    // the clinic's own number as the patient.
    const result = interpret(
      textMessage({ remoteJid: PATIENT_LID, fromMe: true, senderPn: SESSION_PN }),
    );
    assert.equal(result.outcome, "dropped");
    assert.equal(result.outcome === "dropped" && result.reason, "unresolved_counterparty");
  });

  it("mirrors that same echo once the chat's number is known", () => {
    const directory = new LidDirectory();
    directory.remember(PATIENT_LID, PATIENT_PN);
    const result = interpret(
      textMessage({ remoteJid: PATIENT_LID, fromMe: true, senderPn: SESSION_PN }, "see you at 4"),
      { directory },
    );
    assert.equal(
      result.outcome === "event" && result.event.kind === "outbound_echo" && result.event.recipient,
      "+20100000000",
    );
  });
});

describe("chats that are not patient conversations", () => {
  const cases: Array<[string, string]> = [
    ["a group", "123456789-1600000000@g.us"],
    ["a status update", "status@broadcast"],
    ["a broadcast list", "1600000000@broadcast"],
    ["a newsletter", "120363000000000000@newsletter"],
    ["Meta AI", "13135550002@c.us"],
  ];

  for (const [label, jid] of cases) {
    it(`ignores ${label}`, () => {
      const result = interpret(textMessage({ remoteJid: jid, participant: PATIENT_PN }));
      assert.equal(result.outcome, "dropped");
      assert.equal(result.outcome === "dropped" && result.reason, "not_direct_chat");
    });
  }

  it("still learns identities a group message asserted", () => {
    // The message is not carried, but the pairing it proved is true regardless —
    // and may be the only thing that makes the patient's own chat routable.
    const directory = new LidDirectory();
    interpret(
      textMessage({
        remoteJid: "123456789-1600000000@g.us",
        participantLid: PATIENT_LID,
        participantPn: PATIENT_PN,
      }),
      { directory },
    );
    assert.equal(directory.lookup(PATIENT_LID), "+20100000000");
  });

  it("drops a message with no provider id, which nothing downstream could dedupe", () => {
    const result = interpret(textMessage({ remoteJid: PATIENT_PN, id: null }));
    assert.equal(result.outcome, "dropped");
    assert.equal(result.outcome === "dropped" && result.reason, "no_provider_message_id");
  });
});

describe("the callback a live session posts", () => {
  it("reaches the application's linked-device webhook, signed, with the inbound event", async () => {
    const session = await connectedSession();
    try {
      await session.upsert({
        type: "notify",
        messages: [textMessage({ remoteJid: PATIENT_PN }, "is the clinic open?")],
      });

      assert.equal(session.posted.length, 1);
      const request = session.posted[0]!;
      assert.equal(
        request.url,
        "https://clinicflow.test/api/webhooks/whatsapp/linked-device",
      );
      // Tenant isolation and signing are unchanged by the inbound fix.
      assert.ok(request.headers["x-clinicflow-signature"]);
      assert.ok(request.headers["x-clinicflow-timestamp"]);
      assert.equal(request.body.clinicId, "11111111-1111-4111-8111-111111111111");
      assert.equal(request.body.sessionPhone, "+201111111111");
      assert.deepEqual(request.body.events, [
        {
          kind: "inbound",
          providerMessageId: "3EB0ABCDEF",
          sender: "+20100000000",
          body: "is the clinic open?",
          receivedAt: request.body.events[0]!.receivedAt,
        },
      ]);
    } finally {
      session.restore();
    }
  });

  it("carries a LID chat end to end, and keeps the clinic's own message an echo", async () => {
    const session = await connectedSession();
    try {
      await session.upsert({
        type: "append",
        messages: [
          textMessage(
            { remoteJid: PATIENT_LID, senderLid: PATIENT_LID, senderPn: PATIENT_PN },
            "I need an appointment",
          ),
          textMessage(
            { remoteJid: PATIENT_LID, id: "3EB0REPLY", fromMe: true, senderPn: SESSION_PN },
            "tomorrow at 10?",
          ),
        ],
      });

      const events = postedEvents(session.posted);
      const messages = events.filter(
        (event) => event.kind === "inbound" || event.kind === "outbound_echo",
      );
      assert.equal(messages.length, 2);
      assert.ok(events.some((event) => event.kind === "history_identity"));
      // The patient's message is inbound; the clinic's reply from their handset is
      // an outbound echo, never a second inbound message from themselves.
      assert.equal(messages[0]!.kind, "inbound");
      assert.equal(messages[0]!.sender, "+20100000000");
      assert.equal(messages[1]!.kind, "outbound_echo");
      assert.equal(messages[1]!.recipient, "+20100000000");
      assert.equal(events.filter((event) => event.kind === "inbound").length, 1);
    } finally {
      session.restore();
    }
  });

  it("learns a LID from the phone-number-share event WhatsApp emits for it", async () => {
    const session = await connectedSession();
    try {
      session.socket.emit("chats.phoneNumberShare", { lid: PATIENT_LID, jid: PATIENT_PN });
      await session.upsert({
        type: "notify",
        messages: [textMessage({ remoteJid: PATIENT_LID })],
      });
      const events = postedEvents(session.posted);
      const inbound = events.filter((event) => event.kind === "inbound");
      assert.equal(inbound.length, 1);
      assert.equal(inbound[0]!.sender, "+20100000000");
      assert.ok(events.some((event) => event.kind === "history_identity"));
    } finally {
      session.restore();
    }
  });

  it("posts nothing at all for a batch of groups and status updates", async () => {
    const session = await connectedSession();
    try {
      await session.upsert({
        type: "notify",
        messages: [
          textMessage({ remoteJid: "123456789-1600000000@g.us", participant: PATIENT_PN }),
          textMessage({ remoteJid: "status@broadcast", participant: PATIENT_PN }),
          textMessage({ remoteJid: "120363000000000000@newsletter" }),
        ],
      });
      assert.deepEqual(session.posted, []);
    } finally {
      session.restore();
    }
  });
});
