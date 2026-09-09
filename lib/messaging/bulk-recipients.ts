/**
 * Who a bulk send can go to, merged from the three lists the Inbox already
 * holds — and merged *once*, so the same person cannot be written to twice.
 *
 * Deliberately free of `server-only` and of every database import, for the same
 * reason `bulk-send-plan.ts` is: the picker is a client component and the
 * merge/dedupe/search rules have to be the identical rules on both sides. This
 * module reads three payloads that `loadInboxData` already returns and adds no
 * source of its own.
 *
 * ## The three sources
 *
 *   * **Conversation** — a live Inbox thread. `conversations.participant_address`
 *     is the address, and the thread already exists, so nothing has to be
 *     opened to write to it.
 *   * **Contact** — a row of `whatsapp_contacts` for the clinic's proved
 *     WhatsApp account, as `lib/messaging/inbox-contacts.ts` loads it for the
 *     New Conversation directory. Same account boundary, same linkage rule.
 *   * **Patient** — a `patients` row of this clinic with a phone number on it.
 *
 * ## The deduplication rule
 *
 * One recipient per destination number, and the destination number is the
 * comparison key: `digitsOf`, i.e. the address with every non-digit removed, so
 * a stored `+90 555 111 22 33` and a stored `+905551112233` are one person.
 * When the same number appears in more than one source the *earlier* source
 * wins, in the order Conversation → Contact → Patient, because that is the
 * order of decreasing certainty about the address actually being reachable: an
 * open thread has demonstrably carried WhatsApp messages, a synced contact is
 * on the account's own address book, and a patient phone is whatever a
 * receptionist typed into a file.
 *
 * ## What this is *not*
 *
 * This is recipient addressing and nothing else. Collapsing two rows onto one
 * number does not link a contact to a patient file, does not resolve an
 * identity, does not write anything, and is never read back as evidence that a
 * number belongs to a person. The one authoritative linkage model lives in
 * `inbox-contacts.ts` and is unchanged; where a `patientId` appears below it
 * was computed there and is carried, never derived here.
 */

export type BulkRecipientSource = "conversation" | "contact" | "patient";

export type BulkRecipient = {
  /** Stable selection key. Unique per recipient, not per source row. */
  key: string;
  source: BulkRecipientSource;
  /**
   * The existing Inbox thread, when this recipient came from one. `null` for a
   * contact or patient, whose thread is opened by the server at send time
   * through the same path the New Conversation dialog uses.
   */
  conversationId: string | null;
  /** The WhatsApp destination, exactly as stored. Never reformatted. */
  address: string;
  /** What to call this person in the list. */
  name: string;
  /** File number when there is one, so two identical names stay separable. */
  fileNumber: string | null;
};

/**
 * The comparison key for "the same destination".
 *
 * Digits only. Nothing here parses, validates or infers a country — it is a
 * fold for equality, not a phone-number implementation.
 */
export function digitsOf(address: string | null | undefined): string {
  return (address ?? "").replace(/\D/g, "");
}

/**
 * The shortest thing that could be a real destination.
 *
 * Below this a value is a placeholder, an extension, or a typo, and a recipient
 * with no usable destination must be *excluded* rather than offered and then
 * silently skipped — the picker's whole claim is that the people in it can be
 * written to.
 */
const MIN_DESTINATION_DIGITS = 7;

export function hasUsableDestination(address: string | null | undefined): boolean {
  return digitsOf(address).length >= MIN_DESTINATION_DIGITS;
}

/** The conversation fields the merge reads. Nothing clinical. */
export type BulkRecipientConversation = {
  id: string;
  sender: string | null;
  patientName: string | null;
  displayName: string | null;
  patientFileNumber: string | null;
  status: string;
};

/** The contact-directory fields the merge reads. */
export type BulkRecipientContact = {
  id: string;
  participantAddress: string;
  displayName: string | null;
  patientName: string | null;
  patientFileNumber: string | null;
};

/** The patient fields the merge reads. */
export type BulkRecipientPatient = {
  id: string;
  name: string;
  phone: string;
  fileNumber: string;
};

/**
 * Every distinct person the clinic can bulk-send to, deduplicated by number.
 *
 * `fallbackName` is what an address with no name at all is called; the caller
 * passes its own translated string so this stays free of i18n.
 *
 * Closed conversations are still offered: the existing plan skips them with a
 * stated reason at send time, and hiding them here would replace an explained
 * skip with an unexplained absence.
 */
export function buildBulkRecipients(input: {
  conversations: readonly BulkRecipientConversation[];
  contacts: readonly BulkRecipientContact[];
  patients: readonly BulkRecipientPatient[];
  fallbackName: string;
}): BulkRecipient[] {
  const byNumber = new Map<string, BulkRecipient>();

  const add = (recipient: BulkRecipient) => {
    if (!hasUsableDestination(recipient.address)) return;
    const key = digitsOf(recipient.address);
    // First source wins: the map is filled in decreasing order of certainty.
    if (byNumber.has(key)) return;
    byNumber.set(key, recipient);
  };

  for (const conversation of input.conversations) {
    add({
      key: `conversation:${conversation.id}`,
      source: "conversation",
      conversationId: conversation.id,
      address: conversation.sender ?? "",
      name:
        conversation.patientName ??
        conversation.displayName ??
        conversation.sender ??
        input.fallbackName,
      fileNumber: conversation.patientFileNumber,
    });
  }

  for (const contact of input.contacts) {
    add({
      key: `contact:${contact.id}`,
      source: "contact",
      conversationId: null,
      address: contact.participantAddress,
      name:
        contact.patientName ??
        contact.displayName ??
        contact.participantAddress ??
        input.fallbackName,
      fileNumber: contact.patientFileNumber,
    });
  }

  for (const patient of input.patients) {
    add({
      key: `patient:${patient.id}`,
      source: "patient",
      conversationId: null,
      address: patient.phone,
      name: patient.name || input.fallbackName,
      fileNumber: patient.fileNumber,
    });
  }

  return [...byNumber.values()];
}

/**
 * Free-text match over one recipient: name, file number, or number.
 *
 * The number is matched on digits as well as literally, so a query typed with
 * spaces or a leading `+` still finds a stored E.164 — the same rule
 * `contactMatches` applies in the New Conversation directory.
 */
export function bulkRecipientMatches(recipient: BulkRecipient, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  if (
    [recipient.name, recipient.fileNumber].some(
      (value) => value?.toLocaleLowerCase().includes(normalized) ?? false,
    )
  ) {
    return true;
  }
  if (recipient.address.toLocaleLowerCase().includes(normalized)) return true;
  const digits = digitsOf(normalized);
  return digits.length > 0 && digitsOf(recipient.address).includes(digits);
}
