import "server-only";

import {
  boundaryFailsClosed,
  resolveWhatsAppAccountBoundary,
} from "@/lib/messaging/account-boundary";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";

export type ConversationScopeError = { code: string; message: string };

export const ACCOUNT_SCOPE_MISMATCH: ConversationScopeError = {
  code: "ACCOUNT_SCOPE_MISMATCH",
  message: "The conversation is not in the current WhatsApp account scope.",
};

export type ScopedConversation = { id: string; patient_id: string | null };

/**
 * The one place that decides whether an Inbox conversation belongs to the
 * clinic *and* to its current WhatsApp account.
 *
 * ### Why this cannot be an authenticated table read
 *
 * `whatsapp_account_isolation_conversations` (2026-09-07) is a *restrictive*
 * policy whose account branch is chosen by
 * `exists (select 1 from public.clinic_channels ...)`. `clinic_channels` has
 * RLS enabled with no policy at all — deny-all for `authenticated`, on purpose,
 * because it holds channel credentials. So for a staff session that probe is
 * always false, the predicate falls to its `else whatsapp_account_id is null`
 * branch, and every conversation belonging to the *live* linked account is
 * invisible to a direct `from("conversations")` read.
 *
 * The Inbox list does not notice, because it comes from the
 * `get_inbox_conversation_summaries` security-definer RPC, which does see
 * `clinic_channels` and therefore applies the *correct* account branch. That is
 * the split-brain: the thread is on screen, and a feature that re-authorizes it
 * through RLS concludes it does not exist. P16 fixed it for the thread and its
 * media; this function is that same boundary, shared, so the next feature that
 * needs "is this conversation mine?" does not reintroduce it a third time.
 *
 * Nothing is loosened. Ownership is still proved before a service read happens:
 * the clinic must match, and the conversation must be in the clinic's account
 * boundary — an exact `whatsapp_account_id` whenever an account has ever been
 * proved for it, and the legacy NULL scope only for a clinic that has never had
 * one. That boundary is identity, not connection: a device that dropped a
 * minute ago does not widen it (the regression this replaced), a clinic
 * mid-pairing with no proved identity fails closed, and no legacy NULL row is
 * ever adopted into a linked account.
 */
export async function authorizeAccountScopedConversation(input: {
  clinicId: string;
  conversationId: string;
  /**
   * Accepted for call-site compatibility and deliberately ignored. The account
   * boundary is identity state; which transport is currently active says
   * nothing about it. See `lib/messaging/account-boundary.ts`.
   */
  provider?: Database["public"]["Enums"]["messaging_provider"] | null;
}): Promise<
  | {
      conversation: ScopedConversation;
      client: ReturnType<typeof createClinicScopedAdminClient>;
      error: null;
    }
  | { conversation: null; client: null; error: ConversationScopeError }
> {
  const boundary = await resolveWhatsAppAccountBoundary(input.clinicId);
  // Fails closed before a service client exists at all: a clinic with a
  // boundary but no proved account has no scope to read within.
  if (boundaryFailsClosed(boundary)) {
    return { conversation: null, client: null, error: ACCOUNT_SCOPE_MISMATCH };
  }

  const client = createClinicScopedAdminClient(input.clinicId);
  let query = client
    .from("conversations")
    .select("id, patient_id")
    .eq("clinic_id", input.clinicId)
    .eq("id", input.conversationId)
    .eq("channel", "whatsapp");
  query = boundary.account
    ? query.eq("whatsapp_account_id", boundary.account)
    : query.is("whatsapp_account_id", null);
  const authorized = await query.maybeSingle();
  if (authorized.error || !authorized.data) {
    return {
      conversation: null,
      client: null,
      error:
        (authorized.error as ConversationScopeError | null) ??
        ACCOUNT_SCOPE_MISMATCH,
    };
  }
  return {
    conversation: authorized.data as ScopedConversation,
    client,
    error: null,
  };
}
