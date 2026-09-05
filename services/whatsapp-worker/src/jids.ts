import {
  isJidBot,
  isJidBroadcast,
  isJidGroup,
  isJidMetaIa,
  isJidNewsletter,
  isJidStatusBroadcast,
  isJidUser,
  isLidUser,
  jidDecode,
  jidNormalizedUser,
} from "baileys";

/**
 * What kind of address a WhatsApp JID is, and — for the two kinds that are a
 * one-to-one chat — which phone number is on the other end of it.
 *
 * This exists because "a direct chat" is no longer one string shape. WhatsApp has
 * been migrating addressing from phone-number JIDs (`<phone>@s.whatsapp.net`) to
 * LID JIDs (`<opaque>@lid`), and a paired device receives whichever form the
 * server chose for that chat. A filter written as `jid.endsWith("@s.whatsapp.net")`
 * silently drops every LID-addressed patient.
 *
 * The classification below is delegated to Baileys' own predicates rather than
 * re-implemented, so it tracks whatever the installed version considers a user, a
 * group, a broadcast or a newsletter.
 */

export type JidKind =
  /** `<phone>@s.whatsapp.net` (or its legacy `@c.us` spelling): a direct chat. */
  | "pn"
  /** `<opaque>@lid`: also a direct chat, but the user part is *not* a phone. */
  | "lid"
  | "group"
  | "status"
  | "broadcast"
  | "newsletter"
  /** Meta AI and the other first-party bots. Not a patient. */
  | "bot"
  | "unknown";

/**
 * Which of WhatsApp's address spaces a JID belongs to.
 *
 * Order matters: `status@broadcast` is also a broadcast, Meta AI's `@c.us` JID
 * would otherwise pass as a phone-number chat, and the legacy `@c.us` spelling
 * only reads as a user after normalization.
 */
export function classifyJid(jid: string | null | undefined): JidKind {
  if (typeof jid !== "string" || jid.length === 0) return "unknown";
  if (isJidStatusBroadcast(jid)) return "status";
  if (isJidGroup(jid)) return "group";
  if (isJidBroadcast(jid)) return "broadcast";
  if (isJidNewsletter(jid)) return "newsletter";
  if (isJidMetaIa(jid) || isJidBot(jid)) return "bot";
  if (isLidUser(jid)) return "lid";
  if (isJidUser(jidNormalizedUser(jid))) return "pn";
  return "unknown";
}

/** The two kinds a patient conversation can legitimately arrive on. */
export function isDirectChatKind(kind: JidKind): kind is "pn" | "lid" {
  return kind === "pn" || kind === "lid";
}

/**
 * `20100000000:12@s.whatsapp.net` → `+20100000000`.
 *
 * Only ever applied to a phone-number JID. Passing an `@lid` returns null by
 * construction: `jidNormalizedUser` keeps the `lid` server, `isJidUser` rejects
 * it, and the caller is forced to resolve the number some other way instead of
 * publishing an opaque LID identifier as if it were a phone number.
 */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (typeof jid !== "string") return null;
  const normalized = jidNormalizedUser(jid);
  if (!isJidUser(normalized)) return null;
  const user = jidDecode(normalized)?.user;
  return user && /^\d{6,20}$/.test(user) ? `+${user}` : null;
}

/** The device-stripped user part, so `x:3@lid` and `x@lid` are one key. */
function lidKey(jid: string | null | undefined): string | null {
  if (typeof jid !== "string" || !isLidUser(jid)) return null;
  const user = jidDecode(jid)?.user;
  return user && user.length > 0 ? user : null;
}

/** Stable, device-stripped LID spelling safe to persist as an opaque key. */
export function canonicalLidJid(jid: string | null | undefined): string | null {
  const key = lidKey(jid);
  return key ? `${key}@lid` : null;
}

export type LidMapping = { lid: string; phone: string };

/**
 * The LID → phone-number mapping for one session.
 *
 * Baileys 6.7.x has no mapping store of its own, so the worker keeps one. Every
 * entry comes from something WhatsApp itself asserted alongside a LID:
 *
 *   - `sender_pn` / `participant_pn` on an incoming message stanza, surfaced by
 *     Baileys as `key.senderPn` / `key.participantPn`,
 *   - the `chats.phoneNumberShare` event, which Baileys emits with exactly this
 *     pair when a contact shares their number,
 *   - a contact record that carries both spellings of the same identity.
 *
 * Nothing is ever derived from the LID's own digits. They are an opaque server
 * identifier, and treating them as a phone number would attribute a patient's
 * message to whatever unrelated number happened to match.
 *
 * The directory itself is an in-memory per-session index. Newly asserted pairs
 * are drained to the clinic-scoped durable mapping table, and a restored session
 * hydrates that table before opening its socket. That persistence is essential
 * for history batches whose LID and PN assertions arrive at different times.
 */
export class LidDirectory {
  private readonly phoneByLid = new Map<string, string>();
  private readonly newlyAsserted = new Map<string, LidMapping>();
  /**
   * The same assertions, indexed the other way, for outbound address selection.
   *
   * Inbound needs LID → phone ("who wrote this?"); outbound needs phone → LID
   * ("how is this person addressed?"). Both directions are read off the *same*
   * asserted pair, so nothing here is known that `phoneByLid` did not already
   * know — this is an index, not a second source of truth.
   */
  private readonly lidByPhone = new Map<string, string>();

  /** Records `lidJid` and `pnJid` as the same person, if both are usable. */
  remember(lidJid: string | null | undefined, pnJid: string | null | undefined): void {
    const key = lidKey(lidJid);
    const phone = phoneFromJid(pnJid);
    if (!key || !phone) return;
    const existing = this.phoneByLid.get(key);
    // A LID is an identity assertion, not a mutable label. Never overwrite a
    // conflicting pair: doing so could merge two people's conversations.
    if (existing && existing !== phone) return;
    this.phoneByLid.set(key, phone);
    this.lidByPhone.set(phone, key);
    if (!existing) this.newlyAsserted.set(key, { lid: `${key}@lid`, phone });
  }

  /** The phone number behind a LID, or null if this session never learned it. */
  lookup(lidJid: string | null | undefined): string | null {
    const key = lidKey(lidJid);
    return key ? this.phoneByLid.get(key) ?? null : null;
  }

  /**
   * The `<user>@lid` address WhatsApp asserted for a phone number, or null.
   *
   * Null is the normal answer for a contact this session has only ever seen as a
   * phone number, and the caller must fall back to the PN address rather than
   * inventing a LID. A LID is an opaque server identifier with no derivable
   * relationship to the digits of a phone number: there is no arithmetic, hash
   * or prefix that turns one into the other, so a "guess" here would simply be
   * some unrelated person's address.
   */
  lidJidFor(phone: string | null | undefined): string | null {
    if (typeof phone !== "string") return null;
    const key = this.lidByPhone.get(phone);
    return key ? `${key}@lid` : null;
  }

  /** New WhatsApp-asserted pairs since the last drain, once each. */
  takeNewMappings(): LidMapping[] {
    const mappings = [...this.newlyAsserted.values()];
    this.newlyAsserted.clear();
    return mappings;
  }

  get size(): number {
    return this.phoneByLid.size;
  }
}

/**
 * The names WhatsApp has reported for the people this session talks to.
 *
 * Three sources feed it, in descending order of authority: the name the *clinic*
 * saved for the contact on their own phone (`contact.name`), the name the contact
 * publishes for themselves (`contact.notify`, and `pushName` on a message), and
 * a verified business name.
 *
 * What this is not: identity. A display name is chosen by whoever is typing and
 * can be anything at all, so nothing downstream may match on it, resolve a
 * patient by it, or treat it as evidence of who someone is. The phone number
 * remains the only communication identity, and the patient link remains a
 * separate, staff-reviewable fact. This is a label so a clinic sees "Fatima
 * Ahmed" in the inbox instead of a bare number.
 */
export class NameDirectory {
  private readonly byPhone = new Map<string, { name: string; rank: number }>();

  /** Records a name for a phone number, keeping the most authoritative one. */
  remember(phone: string | null | undefined, name: unknown, rank: number): void {
    if (typeof phone !== "string" || phone.length === 0) return;
    if (typeof name !== "string") return;
    const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 120);
    if (trimmed.length === 0) return;
    const existing = this.byPhone.get(phone);
    if (existing && existing.rank <= rank) return;
    this.byPhone.set(phone, { name: trimmed, rank });
  }

  /** Learns from a Baileys contact record, whichever spelling it carries. */
  rememberContact(contact: {
    id?: string | null;
    jid?: string | null;
    lid?: string | null;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
  }, directory: LidDirectory): void {
    const phone =
      phoneFromJid(contact.jid) ??
      phoneFromJid(contact.id) ??
      directory.lookup(contact.lid) ??
      directory.lookup(contact.id);
    if (!phone) return;
    this.remember(phone, contact.name, 0);
    this.remember(phone, contact.verifiedName, 1);
    this.remember(phone, contact.notify, 2);
  }

  lookup(phone: string | null | undefined): string | null {
    if (typeof phone !== "string") return null;
    return this.byPhone.get(phone)?.name ?? null;
  }

  get size(): number {
    return this.byPhone.size;
  }
}
