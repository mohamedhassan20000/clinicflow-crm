import "server-only";
import { resolveWhatsAppAccountBoundary } from "@/lib/messaging/account-boundary";
import {
  EMPTY_CONTACT_DIRECTORY,
  type InboxContactDirectory,
  type InboxContactOption,
} from "@/lib/messaging/inbox-contact-groups";
import { createClient } from "@/lib/supabase/server";

/**
 * The New Conversation directory: every contact the *currently authenticated*
 * WhatsApp account has synced, split by whether this clinic already knows them.
 *
 * ## Account isolation
 *
 * `whatsapp_contacts` is keyed on `(clinic_id, authenticated_account_id,
 * participant_address)`. This reads it with an equality filter on the account
 * the clinic last proved (`resolveWhatsAppAccountBoundary`), and when no account
 * has ever been proved it reads with a sentinel that matches nothing rather
 * than dropping the filter — so a clinic
 * that has re-paired a *different* phone never sees the previous account's
 * address book, and a clinic with no live pairing sees an empty directory
 * instead of everything.
 *
 * ## What "already in the clinic" means
 *
 * The authoritative linkage model, unchanged and not extended:
 *
 *   1. `conversations.patient_id` — a link already made and stored, scoped to
 *      this clinic and this authenticated account. This is the durable record.
 *   2. `patients.phone = participant_address` — exact equality on the same
 *      normalized E.164 form both columns store. This is the *same* predicate
 *      `record_inbound_whatsapp_message` uses to attach a patient to an
 *      incoming WhatsApp thread, so the badge in this dialog and the linkage
 *      the system performs on its own can never disagree.
 *
 * There is deliberately no fuzzy or partial phone matching here. A contact that
 * does not satisfy one of those two is reported as unlinked, which is the true
 * answer, rather than being guessed into a patient file.
 *
 * Nothing in this module writes: reading the directory creates no conversation,
 * no patient, and no contact→patient link. Those happen only when a staff
 * member explicitly starts a conversation.
 */

export {
  EMPTY_CONTACT_DIRECTORY,
  contactMatches,
  groupInboxContacts,
  type InboxContactDirectory,
  type InboxContactOption,
} from "@/lib/messaging/inbox-contact-groups";

/** Contacts carried into the browser in one payload. */
export const INBOX_CONTACT_PAGE_SIZE = 1_000;

/** Matches nothing; keeps the account filter present when no account is bound. */
const NO_ACCOUNT = "__no_authenticated_account__";

export async function loadInboxContactDirectory(
  clinicId: string,
): Promise<InboxContactDirectory> {
  const supabase = await createClient();
  // The clinic's account boundary, not its live socket: a dropped device must
  // not empty the address book, and it must not widen it either.
  const account = (await resolveWhatsAppAccountBoundary(clinicId)).account;

  const contactResult = await supabase
    .from("whatsapp_contacts")
    .select("id, display_name, participant_address", { count: "exact" })
    .eq("clinic_id", clinicId)
    .eq("authenticated_account_id", account ?? NO_ACCOUNT)
    .order("display_name", { nullsFirst: false })
    .limit(INBOX_CONTACT_PAGE_SIZE);
  if (contactResult.error) return { ...EMPTY_CONTACT_DIRECTORY, error: true };

  const rows = contactResult.data ?? [];
  const total = contactResult.count ?? rows.length;
  if (rows.length === 0) {
    return { ...EMPTY_CONTACT_DIRECTORY, total, accountConnected: Boolean(account) };
  }

  const addresses = [...new Set(rows.map((row) => row.participant_address))];
  // Both reads are bounded by the address list, so neither can walk the clinic.
  const [patientResult, conversationResult] = await Promise.all([
    supabase
      .from("patients")
      .select("id, full_name, phone, file_number")
      .eq("clinic_id", clinicId)
      .in("phone", addresses)
      .eq("is_deleted", false)
      .is("deleted_at", null),
    account
      ? supabase
          .from("conversations")
          .select("participant_address, patient_id")
          .eq("clinic_id", clinicId)
          .eq("channel", "whatsapp")
          .eq("whatsapp_account_id", account)
          .in("participant_address", addresses)
          .not("patient_id", "is", null)
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  // A linkage read that fails must not silently relabel every known patient as
  // an unlinked stranger, so the directory reports the failure instead.
  if (patientResult.error || conversationResult.error) {
    return { ...EMPTY_CONTACT_DIRECTORY, total, accountConnected: Boolean(account), error: true };
  }

  const byPhone = new Map<
    string,
    { id: string; name: string | null; fileNumber: string | null }
  >();
  for (const patient of patientResult.data ?? []) {
    if (!patient.phone || byPhone.has(patient.phone)) continue;
    byPhone.set(patient.phone, {
      id: patient.id,
      name: patient.full_name,
      fileNumber: patient.file_number,
    });
  }
  const linkedByConversation = new Map<string, string>();
  for (const row of (conversationResult.data ?? []) as Array<{
    participant_address: string | null;
    patient_id: string | null;
  }>) {
    if (row.participant_address && row.patient_id) {
      linkedByConversation.set(row.participant_address, row.patient_id);
    }
  }

  const contacts: InboxContactOption[] = rows.map((row) => {
    const patient = byPhone.get(row.participant_address) ?? null;
    const conversationPatientId = linkedByConversation.get(row.participant_address) ?? null;
    const patientId = patient?.id ?? conversationPatientId;
    return {
      id: row.id,
      displayName: row.display_name,
      participantAddress: row.participant_address,
      patientId,
      // Only the patient row carries a name; a conversation link without one
      // still marks the contact as belonging to the clinic.
      patientName: patientId && patient ? patient.name : null,
      patientFileNumber: patientId && patient ? patient.fileNumber : null,
    };
  });

  const linked = contacts.filter((contact) => contact.patientId).length;
  return {
    contacts,
    total,
    linked,
    unlinked: contacts.length - linked,
    accountConnected: Boolean(account),
    truncated: total > contacts.length,
    error: false,
  };
}
