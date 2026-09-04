import "server-only";

import { logAgentTool } from "@/lib/ai/audit";
import {
  closeIdlePatientAiEpisodes,
  createClinicScopedAdminClient,
} from "@/lib/supabase/admin";

/**
 * P11S — the timer that ends an episode the patient walked away from.
 *
 * ## The gap this fills
 *
 * `conversation-lifecycle.ts` ends an episode when the patient says so. It has
 * never had an answer for the ordinary ending: the assistant asks "هل تحتاج أي
 * مساعدة أخرى؟", the patient has what they came for, and simply stops. Those
 * threads stayed `open` indefinitely — so a message weeks later resumed a
 * finished exchange, and the Inbox showed a working queue nobody was working.
 *
 * ## Where the timer may be armed, and only there
 *
 * One call site: the turn on which `resolveConversationLifecycle` returns
 * `offer_end`, and only once that reply has actually reached the patient. That
 * decision has already established that nothing is outstanding and that a goal
 * concluded, which is what stops this from becoming "close every quiet thread".
 * A half-finished intake, an unanswered clarification, an escalated thread and
 * one a staff member has taken over all reach `continue` instead, and arm
 * nothing.
 *
 * ## Why a stale timer cannot close a live conversation
 *
 * `ai_auto_close_armed_at` is written beside the deadline, and the sweep refuses
 * any thread carrying an inbound message newer than it. Clearing the timer on
 * the next inbound (below) keeps the sweep's working set small; correctness does
 * not depend on that write landing. A patient who is still talking is safe even
 * if every clear is lost.
 *
 * ## Why the sweep is in the database
 *
 * A pg_cron job running the whole decision as one idempotent statement, rather
 * than an application loop: it survives a deploy, it holds no state between
 * runs, it cannot double-close (the same statement clears the deadline it
 * acted on), and it is not polling — one minute of a scheduler is not a busy
 * loop. `/api/cron/patient-episode-idle-close` drives the identical function
 * for environments without the extension.
 */

/** How long a finished episode waits for the patient before it ends itself. */
export const EPISODE_IDLE_CLOSE_MS = 5 * 60 * 1000;

/**
 * Arms the timer on a thread whose goal has concluded and which has just been
 * asked whether anything else is needed.
 *
 * Best-effort, like every other write on the reply path: losing this must never
 * cost the patient their answer, and the worst case is the behaviour that
 * existed before — a thread that stays open.
 */
export async function armEpisodeIdleClose(input: {
  clinicId: string;
  conversationId: string;
  now?: Date;
}): Promise<boolean> {
  const armedAt = input.now ?? new Date();
  const deadline = new Date(armedAt.valueOf() + EPISODE_IDLE_CLOSE_MS);
  try {
    const result = await createClinicScopedAdminClient(input.clinicId)
      .from("conversations")
      .update({
        ai_auto_close_armed_at: armedAt.toISOString(),
        ai_auto_close_after: deadline.toISOString(),
      })
      .eq("id", input.conversationId)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    const armed = !result.error && Boolean(result.data);
    if (armed) {
      await logAgentTool({
        clinicId: input.clinicId,
        actorId: null,
        // Labels and a duration. No patient content ever reaches this line.
        tool: "patient_episode_idle_close_armed",
        params: { minutes: EPISODE_IDLE_CLOSE_MS / 60_000 },
      }).catch(() => undefined);
    }
    return armed;
  } catch {
    return false;
  }
}

/**
 * Disarms the timer because the patient wrote again.
 *
 * Called at the top of every inbound turn. The sweep's `armed_at` guard makes
 * this an optimisation rather than a correctness requirement, which is why it
 * is allowed to fail silently.
 */
export async function clearEpisodeIdleClose(input: {
  clinicId: string;
  conversationId: string;
}): Promise<void> {
  try {
    await createClinicScopedAdminClient(input.clinicId)
      .from("conversations")
      .update({ ai_auto_close_after: null, ai_auto_close_armed_at: null })
      .eq("id", input.conversationId)
      .not("ai_auto_close_after", "is", null);
  } catch {
    // See above: the sweep is safe without this.
  }
}

/**
 * Runs one sweep. Returns how many episodes it ended.
 *
 * The whole decision lives in `close_idle_patient_ai_episodes`, so this and the
 * pg_cron job cannot disagree about what "finished" means.
 */
export async function sweepIdlePatientEpisodes(now?: Date): Promise<number> {
  const result = await closeIdlePatientAiEpisodes(now);
  if (result.error) throw new Error("EPISODE_IDLE_SWEEP_FAILED");
  return Number(result.data ?? 0);
}
