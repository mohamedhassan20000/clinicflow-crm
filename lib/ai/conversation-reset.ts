import "server-only";

import { logAgentTool } from "@/lib/ai/audit";
import { endEpisode, type EpisodeEndReason } from "@/lib/ai/episode";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { resetFlowState } from "@/lib/ai/v2/store";

/**
 * P11N — forgetting a conversation without forgetting the patient.
 *
 * ## What a "closed thread" used to mean
 *
 * Exactly one column: `conversations.status`. Everything the patient assistant
 * had been in the middle of — the fields it had collected, the question it was
 * waiting on, the booking rung it had reached, the draft reply sitting in
 * `ai_suggested_replies`, the escalation latch — survived untouched. When the
 * same number wrote again the inbound RPC flipped `status` back to `open`, the
 * agent re-read all of it, and the patient was handed the middle of a
 * conversation they had finished days earlier.
 *
 * ## The distinction this module draws
 *
 * *Conversational state* is what the assistant is currently doing. It is
 * per-episode, worthless once the episode ends, and it is what gets cleared:
 *
 *   * `ai_collected_data` — normalized values gathered during this exchange;
 *   * `ai_pending_clarification` — the one question outstanding;
 *   * `ai_booking_stage` — the stage, the latches, the offered doctors/days/
 *     slots and the repeated-ask signature;
 *   * `ai_escalated_at` / `ai_escalation_reason` — a handoff belongs to the
 *     episode that caused it; a new message is not a continuation of it;
 *   * `ai_paused_at` — "a staff member is mid-sentence on this thread" cannot
 *     outlive the thread they closed;
 *   * `ai_last_replied_at` — the auto-send claim stamp, so the next episode
 *     starts unclaimed;
 *   * P11S `ai_auto_close_after` / `ai_auto_close_armed_at` — the five-minute
 *     idle timer, which describes an episode that has now ended by another
 *     route and must not fire against the next one;
 *   * pending `ai_suggested_replies` — a draft written for a finished exchange
 *     must never be sendable afterwards. Superseded, not deleted: the audit
 *     trail of what the assistant proposed stays intact.
 *
 * P11O adds the one that mattered most and was missing: `ai_context_reset_at`,
 * the instant the episode ended. Clearing the state columns above forgets what
 * the assistant was *doing*; it does not forget what it *said*, because the
 * model's context is assembled by reading the thread's own messages
 * (`loadHistory` in `lib/ai/patient-reply.ts`). A closed thread that reopened
 * still handed the model the whole previous exchange — the department question,
 * the names typed during a previous episode — and the model continued it. The
 * boundary is what makes the transcript episode-scoped:
 *
 *     messages older than ai_context_reset_at → visible to staff, invisible
 *                                               to the model.
 *
 * Nothing is deleted, and nothing about the Inbox changes. Message history
 * persists for humans; assistant conversational memory does not.
 *
 * *Permanent state* is everything about the person, and none of it is touched:
 * `patient_id` and `patient_link_status` (the thread stays linked to the same
 * file), `display_name`, `identity_verified_at` (a proven identity does not
 * become unproven), every row in `inbound_messages` and `outbound_messages`,
 * every staged `ai_patient_intakes` row awaiting staff review, and every
 * appointment. Nothing here deletes a message and nothing here deletes a
 * patient.
 *
 * ## Why a direct update rather than the RPC
 *
 * `set_conversation_ai_state` merges `ai_collected_data` with `||` and treats a
 * null argument as "leave alone", so it has no expressible way to say *empty*.
 * Widening it would be a migration for a statement the service-role client can
 * already make safely and clinic-scoped. Every write below is best-effort for
 * the same reason the stage writes are: losing a reset must never fail the
 * close, and the worst case is the state the caller was already living with.
 */

export type ConversationResetReason =
  | "manual_close"
  | "assistant_close"
  | "reopened";

export type ConversationResetResult = {
  ok: boolean;
  /** Pending drafts that were superseded. Zero is the ordinary case. */
  supersededSuggestions: number;
};

/**
 * Clears every piece of assistant conversational state on one thread.
 *
 * Does not touch `status`: resetting and closing are separate facts, and the
 * reopen path needs the reset without the close.
 */
export async function resetConversationAssistantState(input: {
  clinicId: string;
  conversationId: string;
  reason: ConversationResetReason;
  /**
   * The instant the ended episode is cut at. Defaults to now, which is right
   * for every close: the goodbye has already been written, so it falls before
   * the boundary and cannot be read back on the next turn.
   *
   * The reopen path passes the triggering message's `received_at` instead, so
   * that the message which reopened the thread is itself inside the new
   * episode rather than one millisecond outside it.
   */
  boundaryAt?: string;
}): Promise<ConversationResetResult> {
  const client = createClinicScopedAdminClient(input.clinicId);
  const boundaryAt = input.boundaryAt ?? new Date().toISOString();
  let ok = true;
  let superseded = 0;

  // The V2 flow stack, cleared with everything else.
  //
  // Written as its own call rather than another key in the update below,
  // because `ai_flow_state` arrives in a migration that is authored but not
  // applied: naming the column here would make every reset fail on a build that
  // ships ahead of it. `resetFlowState` probes for the column and does nothing
  // when it is absent, so this is safe before the migration and correct after.
  //
  // It belongs *here* — the one function all three episode boundaries go
  // through (staff Close Thread, the reopen path, the assistant's own close) —
  // rather than at one of the call sites. It previously ran at exactly one of
  // them, so a thread a staff member closed kept its stack, and the next
  // episode was told "we can continue the booking we started earlier" about a
  // booking from the episode before.
  await resetFlowState({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
  });

  // The conversational state itself, always cleared outright.
  try {
    const cleared = await client
      .from("conversations")
      .update({
        ai_collected_data: {},
        ai_pending_clarification: null,
        ai_booking_stage: null,
        ai_escalated_at: null,
        ai_escalation_reason: null,
        ai_paused_at: null,
        ai_last_replied_at: null,
        // P11S — the idle-close timer belongs to the episode that armed it. A
        // thread that has already ended has nothing left to close.
        ai_auto_close_after: null,
        ai_auto_close_armed_at: null,
      })
      .eq("id", input.conversationId)
      .select("id")
      .maybeSingle();
    if (cleared.error || !cleared.data) ok = false;
  } catch {
    ok = false;
  }

  // P11O — the boundary, written separately because a reopen must never *move*
  // one a close already drew. The close happened at the end of the previous
  // episode; the reopen happens after the first message of the new one, so
  // re-stamping it there would cut that message out of its own episode. A
  // reopen therefore only fills in a boundary that is missing, which is exactly
  // the legacy case: a thread closed before this column existed. Matching no
  // row is then the ordinary outcome, not a failure.
  try {
    const stamp = client
      .from("conversations")
      .update({ ai_context_reset_at: boundaryAt })
      .eq("id", input.conversationId);
    const scoped =
      input.reason === "reopened" ? stamp.is("ai_context_reset_at", null) : stamp;
    const stamped = await scoped.select("id").maybeSingle();
    if (stamped.error) ok = false;
    else if (!stamped.data && input.reason !== "reopened") ok = false;
  } catch {
    ok = false;
  }

  try {
    const drafts = await client
      .from("ai_suggested_replies")
      .update({ status: "superseded" })
      .eq("conversation_id", input.conversationId)
      .eq("status", "pending")
      .select("id");
    if (drafts.error) ok = false;
    else superseded = drafts.data?.length ?? 0;
  } catch {
    ok = false;
  }

  // P11T — end the durable episode record, with the reason it ended.
  //
  // Every ending routes through here, so a staff Close, the patient saying they
  // need nothing more, and the five-minute idle sweep all produce the identical
  // hard boundary — which is the requirement. A `reopened` reset is not an
  // ending: it is the repair path for a thread closed before this existed, and
  // ending an episode there would close the one the next turn is about to open.
  //
  // Best-effort, like every other write here. `ai_context_reset_at` above is
  // what bounds model context; this is what makes the boundary auditable.
  if (input.reason !== "reopened") {
    const endReason: EpisodeEndReason =
      input.reason === "manual_close" ? "manual_close" : "assistant_close";
    await endEpisode({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      reason: endReason,
      endedAt: boundaryAt,
    });
  }

  try {
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_conversation_reset",
      // Labels and counts only. No patient content ever reaches this line.
      params: { reason: input.reason, ok, superseded_drafts: superseded },
    });
  } catch {
    // An audit line is never load-bearing.
  }

  return { ok, supersededSuggestions: superseded };
}

/**
 * Closes a thread and resets it, in that order.
 *
 * The order matters: a message that lands between the two writes must find a
 * closed thread with stale state (which the reset that follows repairs, and
 * which the reopen path resets again) rather than an open thread the assistant
 * would answer from a half-cleared record.
 */
export async function closeAndResetConversation(input: {
  clinicId: string;
  conversationId: string;
  reason: ConversationResetReason;
}): Promise<ConversationResetResult> {
  const client = createClinicScopedAdminClient(input.clinicId);
  const closedAt = new Date().toISOString();
  try {
    await client
      .from("conversations")
      .update({ status: "closed", status_updated_at: closedAt })
      .eq("id", input.conversationId);
  } catch {
    // Best-effort, exactly like the reset below.
  }
  // The same instant for both writes, so an AI auto-close and a staff close
  // leave the record in identical shape.
  return resetConversationAssistantState({ ...input, boundaryAt: closedAt });
}
