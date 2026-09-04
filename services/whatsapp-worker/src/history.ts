import {
  extractMessageContent,
  normalizeMessageContent,
  type Chat,
  type Contact,
  type WAMessage,
} from "baileys";
import type { CallbackAttachment, CallbackEvent } from "./callback.ts";
import { interpretMessage, learnMessageIdentities, messageText } from "./inbound.ts";
import {
  canonicalLidJid,
  classifyJid,
  isDirectChatKind,
  phoneFromJid,
  type LidDirectory,
  type NameDirectory,
} from "./jids.ts";
import { mediaMetadataFor, mediaTypeOf } from "./media.ts";

/**
 * The existing conversations a phone hands its new linked device.
 *
 * ## What WhatsApp actually gives us, stated plainly
 *
 * When a device is linked, the phone pushes a *history sync* to it: a series of
 * protobuf blobs that Baileys decodes and re-emits as `messaging-history.set`,
 * carrying chats, contacts and messages. This is the only mechanism that exists.
 * There is no API to ask WhatsApp for "all messages in this chat", and nothing in
 * this file invents one.
 *
 * Its limits are the platform's, not the worker's, and they are reported rather
 * than papered over:
 *
 *   - **The phone decides what to send.** WhatsApp's own clients receive a
 *     bounded recent window per chat, not the archive. Requesting
 *     `syncFullHistory` asks for the larger of the two windows WhatsApp offers;
 *     it does not make the phone send everything it has, and how much arrives
 *     varies by account, platform and how long the phone has been online.
 *   - **It arrives once, on the initial link.** A device that is already paired
 *     and merely reconnecting gets `syncType: RECENT` or nothing at all. This is
 *     why the import is written to be re-runnable and idempotent rather than
 *     "run once and hope".
 *   - **Old media is usually gone.** History messages reference media URLs that
 *     WhatsApp expires; the text survives, the file typically does not. History
 *     import therefore carries safe metadata for unavailable files rather than
 *     claiming bytes it cannot retrieve; live traffic is where stored
 *     attachments come from.
 *   - **Nothing is guaranteed.** If the phone sends no history, the import
 *     reports `unavailable`. It does not fabricate an empty success.
 *
 * ## What is imported
 *
 * One-to-one chats, and nothing else. Resolvable PN/LID chats are delivered
 * immediately; unresolved LID chats and messages are durably staged until an
 * asserted mapping arrives. Groups, broadcasts, status, newsletters, and Meta
 * AI are refused by {@link classifyJid} — the same classifier the live path
 * uses, so the two can never disagree about what an Inbox conversation is.
 */

export type HistoryBatch = {
  chats: Chat[];
  contacts: Contact[];
  messages: WAMessage[];
  isLatest?: boolean;
  syncType?: number | null;
  /** Exposed by newer Baileys versions; 6.7.24 omits it from the event. */
  lidPnMappings?: Array<{ lid?: string | null; pn?: string | null }>;
};

export type HistoryInterpretation = {
  events: CallbackEvent[];
  /** Direct chats carried, for the progress the clinic sees. */
  chats: number;
  messages: number;
  /** Chats refused because they are not one-to-one patient conversations. */
  skippedChats: number;
  /** Direct chats whose phone number this session could not establish. */
  unresolvedChats: number;
  pendingMessages: number;
  unsupportedMessages: number;
};

function chatTimestamp(chat: Chat): number | null {
  const raw =
    (chat as { conversationTimestamp?: unknown }).conversationTimestamp ??
    (chat as { lastMessageRecvTimestamp?: unknown }).lastMessageRecvTimestamp;
  const seconds = Number(raw ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * The phone number behind a chat id, using only what WhatsApp has asserted.
 *
 * A LID-addressed chat resolves through the same directory the live path uses.
 * When nothing has asserted the mapping, this returns null and the caller emits
 * a pending LID record — publishing a LID's own digits as a phone number would
 * file a stranger's conversation under somebody else's identity.
 */
function chatPhone(chatId: string | null | undefined, directory: LidDirectory): string | null {
  const kind = classifyJid(chatId);
  if (!isDirectChatKind(kind)) return null;
  return kind === "pn" ? phoneFromJid(chatId) : directory.lookup(chatId);
}

/** Metadata only: history media URLs are normally expired, so no bytes are claimed. */
function historicalAttachment(message: WAMessage): CallbackAttachment[] | undefined {
  const content = extractMessageContent(normalizeMessageContent(message.message)) as
    | Record<string, unknown>
    | undefined;
  const type = mediaTypeOf(content);
  if (!content || !type) return undefined;
  const metadata = mediaMetadataFor(content, type);
  return [{
    mediaKind: metadata.mediaKind,
    voiceNote: metadata.voiceNote,
    durationSeconds: metadata.durationSeconds,
    mimeType: metadata.mimeType,
    originalFilename: metadata.originalFilename,
    byteSize: 0,
    sha256: null,
    storagePath: null,
    status: "rejected",
    failureReason: "historical_media_unavailable",
  }];
}

/**
 * Turns one `messaging-history.set` payload into the events the application
 * persists.
 *
 * Contacts are learned first: they are what turns a bare number into a name, and
 * the messages below use whatever observed contact label the session already had.
 */
export function interpretHistoryBatch(input: {
  batch: HistoryBatch;
  directory: LidDirectory;
  names: NameDirectory;
  now?: number;
  /** Oldest WhatsApp occurrence allowed to create ClinicFlow Inbox activity. */
  inboundActiveFrom?: string | null;
}): HistoryInterpretation {
  const { batch, directory, names } = input;
  const now = input.now ?? Date.now();
  const parsedBoundary = input.inboundActiveFrom
    ? new Date(input.inboundActiveFrom).valueOf()
    : Number.NaN;
  const boundaryEnabled = Number.isFinite(parsedBoundary);
  const boundary = boundaryEnabled ? parsedBoundary : Number.NEGATIVE_INFINITY;
  const admitted = (timestamp: number | null): boolean =>
    !boundaryEnabled ||
    (timestamp !== null && Number.isFinite(timestamp) && timestamp >= boundary);

  // A contact record is the only place the clinic's *own saved* name for a
  // patient appears, so this runs before anything is attributed.
  for (const contact of batch.contacts ?? []) {
    directory.remember(contact.lid, contact.jid ?? contact.id);
    names.rememberContact(contact, directory);
  }

  // Baileys 6.7.24 drops HistorySync.phoneNumberToLidMappings from the emitted
  // event, but keeps the same asserted pair on Conversation.pnJid/lidJid.
  // Consume both shapes. Newer versions expose lidPnMappings directly.
  for (const mapping of batch.lidPnMappings ?? []) {
    directory.remember(mapping.lid, mapping.pn);
  }
  for (const chat of batch.chats ?? []) {
    const kind = classifyJid(chat.id);
    const lid = kind === "lid" ? chat.id : chat.lidJid ?? chat.accountLid;
    const pn = kind === "pn" ? chat.id : chat.pnJid;
    directory.remember(lid, pn);
  }
  // Learn every assertion before interpreting any message. A mapping carried
  // by the last stanza in a batch can therefore recover the first stanza too.
  for (const message of batch.messages ?? []) learnMessageIdentities(message, directory);

  const events: CallbackEvent[] = directory.takeNewMappings().map((mapping) => ({
    kind: "history_identity" as const,
    lid: mapping.lid,
    participant: mapping.phone,
  }));
  const carriedChats = new Set<string>();
  let skippedChats = 0;
  let unresolvedChats = 0;

  for (const chat of batch.chats ?? []) {
    const kind = classifyJid(chat.id);
    if (!isDirectChatKind(kind)) {
      skippedChats += 1;
      continue;
    }
    const phone = chatPhone(chat.id, directory);
    if (!phone) {
      unresolvedChats += 1;
      const lid = canonicalLidJid(chat.id);
      const at = chatTimestamp(chat);
      if (lid && admitted(at)) {
        events.push({
          kind: "history_pending_chat",
          lid,
          displayName:
            typeof (chat as { name?: unknown }).name === "string"
              ? String((chat as { name?: unknown }).name).slice(0, 120)
              : null,
          lastMessageAt: at === null ? null : new Date(at).toISOString(),
        });
      }
      continue;
    }
    const at = chatTimestamp(chat);
    // The chat record is a second name source, and often the better one: it
    // carries the name the clinic saved on their own phone.
    names.remember(phone, (chat as { name?: unknown }).name, 0);
    if (!admitted(at) || carriedChats.has(phone)) continue;
    carriedChats.add(phone);
    events.push({
      kind: "history_chat",
      participant: phone,
      displayName: names.lookup(phone),
      lastMessageAt: at === null ? null : new Date(at).toISOString(),
    });
  }

  let messages = 0;
  let pendingMessages = 0;
  let unsupportedMessages = 0;
  for (const message of batch.messages ?? []) {
    const timestamp = Number(message.messageTimestamp ?? 0) * 1000;
    // History remains useful for names and asserted LID mappings, but a
    // missing/old occurrence can never become Inbox activity. Missing history
    // timestamps are not promoted to `now`: that would defeat the boundary.
    if (!admitted(timestamp > 0 ? timestamp : null)) continue;
    const interpreted = interpretMessage({
      upsertType: "history",
      message,
      directory,
      names,
      now,
      // History is old by construction; the offline-flush staleness bound would
      // discard all of it.
      staleAfterMs: null,
      historical: true,
    });
    if (interpreted.outcome !== "event") {
      if (interpreted.reason === "unresolved_counterparty") {
        const lid = canonicalLidJid(message.key.remoteJid);
        const providerMessageId = message.key.id;
        const body = messageText(message.message);
        if (lid && providerMessageId && body !== null) {
          events.push({
            kind: "history_pending_message",
            lid,
            providerMessageId,
            direction: message.key.fromMe ? "outbound" : "inbound",
            body,
            occurredAt: new Date(timestamp || now).toISOString(),
            ...(!message.key.fromMe && message.pushName
              ? { displayName: String(message.pushName).slice(0, 120) }
              : {}),
            ...(!message.key.fromMe && historicalAttachment(message)
              ? { attachments: historicalAttachment(message) }
              : {}),
          });
          pendingMessages += 1;
          continue;
        }
      }
      unsupportedMessages += 1;
      continue;
    }
    if (interpreted.event.kind !== "inbound" && interpreted.event.kind !== "outbound_echo") {
      unsupportedMessages += 1;
      continue;
    }
    // A message may name a chat the chat list did not (or named before this
    // session learned the LID mapping). Opening the thread from the message keeps
    // those conversations from arriving message-first with nowhere to land.
    const participant =
      interpreted.event.kind === "inbound" ? interpreted.event.sender : interpreted.event.recipient;
    if (!carriedChats.has(participant)) {
      carriedChats.add(participant);
      events.push({
        kind: "history_chat",
        participant,
        displayName: names.lookup(participant),
        lastMessageAt: timestamp > 0 ? new Date(timestamp).toISOString() : null,
      });
    }
    if (interpreted.event.kind === "inbound") {
      const attachments = historicalAttachment(message);
      if (attachments) interpreted.event.attachments = attachments;
    }
    events.push(interpreted.event);
    messages += 1;
  }

  // Oldest first, so a thread reads in the order it happened and the
  // conversation's last_message_at ends up on the newest message rather than
  // whichever one the sync happened to send last.
  events.push({
    kind: "history_metrics",
    chatsReceived: batch.chats?.length ?? 0,
    messagesReceived: batch.messages?.length ?? 0,
    unsupportedMessages,
    unresolvedChats,
  });
  events.sort((a, b) => historyOrder(a) - historyOrder(b));

  return {
    events,
    chats: carriedChats.size,
    messages,
    skippedChats,
    unresolvedChats,
    pendingMessages,
    unsupportedMessages,
  };
}

/** Chat rows first, then messages oldest-first. */
function historyOrder(event: CallbackEvent): number {
  if (event.kind === "history_identity") return -3;
  if (event.kind === "history_pending_chat") return -2;
  if (event.kind === "history_chat") return -1;
  if (event.kind === "history_pending_message") return new Date(event.occurredAt).valueOf();
  if (event.kind === "history_metrics") return Number.MAX_SAFE_INTEGER;
  if (event.kind === "inbound") return new Date(event.receivedAt).valueOf();
  if (event.kind === "outbound_echo") return new Date(event.occurredAt).valueOf();
  return 0;
}
