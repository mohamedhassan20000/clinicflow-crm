import type { proto } from "baileys";
import type { LidDirectory } from "./jids.ts";

/**
 * Everything about *addressing and re-sending* an outgoing message, kept apart
 * from the session manager so each decision is reachable from a test without a
 * socket.
 *
 * Two separate problems live here, and they are worth stating separately
 * because only one of them is about LIDs.
 *
 * ## 1. A message the recipient could not decrypt is never repaired
 *
 * WhatsApp's end-to-end protocol treats a failed decryption as recoverable: the
 * recipient shows "Waiting for this message. This may take a while." and sends
 * the sender a *retry receipt*. A healthy sender answers it by re-encrypting the
 * same message against a freshly negotiated Signal session. Baileys implements
 * the receiving half of that exchange in `Socket/messages-recv.ts`
 * (`sendMessagesAgain`), and it recovers the plaintext to re-send by calling the
 * `getMessage` hook supplied at socket construction:
 *
 *     const msgs = await Promise.all(ids.map(id => getMessage({ ...key, id })))
 *     ...
 *     await assertSessions([participant], true)   // force a brand-new session
 *     ...
 *     if (msg) { await relayMessage(key.remoteJid, msg, msgRelayOpts) }
 *     else     { logger.debug(..., 'recv retry request, but message not available') }
 *
 * The default `getMessage` in `Defaults/index.ts` is `async () => undefined`. A
 * worker that does not override it therefore takes the `else` branch on *every*
 * retry: the receipt is consumed, nothing is re-sent, and the placeholder on the
 * recipient's phone is permanent. The failure is silent — no exception, no error
 * status, and `sendMessage` has long since returned a perfectly good message id.
 *
 * `SentMessageCache` below is the missing half. Note that `sendMessagesAgain`
 * forces a *new* Signal session before re-sending, which makes the retry path a
 * genuine repair rather than a replay of the same undecryptable ciphertext.
 *
 * ## 2. Which address a one-to-one chat is sent to
 *
 * See `selectSendTarget`.
 */

/**
 * The recent outgoing messages this session can still be asked to re-send.
 *
 * Bounded and in-memory on purpose. A retry receipt arrives seconds to minutes
 * after the send, from a device that was online enough to receive the stanza, so
 * a small recent window answers essentially every real retry. The alternative —
 * persisting message plaintext — would put patient message bodies in the
 * database for the sake of an exchange that has already stopped mattering by the
 * time anything would read them back.
 *
 * Insertion-ordered eviction (a plain `Map`, oldest key first) rather than true
 * LRU: retries are answered from the recent tail, so recency of *writes* is the
 * property that matters and a read should not extend a message's life.
 */
export class SentMessageCache {
  private readonly capacity: number;
  private readonly messages = new Map<string, proto.IMessage>();

  constructor(capacity = 256) {
    this.capacity = Math.max(1, capacity);
  }

  /** Records the plaintext of a message just sent, keyed by its WhatsApp id. */
  remember(messageId: string | null | undefined, message: proto.IMessage | null | undefined): void {
    if (typeof messageId !== "string" || messageId.length === 0 || !message) return;
    // Re-inserting moves the key to the end, so a re-sent id is not evicted
    // early on account of its original send.
    this.messages.delete(messageId);
    this.messages.set(messageId, message);
    while (this.messages.size > this.capacity) {
      const oldest = this.messages.keys().next();
      if (oldest.done) break;
      this.messages.delete(oldest.value);
    }
  }

  /** The Baileys `getMessage` hook: the plaintext to re-encrypt, if we still have it. */
  lookup(messageId: string | null | undefined): proto.IMessage | undefined {
    if (typeof messageId !== "string") return undefined;
    return this.messages.get(messageId) ?? undefined;
  }

  get size(): number {
    return this.messages.size;
  }
}

/** Which of WhatsApp's two address spaces an outgoing message is sent to. */
export type SendAddressKind = "pn" | "lid";

/**
 * Where a mapped LID came from, for the diagnostic log. `directory` means this
 * session was told the pairing by WhatsApp; `none` means no mapping was known
 * and the phone-number address was used.
 */
export type SendMappingSource = "directory" | "none";

export type SendTarget = {
  jid: string;
  addressKind: SendAddressKind;
  mappingSource: SendMappingSource;
};

/**
 * The JID to hand `socket.sendMessage`, chosen from what this session actually
 * knows.
 *
 * ### Why this is not simply always the phone number
 *
 * Baileys 6.7.24 keys Signal sessions on the JID's *user part only*. From
 * `Signal/libsignal.ts`:
 *
 *     const jidToSignalProtocolAddress = (jid) => {
 *       const { user, device } = jidDecode(jid)
 *       return new libsignal.ProtocolAddress(user, device || 0)
 *     }
 *
 * The server (`s.whatsapp.net` vs `lid`) is discarded. A LID's user part and a
 * phone number's user part are unrelated digit strings, so the same physical
 * device occupies two entirely separate session records depending on which
 * address space reached it. This version has no LID mapping store and no
 * session-migration step — `lidMapping` and `migrateSession` do not exist
 * anywhere in the package — so nothing reconciles the two.
 *
 * The consequence for a LID-addressed chat: everything inbound advances the
 * session under the LID's user part, while an outbound forced to
 * `<phone>@s.whatsapp.net` looks up a *different*, usually absent, record —
 * so `assertSessions` fetches a fresh pre-key bundle and opens a second,
 * parallel session with a device that is already talking to us on the first one.
 *
 * ### The rule
 *
 * Prefer the LID address when WhatsApp itself has asserted one for this number,
 * because that is the address space the conversation is actually being conducted
 * in. Otherwise use the phone-number address, which is the ordinary supported
 * path for a contact that has not been migrated.
 *
 * Two guards, both of which fall back to the phone number rather than failing:
 *
 *   - **A mapping is only ever used, never derived.** `LidDirectory` holds only
 *     pairings WhatsApp stated (`sender_pn`/`participant_pn` on a stanza, the
 *     `chats.phoneNumberShare` event, or a contact record carrying both). If the
 *     number is not in it, there is no LID to use and none is invented.
 *   - **Our own LID must be known.** `relayMessage` dereferences it unguarded on
 *     the LID branch:
 *
 *         jidEncode(isMe && isLid ? authState.creds?.me?.lid.split(':')[0] || user : user, ...)
 *
 *     The optional chain stops before `.lid`, so `me.lid` being undefined throws
 *     a `TypeError` out of `sendMessage` and the message is simply lost. An
 *     account whose creds carry no LID is therefore sent to over the phone-number
 *     path regardless of what the directory knows.
 */
export function selectSendTarget(input: {
  /** The recipient in `+<digits>` form. */
  phone: string;
  directory: Pick<LidDirectory, "lidJidFor">;
  /** `creds.me.lid`, present only once WhatsApp has issued this device a LID. */
  ownLid: string | null | undefined;
  /** Set false to pin every send to the phone-number path. */
  lidRoutingEnabled: boolean;
}): SendTarget {
  const { phone, directory, ownLid, lidRoutingEnabled } = input;
  const pnJid = `${phone.replace(/^\+/, "")}@s.whatsapp.net`;
  const pnTarget: SendTarget = { jid: pnJid, addressKind: "pn", mappingSource: "none" };

  if (!lidRoutingEnabled) return pnTarget;
  if (typeof ownLid !== "string" || ownLid.length === 0) return pnTarget;

  const lidJid = directory.lidJidFor(phone);
  if (!lidJid) return pnTarget;

  return { jid: lidJid, addressKind: "lid", mappingSource: "directory" };
}
