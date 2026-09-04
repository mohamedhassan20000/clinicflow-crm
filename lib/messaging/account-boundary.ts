import "server-only";

import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

/**
 * Which WhatsApp account's conversations this clinic is allowed to see.
 *
 * ## Why this is not "which account is connected"
 *
 * Manual QA: a clinic whose linked device was up saw its three live threads;
 * the moment the device dropped, the Inbox filled with legacy imported
 * conversations, and reconnecting hid them again. The boundary was being read
 * off `clinic_channels` — the *transport* row, which the worker deletes on
 * teardown (`Store.removeChannel`), which `disconnectLinkedDeviceSession`
 * deletes outright, and which is momentarily `pending` on every re-pair. So a
 * connection event was silently re-deciding an identity question, and the
 * `else whatsapp_account_id is null` fallback — meant for clinics that have
 * never linked anything — was being handed to clinics that simply had a socket
 * down.
 *
 * A temporary connection problem is transport state. Which WhatsApp account
 * this clinic *is* is identity state, and it lives in two durable places that
 * no disconnect path touches:
 *
 *   1. `whatsapp_linked_device_sessions.authenticated_account_id` — the Baileys
 *      PN JID the worker proved and bound. One row per clinic.
 *   2. `whatsapp_linked_accounts` — the durable ledger, newest `last_seen_at`
 *      first, which still names the account after a session row is rebuilt.
 *
 * This module is the single TypeScript reader of that rule, and it is the same
 * rule `current_whatsapp_account_boundary()` /
 * `whatsapp_account_boundary_required()` apply in SQL. The two must not drift:
 * an authenticated read and a service read that disagree about the boundary is
 * exactly the split-brain `conversation-scope.ts` documents.
 *
 * Nothing here is loosened. A clinic that is mid-pairing — a `linked_device`
 * channel row exists in any state, but no account has been proved — is
 * `required` with a `null` account, which every caller must treat as *fail
 * closed*, never as the legacy scope.
 */
export type WhatsAppAccountBoundary = {
  /** The proved account this clinic is scoped to, or null. */
  account: string | null;
  /**
   * Whether an account boundary applies at all. False only for a clinic that
   * has never proved an account and holds no linked-device channel — the one
   * case where the legacy `whatsapp_account_id is null` scope is correct.
   */
  required: boolean;
};

/** No account boundary is known and none applies: the legacy NULL scope. */
export const LEGACY_ACCOUNT_BOUNDARY: WhatsAppAccountBoundary = {
  account: null,
  required: false,
};

/** A boundary applies but no account is proved: read nothing. */
export function boundaryFailsClosed(boundary: WhatsAppAccountBoundary): boolean {
  return boundary.required && boundary.account === null;
}

export async function resolveWhatsAppAccountBoundary(
  clinicId: string,
): Promise<WhatsAppAccountBoundary> {
  const client = createClinicScopedAdminClient(clinicId);
  const [session, ledger, channel] = await Promise.all([
    client
      .from("whatsapp_linked_device_sessions")
      .select("authenticated_account_id")
      .eq("clinic_id", clinicId)
      .maybeSingle(),
    client
      .from("whatsapp_linked_accounts")
      .select("authenticated_account_id, last_seen_at, first_linked_at")
      .eq("clinic_id", clinicId)
      .order("last_seen_at", { ascending: false })
      .order("first_linked_at", { ascending: false })
      .limit(1),
    client
      .from("clinic_channels")
      .select("provider")
      .eq("clinic_id", clinicId)
      .eq("channel", "whatsapp")
      .eq("provider", "linked_device")
      .limit(1),
  ]);

  // A read failure must not be reported as "this clinic has no boundary" —
  // that is the legacy scope, and handing it out on a transient database error
  // is the same leak by another route. It fails closed instead.
  if (session.error || ledger.error || channel.error) {
    return { account: null, required: true };
  }

  const account =
    session.data?.authenticated_account_id ??
    (ledger.data ?? [])[0]?.authenticated_account_id ??
    null;
  const hasLinkedChannel = (channel.data ?? []).length > 0;
  return { account, required: account !== null || hasLinkedChannel };
}
