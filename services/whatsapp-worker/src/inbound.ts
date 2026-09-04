import { extractMessageContent, normalizeMessageContent, type WAMessage } from "baileys";
import type { CallbackEvent } from "./callback.ts";
import {
  classifyJid,
  isDirectChatKind,
  phoneFromJid,
  type JidKind,
  type LidDirectory,
  type NameDirectory,
} from "./jids.ts";
import {
  mediaMetadataFor,
  mediaTypeOf,
  mimeBase,
  type MediaMessageType,
} from "./media.ts";

/**
 * Turning one Baileys message into one ClinicFlow event — or into a reason it was
 * not carried.
 *
 * Kept apart from the session manager and free of side effects (other than
 * teaching the LID directory what WhatsApp just asserted) so every branch below
 * is reachable from a test without a socket.
 */

/** The bracketed marker staff see for a message type we cannot render as text. */
const MEDIA_MARKERS: Record<string, string> = {
  imageMessage: "[image]",
  videoMessage: "[video]",
  ptvMessage: "[video note]",
  documentMessage: "[document]",
  stickerMessage: "[sticker]",
  contactMessage: "[contact]",
  contactsArrayMessage: "[contact]",
  locationMessage: "[location]",
  liveLocationMessage: "[location]",
};

/**
 * The readable body of a message, or null if there is nothing to show staff.
 *
 * The unwrapping is Baileys' own: `normalizeMessageContent` peels the
 * future-proof envelopes (disappearing messages, view-once in both its
 * generations, document-with-caption, edits) and `extractMessageContent` reaches
 * inside button and template messages. Hand-rolling that list is how a
 * disappearing-message chat ends up looking like an empty inbox.
 */
export function messageText(message: WAMessage["message"]): string | null {
  const content = extractMessageContent(normalizeMessageContent(message));
  if (!content) return null;

  if (typeof content.conversation === "string" && content.conversation.length > 0) {
    return content.conversation;
  }
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  const caption =
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption;
  if (caption) return caption;
  // A tap on a button or list row is a reply, and the label is what the patient
  // believes they said.
  const reply =
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.listResponseMessage?.title;
  if (reply) return reply;
  if (content.audioMessage) {
    return content.audioMessage.ptt === true ? "[voice message]" : "[audio]";
  }
  for (const [type, marker] of Object.entries(MEDIA_MARKERS)) {
    if (type in content) return marker;
  }
  return null;
}

/**
 * Why a message was not carried into the inbox.
 *
 * Each one is logged with the diagnostic below, so a clinic reporting "nothing
 * arrives" can be answered from the worker's own logs instead of guessed at.
 */
export type DropReason =
  /** A group, status update, broadcast list, newsletter or first-party bot. */
  | "not_direct_chat"
  | "no_provider_message_id"
  /** A LID chat whose phone number this session has not been told yet. */
  | "unresolved_counterparty"
  | "no_recognized_content"
  | "stale_offline_message";

/**
 * How the phone number on the other end of a chat was established.
 *
 * This is the evidence for the outbound address-selection question — "does this
 * session hold a WhatsApp-asserted LID for this contact, and if not, why not?" —
 * so it is recorded for carried messages as well as dropped ones.
 *
 *   - `chat_jid`: the chat is addressed by phone number, so the chat JID *is*
 *     the answer. A conversation that only ever reports this is being conducted
 *     entirely in the PN address space, and there is no LID to be had: WhatsApp
 *     never asserted one because it never used one.
 *   - `asserted_stanza`: the chat is a LID, and this very stanza carried the
 *     `sender_pn` that names the number behind it. WhatsApp sends it only
 *     sometimes, so this is the count that says how freely it is doing so.
 *   - `directory`: the chat is a LID, resolved from an assertion this session
 *     recorded earlier rather than from anything on this stanza.
 *   - `unresolved`: a LID chat with no assertion anywhere. Nothing is guessed.
 */
export type CounterpartySource = "chat_jid" | "asserted_stanza" | "directory" | "unresolved";

/**
 * Everything the worker is allowed to log about a message: the shape of the
 * traffic, never its content. No JID, no phone number, no message body —
 * `jidKind` is the address *space* only, and `hasContent` is a boolean about
 * whether anything renderable was found.
 */
export type InboundDiagnostic = {
  upsertType: string;
  jidKind: JidKind;
  fromMe: boolean;
  hasContent: boolean;
  counterpartySource: CounterpartySource;
  /** How many LID ↔ number pairings this session has been told, in total. */
  assertedMappings: number;
  mediaKind: "image" | "document" | "audio" | "video" | null;
  hasAttachment: boolean;
  mimeFamily: string | null;
  ptt: boolean;
  durationPresent: boolean;
};

/**
 * A file hanging off a carried message, and the unwrapped content node it lives
 * in. The interpreter does not download anything — it only says *what* there is
 * to download, so the session manager can decide (and so every branch in this
 * file stays testable without a socket).
 */
export type InterpretedMedia = {
  type: MediaMessageType;
  content: Record<string, unknown>;
};

export type Interpretation =
  | {
      outcome: "event";
      event: CallbackEvent;
      diagnostic: InboundDiagnostic;
      media: InterpretedMedia | null;
    }
  | { outcome: "dropped"; reason: DropReason; diagnostic: InboundDiagnostic };

/**
 * How old an offline-flushed message may be and still be treated as news.
 *
 * WhatsApp queues messages for a device that is not connected and flushes them on
 * the next handshake, flagged `offline` — which Baileys reports as upsert type
 * `append` rather than `notify`. Those are exactly the messages a clinic sent
 * during a redeploy, so they must be carried. Bulk history, by contrast, never
 * arrives on this event at all (it comes through `messaging-history.set`, which
 * this worker does not subscribe to), so the only thing this bound guards against
 * is a pathologically stale queue resurfacing as a fresh inbox thread.
 */
const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Records every LID ↔ phone-number pairing WhatsApp asserted on this stanza.
 *
 * Done before any drop decision: the assertion is true whether or not this
 * particular message is carried, and a group message or an unrenderable one can
 * still be what teaches the session who a LID belongs to.
 *
 * The chat JID is only used as the LID half when the message came *in*. On an
 * outgoing message `sender_pn` is the clinic's own number, so pairing it with the
 * chat's LID would overwrite the patient's identity with the clinic's and then
 * mirror every reply back to the clinic itself.
 */
export function learnMessageIdentities(message: WAMessage, directory: LidDirectory): void {
  const { key } = message;
  const senderLid = key.senderLid ?? (key.fromMe ? null : key.remoteJid);
  directory.remember(senderLid, key.senderPn);
  directory.remember(key.participantLid ?? key.participant, key.participantPn);
}

/**
 * The phone number of the person on the other side of a one-to-one chat.
 *
 * For a phone-number chat that is the chat JID itself. For a LID chat it is
 * whatever WhatsApp asserted — `sender_pn` on this very stanza, or an earlier
 * assertion this session recorded — and never the LID's own digits, which are an
 * opaque server identifier that would otherwise be published as a stranger's
 * phone number.
 *
 * The consequence, stated rather than hidden: the echo of a message the clinic
 * typed on their handset into a LID chat carries *our* `sender_pn`, not the
 * patient's, so it can only be attributed once the session has learned that LID
 * from something else. In practice a patient writes first — that inbound message
 * is the assertion — and an unattributable echo is dropped with a diagnostic
 * instead of being filed against a guess.
 */
function resolveCounterparty(
  kind: "pn" | "lid",
  message: WAMessage,
  directory: LidDirectory,
): { phone: string | null; source: CounterpartySource } {
  if (kind === "pn") {
    return { phone: phoneFromJid(message.key.remoteJid), source: "chat_jid" };
  }
  const remembered = directory.lookup(message.key.remoteJid);
  const assertedHere = message.key.fromMe ? null : phoneFromJid(message.key.senderPn);
  const phone = remembered ?? assertedHere;
  if (!phone) return { phone: null, source: "unresolved" };
  // `learnIdentities` has already filed whatever this stanza asserted, so a
  // directory hit does not on its own mean an *earlier* message taught us the
  // pairing. The distinction worth logging is whether this stanza carried the
  // assertion at all — that is what says how often WhatsApp is volunteering the
  // mapping on this chat, as opposed to how often we are relying on memory.
  return { phone, source: phone === assertedHere ? "asserted_stanza" : "directory" };
}

export function interpretMessage(input: {
  upsertType: string;
  message: WAMessage;
  directory: LidDirectory;
  /** Learns and supplies the contact name WhatsApp reports. Optional. */
  names?: NameDirectory;
  now?: number;
  /**
   * How stale a non-`notify` message may be before it is treated as a resurfaced
   * queue rather than news. `null` disables the bound, which is exactly what the
   * history import needs: every message it carries is old *by definition*, and
   * applying the offline-flush guard to it would discard the entire import.
   */
  staleAfterMs?: number | null;
  /** Marks the produced event as coming from the history sync. */
  historical?: boolean;
}): Interpretation {
  const { upsertType, message, directory } = input;
  const now = input.now ?? Date.now();
  const historical = input.historical ?? false;
  const staleAfterMs = input.staleAfterMs === undefined ? OFFLINE_MAX_AGE_MS : input.staleAfterMs;
  const { key } = message;

  learnMessageIdentities(message, directory);

  const kind = classifyJid(key.remoteJid);
  const fromMe = Boolean(key.fromMe);
  const content = extractMessageContent(normalizeMessageContent(message.message)) as
    | Record<string, unknown>
    | undefined;
  const detectedMedia = content ? mediaTypeOf(content) : null;
  const mediaMetadata = content && detectedMedia
    ? mediaMetadataFor(content, detectedMedia)
    : null;
  const body = messageText(message.message);
  // `counterpartySource` is filled in as soon as the chat is known to be a
  // direct one; until then "unresolved" is the honest answer, and a group or a
  // status update never gets further than the next line anyway.
  const diagnostic: InboundDiagnostic = {
    upsertType,
    jidKind: kind,
    fromMe,
    hasContent: body !== null,
    counterpartySource: "unresolved",
    assertedMappings: directory.size,
    mediaKind: mediaMetadata?.mediaKind ?? null,
    hasAttachment: Boolean(detectedMedia),
    mimeFamily: mediaMetadata
      ? mimeBase(mediaMetadata.mimeType).split("/")[0] || null
      : null,
    ptt: mediaMetadata?.voiceNote ?? false,
    durationPresent: mediaMetadata?.durationSeconds !== null && mediaMetadata?.durationSeconds !== undefined,
  };
  const drop = (reason: DropReason): Interpretation => ({ outcome: "dropped", reason, diagnostic });

  if (!isDirectChatKind(kind)) return drop("not_direct_chat");

  const providerMessageId = key.id;
  if (!providerMessageId) return drop("no_provider_message_id");

  const resolved = resolveCounterparty(kind, message, directory);
  diagnostic.counterpartySource = resolved.source;
  const counterparty = resolved.phone;
  if (!counterparty) return drop("unresolved_counterparty");

  // `pushName` is the name the *sender* publishes, so it only describes the
  // counterparty on a message they sent. On our own echo it is the clinic's own
  // name and is deliberately ignored.
  if (!fromMe) input.names?.remember(counterparty, message.pushName, 2);
  const displayName = input.names?.lookup(counterparty) ?? null;

  if (body === null) return drop("no_recognized_content");

  const timestamp = Number(message.messageTimestamp ?? 0) * 1000;
  if (
    upsertType !== "notify" &&
    staleAfterMs !== null &&
    timestamp > 0 &&
    now - timestamp > staleAfterMs
  ) {
    return drop("stale_offline_message");
  }
  const occurredAt = new Date(timestamp || now).toISOString();
  // Media is reported for inbound messages only. An echo of a file the *clinic*
  // sent from their own phone is not a patient attachment, and pulling it would
  // spend bandwidth and storage on bytes the clinic already has.
  const media = !fromMe ? detectedMedia : null;

  if (fromMe) {
    // A message the clinic sent from their own phone (or that ClinicFlow sent
    // through this session — the application discards that echo).
    return {
      outcome: "event",
      event: {
        kind: "outbound_echo",
        providerMessageId,
        recipient: counterparty,
        body,
        occurredAt,
        ...(displayName ? { displayName } : {}),
        ...(historical ? { historical: true } : {}),
      },
      diagnostic,
      media: null,
    };
  }
  return {
    outcome: "event",
    event: {
      kind: "inbound",
      providerMessageId,
      sender: counterparty,
      body,
      receivedAt: occurredAt,
      ...(displayName ? { displayName } : {}),
      ...(historical ? { historical: true } : {}),
    },
    diagnostic,
    media: media && content ? { type: media, content } : null,
  };
}
