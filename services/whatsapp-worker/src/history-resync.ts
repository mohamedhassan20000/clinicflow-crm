/**
 * On-demand history recovery for an *already authenticated* linked device.
 *
 * ## What Baileys 6.7.24 actually provides
 *
 * One mechanism, and it is real rather than inferred: `WASocket.fetchMessageHistory`
 * (`lib/Socket/messages-recv.js`). It builds a
 * `PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND` peer message —
 * `historySyncOnDemandRequest { chatJid, oldestMsgFromMe, oldestMsgId,
 * oldestMsgTimestampMs, onDemandMsgCount }` — and relays it to the account's own
 * JID. The phone answers asynchronously with an ordinary
 * `HISTORY_SYNC_NOTIFICATION` protocol message whose `syncType` is `ON_DEMAND`;
 * `ON_DEMAND` is in `PROCESSABLE_HISTORY_TYPES`, so Baileys downloads it and
 * re-emits it on the *same* `messaging-history.set` event the initial link push
 * uses. Nothing new has to be parsed, spooled or de-duplicated: the response
 * lands in `SessionManager.onHistory` exactly like any other batch.
 *
 * It throws `Boom('Not authenticated')` unless `creds.me.id` is present, so it is
 * only ever callable on a live authenticated session. It performs no logout, no
 * re-registration and no auth mutation of any kind.
 *
 * ## The limitation this cannot paper over
 *
 * The request is *anchored*: it asks the phone for the `count` messages that
 * precede a message the device already has, identified by
 * `(chatJid, oldestMsgId, oldestMsgFromMe, oldestMsgTimestampMs)`. There is no
 * anchorless form, and no way to ask for a chat the device has never seen a
 * message in. So this **extends** history backwards per conversation; it cannot
 * bootstrap an empty inbox. A clinic with no imported messages at all has no
 * anchors, and this reports `no_anchors` rather than pretending otherwise —
 * for that case the only mechanism WhatsApp offers is the initial-link push.
 *
 * Anchors are read from the application's own durable rows, scoped to the
 * clinic *and* the authenticated account, so a resync can never reach into a
 * conversation belonging to a different linked account.
 */

/** Conversations touched by one resync run. Bounded so a run is rate-safe. */
export const HISTORY_RESYNC_MAX_CHATS = 25;
/** Messages requested per conversation. WhatsApp caps this itself; we ask small. */
export const HISTORY_RESYNC_MESSAGES_PER_CHAT = 50;
/** Minimum gap between two runs for one clinic. */
export const HISTORY_RESYNC_COOLDOWN_MS = 5 * 60_000;
/** Gap between individual peer requests inside one run. */
export const HISTORY_RESYNC_SPACING_MS = 400;

/** E.164, the one address form conversations and contacts are stored in. */
const E164 = /^\+[1-9][0-9]{5,19}$/;

/**
 * The oldest message this clinic holds for one conversation of the currently
 * authenticated account — the only thing an on-demand request can be hung on.
 */
export type HistoryResyncAnchor = {
  /** E.164 counterparty, as `conversations.participant_address` stores it. */
  participantAddress: string;
  /** WhatsApp's own message id (`inbound_messages.provider_message_id`). */
  providerMessageId: string;
  fromMe: boolean;
  /** ISO timestamp of that message. */
  occurredAt: string;
};

/** One `fetchMessageHistory` call, fully formed. */
export type HistoryResyncRequest = {
  chatJid: string;
  key: { remoteJid: string; id: string; fromMe: boolean };
  timestampMs: number;
  count: number;
};

export type HistoryResyncOutcome =
  | { ok: true; requested: number; chats: number }
  | {
      ok: false;
      code:
        | "NO_SESSION"
        | "NOT_CONNECTED"
        | "UNSUPPORTED"
        | "NO_ANCHORS"
        | "COOLDOWN"
        | "IN_PROGRESS";
    };

/**
 * Turns durable anchors into the peer requests to send.
 *
 * One request per conversation, the *oldest* anchor wins (that is what the
 * request extends backwards from), malformed rows are dropped rather than
 * guessed at, and the whole plan is capped. Pure, so the bounds and the
 * account-scoping are testable without a socket.
 */
export function planHistoryResync(input: {
  anchors: ReadonlyArray<HistoryResyncAnchor>;
  maxChats?: number;
  messagesPerChat?: number;
}): HistoryResyncRequest[] {
  const maxChats = input.maxChats ?? HISTORY_RESYNC_MAX_CHATS;
  const count = input.messagesPerChat ?? HISTORY_RESYNC_MESSAGES_PER_CHAT;
  const oldest = new Map<string, { anchor: HistoryResyncAnchor; at: number }>();
  for (const anchor of input.anchors) {
    if (!E164.test(anchor.participantAddress)) continue;
    if (!anchor.providerMessageId || anchor.providerMessageId.length > 128) continue;
    const at = new Date(anchor.occurredAt).valueOf();
    if (!Number.isFinite(at) || at <= 0) continue;
    const existing = oldest.get(anchor.participantAddress);
    if (!existing || at < existing.at) oldest.set(anchor.participantAddress, { anchor, at });
  }
  return [...oldest.values()]
    // Oldest conversations first: those are the ones whose backlog is missing.
    .sort((a, b) => a.at - b.at)
    .slice(0, maxChats)
    .map(({ anchor, at }) => {
      const chatJid = `${anchor.participantAddress.replace(/^\+/, "")}@s.whatsapp.net`;
      return {
        chatJid,
        key: { remoteJid: chatJid, id: anchor.providerMessageId, fromMe: anchor.fromMe },
        timestampMs: at,
        count,
      };
    });
}
