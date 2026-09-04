/**
 * The New Conversation directory's shape and its two pure rules.
 *
 * Deliberately free of `server-only` and of every database import: the dialog
 * that renders this directory is a client component, and the grouping and
 * search rules have to be the *same* rules on both sides. The reads that fill
 * these types — and the account filter that scopes them — live in
 * `inbox-contacts.ts`, which is server-only for exactly that reason.
 */

export type InboxContactOption = {
  id: string;
  displayName: string | null;
  participantAddress: string;
  /**
   * Set when this number is already a patient file in this clinic, decided
   * server-side by the system's own authoritative linkage — an existing
   * `conversations.patient_id`, or exact E.164 equality on `patients.phone`.
   * Never re-derived in the browser, and never fuzzy-matched.
   */
  patientId: string | null;
  patientName: string | null;
  patientFileNumber: string | null;
};

export type InboxContactDirectory = {
  contacts: InboxContactOption[];
  /** Contacts synced for the authenticated account, before any paging. */
  total: number;
  /** Of the contacts carried, how many resolve to a clinic patient file. */
  linked: number;
  unlinked: number;
  /** False when no WhatsApp account is currently authenticated for the clinic. */
  accountConnected: boolean;
  /** True when `total` exceeds what was carried. */
  truncated: boolean;
  error: boolean;
};

export const EMPTY_CONTACT_DIRECTORY: InboxContactDirectory = {
  contacts: [],
  total: 0,
  linked: 0,
  unlinked: 0,
  accountConnected: false,
  truncated: false,
  error: false,
};

/**
 * Splits contacts into the two groups the dialog shows.
 *
 * The only input is the server-computed `patientId`. Nothing here inspects a
 * phone number to decide whether somebody is a patient.
 */
export function groupInboxContacts(contacts: ReadonlyArray<InboxContactOption>): {
  clinic: InboxContactOption[];
  whatsapp: InboxContactOption[];
} {
  const clinic: InboxContactOption[] = [];
  const whatsapp: InboxContactOption[] = [];
  for (const contact of contacts) {
    (contact.patientId ? clinic : whatsapp).push(contact);
  }
  return { clinic, whatsapp };
}

/**
 * Does this contact match a free-text query? One predicate for both groups, so
 * a single search box covers the whole directory.
 */
export function contactMatches(contact: InboxContactOption, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  // A typed number may carry spaces, dashes or parentheses that the stored
  // E.164 does not; comparing digits keeps "+90 555" finding "+90555…".
  const digits = normalized.replace(/[^\d]/g, "");
  return [contact.displayName, contact.patientName, contact.patientFileNumber]
    .some((value) => value?.toLocaleLowerCase().includes(normalized) ?? false) ||
    contact.participantAddress.toLocaleLowerCase().includes(normalized) ||
    (digits.length > 0 && contact.participantAddress.replace(/[^\d]/g, "").includes(digits));
}
