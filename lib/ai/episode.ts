import "server-only";

import {
  closeConversationEpisode,
  createClinicScopedAdminClient,
  resolveConversationEpisode,
} from "@/lib/supabase/admin";

/**
 * P11T — the conversation episode, resolved once and enforced structurally.
 *
 * ## The problem with how P11O expressed isolation
 *
 * P11O made the assistant's context episode-scoped by filtering every read with
 * `.gte(episodeStart)`, where `episodeStart` was `ai_context_reset_at`. That
 * works, and it is why the previous exchange stopped leaking into the prompt.
 * What it cannot do is *stay* working. The guarantee is spread across every
 * read in `patient-reply.ts` — the merged history, the provenance utterances,
 * the language sniff — and it holds only for as long as every future read
 * remembers to opt in. A read added next month that forgets the filter
 * reintroduces the exact contamination P11O was written to end, silently, with
 * no test failing and nothing in the Inbox looking wrong.
 *
 * An invariant that depends on each caller remembering it is not an invariant.
 *
 * ## What this module changes
 *
 * The episode stops being a timestamp the caller carries around and becomes a
 * handle the caller cannot read past. {@link resolveEpisode} returns an
 * {@link EpisodeContext} whose `scope` method is the only way to build a query
 * against the two message tables, and it applies the bound itself. The type is
 * the enforcement: a function that wants episode messages must take an
 * `EpisodeContext`, and taking one means it is already filtered.
 *
 * ## Why the timestamp is still the cut
 *
 * `conversation_episodes.started_at` is written to equal `ai_context_reset_at`
 * by `resolve_conversation_episode`, so the bound this module applies is the
 * identical instant P11O computes. Messages also carry `episode_id` now, but it
 * is *not* the filter: every row written before this migration has a null one,
 * and a filter that silently drops pre-P11T history would change what the
 * assistant can see on threads nobody has closed. The column is there for
 * attribution and audit; the instant is what bounds context, exactly as before.
 *
 * ## What an episode does not bound
 *
 * Anything about the person. `patient_id`, the verified WhatsApp linkage, the
 * identity verification stamp and the patient's file are permanent, live on
 * authoritative rows, and are read without reference to any episode — a closed
 * conversation must never make ClinicFlow forget who the patient is. It also
 * bounds nothing staff see: `lib/messaging/inbox.ts` reads both message tables
 * unfiltered and always will.
 */

/** How an episode ended. The three real endings, plus the reconstructed one. */
export type EpisodeEndReason =
  | "manual_close"
  | "assistant_close"
  | "idle_timeout"
  | "superseded";

/**
 * A resolved, active episode.
 *
 * Hold one of these and you are already inside the boundary; there is no
 * accessor on it that returns the previous episode's anything.
 */
export type EpisodeContext = {
  readonly episodeId: string;
  /**
   * The instant this episode began — the P11O context cut.
   *
   * P11T-HOTFIX — **never null.** A context without a boundary used to be
   * representable, and `scope` silently returned the query unchanged for one:
   * a missing boundary meant "read the whole thread". That is the leak this
   * type now makes unconstructible. `resolve_conversation_episode` always
   * derives a start (`ai_context_reset_at` → caller hint → the conversation's
   * own `created_at` → `now()`), so an episode that resolved at all has one;
   * an episode that did not resolve produces no context, and the reply path
   * fails closed rather than reading past a boundary it could not establish.
   */
  readonly startedAt: string;
  /** True when this call opened the episode, i.e. the thread was resting. */
  readonly opened: boolean;
  /**
   * Bounds a query on `inbound_messages` or `outbound_messages` to this
   * episode.
   *
   * The single place the boundary is applied. `column` names the row's own time
   * — `received_at` inbound, `created_at` outbound — because the two tables
   * disagree about what that column is called and a caller passing the wrong
   * one would filter on nothing.
   *
   * The comparison is `>=`, not `>`: the reopen path stamps the boundary with
   * the triggering message's own `received_at`, and that message is the first
   * turn of the new episode. Excluding it would leave the agent answering a
   * message it cannot see.
   *
   * The bound is applied unconditionally. There is no input to this method,
   * and no state of this object, that returns an unfiltered query.
   */
  scope<Q extends { gte(column: string, value: string): Q }>(
    query: Q,
    column: "received_at" | "created_at",
  ): Q;
};

function buildContext(input: {
  episodeId: string;
  startedAt: string;
  opened: boolean;
}): EpisodeContext {
  const { episodeId, startedAt, opened } = input;
  return {
    episodeId,
    startedAt,
    opened,
    scope(query, column) {
      // Unconditional. The ternary that used to stand here — `startedAt ? … :
      // query` — is the whole of the P11T boundary leak: a falsy boundary
      // degraded every episode-scoped read into a full-thread read, silently,
      // with the episode record beside it looking perfectly correct.
      return query.gte(column, startedAt);
    },
  };
}

/**
 * The authoritative episode as `resolve_conversation_episode` returned it.
 *
 * The RPC re-reads the conversation row under `for update` and derives the
 * start from it, so this — not a conversation object the request loaded
 * earlier — is the boundary of record for the turn.
 */
export type ResolvedEpisode = {
  readonly episodeId: string;
  readonly startedAt: string;
  readonly opened: boolean;
};

/**
 * The context for an episode the RPC has just resolved.
 *
 * The only constructor the patient reply path uses. It cannot produce an
 * unbounded context: `ResolvedEpisode.startedAt` is a `string`, and a
 * resolution that yielded no start yields no `ResolvedEpisode` at all.
 */
export function episodeContextFromResolvedEpisode(
  episode: ResolvedEpisode,
): EpisodeContext {
  return buildContext(episode);
}

/**
 * The episode this turn belongs to, opening one if the thread was resting.
 *
 * Called once at the top of an assistant turn, before anything is read. A Done
 * thread that has just received a message is resting, so this is what restarts
 * it — and because the new episode's `started_at` is the boundary the close
 * drew, the previous exchange is outside it from the first read onwards.
 */
export async function resolveCurrentEpisode(input: {
  clinicId: string;
  conversationId: string;
  /** Fallback start for a thread with no boundary. The triggering message's
   * arrival time, so the message falls inside its own episode. */
  startedAt?: string | null;
}): Promise<ResolvedEpisode | null> {
  const { data, error } = await resolveConversationEpisode({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    startedAt: input.startedAt,
  });
  const row = Array.isArray(data) ? data[0] : null;
  // P11T-HOTFIX — an episode without a start is not an episode. The RPC
  // coalesces four candidates and cannot return null for a row it wrote, so
  // this is the "the RPC did not answer" case, and the only correct response
  // to it is to have no context rather than an unbounded one.
  if (error || !row?.episode_id || !row.started_at) return null;
  return {
    episodeId: row.episode_id,
    startedAt: row.started_at,
    opened: row.opened === true,
  };
}

/**
 * The resolved episode as a context, in one call.
 *
 * Convenience over {@link resolveCurrentEpisode}; callers that need the episode
 * id *and* the context (the reply path attributes messages with the id) take
 * the two-step form.
 */
export async function resolveEpisode(input: {
  clinicId: string;
  conversationId: string;
  startedAt?: string | null;
}): Promise<EpisodeContext | null> {
  const episode = await resolveCurrentEpisode(input);
  return episode ? episodeContextFromResolvedEpisode(episode) : null;
}

/**
 * The episode context for a boundary the caller already holds.
 *
 * The reply path reads `ai_context_reset_at` off the conversation row it has
 * already fetched. When the episode RPC is unavailable — an environment where
 * this migration has not been applied — that timestamp is still the correct
 * cut, and falling back to it keeps the isolation guarantee rather than
 * degrading to an unbounded read. Losing episode *identity* is survivable;
 * losing the *boundary* is not.
 */
export function episodeContextFromBoundary(startedAt: string): EpisodeContext {
  return buildContext({ episodeId: "", startedAt, opened: false });
}

/**
 * An explicitly unbounded read of a thread's messages — **never** for the
 * Patient Assistant.
 *
 * There is one legitimate consumer of a whole thread: the people who work at
 * the clinic. `lib/messaging/inbox.ts` reads both message tables unfiltered and
 * always will, because staff history and assistant memory are different things.
 *
 * This exists so that "read everything" has to be *asked for*, by a name that
 * says what it does, and so that it cannot arrive by accident: the returned
 * value is a {@link UnboundedThreadScope}, which is deliberately **not** an
 * {@link EpisodeContext} — it has no `episodeId` and no `startedAt`, so every
 * function that takes an `EpisodeContext` rejects it at compile time.
 * `lib/ai/patient-reply.ts` must never name it, and a regression test asserts
 * that it does not.
 */
export type UnboundedThreadScope = {
  readonly unbounded: true;
  scope<Q>(query: Q): Q;
};

export function unboundedThreadScopeForStaffHistory(): UnboundedThreadScope {
  return { unbounded: true, scope: (query) => query };
}

/**
 * Ends the thread's active episode with a stated reason.
 *
 * Every ending routes here — a staff member pressing Close thread, the patient
 * saying they need nothing further, the five-minute idle sweep — so that all
 * three produce the identical hard boundary. Best-effort for the same reason
 * every other write on this path is: losing the episode record must never fail
 * the close, and the fallback is `ai_context_reset_at`, which the close path
 * writes independently and which is what bounds context.
 */
export async function endEpisode(input: {
  clinicId: string;
  conversationId: string;
  reason: EpisodeEndReason;
  endedAt?: string;
}): Promise<boolean> {
  try {
    const { data, error } = await closeConversationEpisode({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      reason: input.reason,
      endedAt: input.endedAt,
    });
    if (error) return false;
    const row = Array.isArray(data) ? data[0] : null;
    return row?.closed === true;
  } catch {
    return false;
  }
}

/**
 * Attributes a message row to the episode it was written in.
 *
 * Attribution only — nothing reads this column to decide what the model sees,
 * because rows written before P11T carry a null one. It is what lets a clinic,
 * or a later audit, ask which episode a message belonged to without replaying
 * timestamp arithmetic against a column that has since moved on.
 */
export async function attributeMessageToEpisode(input: {
  clinicId: string;
  episodeId: string;
  table: "inbound_messages" | "outbound_messages";
  messageId: string;
}): Promise<void> {
  if (!input.episodeId) return;
  try {
    await createClinicScopedAdminClient(input.clinicId)
      .from(input.table)
      .update({ episode_id: input.episodeId })
      .eq("id", input.messageId)
      .is("episode_id", null);
  } catch {
    // Attribution is metadata. It never costs the patient their reply.
  }
}
