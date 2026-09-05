/**
 * The only component that persists conversational flow state (I-8).
 *
 * ## Why one writer
 *
 * In the engine this replaces, `setConversationAiState` had fourteen call sites
 * across six modules — tools, readers, the turn opener, a roster helper — and
 * any of them could move the conversation. That is how a "read" tool
 * (`prepare_booking`) came to commit a doctor out of appointment history: not
 * because anybody decided it should, but because nothing said it could not.
 *
 * Here the flow engine produces a new {@link FlowState} and this module writes
 * it. Nothing else imports `setConversationFlowState`. A tool that wants to
 * change the conversation returns a {@link StepOutcome} and lets the engine
 * decide — which is the difference between a tool that *reports* and a tool
 * that *acts*.
 *
 * ## Failing closed on a missing column
 *
 * `conversations.ai_flow_state` arrives in a migration that is authored but not
 * applied. A build that ships ahead of its migration must lose the **engine**,
 * not the conversation: {@link flowStateAvailable} probes once per process and
 * {@link loadFlowState} returns `unavailable`, which the runtime answers by
 * handing the turn to the legacy path. The alternative — running V2 with
 * nowhere to persist a stack — would give every turn an empty stack, which
 * looks like "no flow is active" and would silently restart every booking.
 */

import "server-only";

import {
  getConversationFlowState,
  probeConversationFlowStateColumn,
  resetConversationFlowState,
  setConversationFlowState,
} from "@/lib/supabase/admin";
import {
  EMPTY_FLOW_STATE,
  parseFlowState,
  serializeFlowState,
  type FlowState,
} from "@/lib/ai/v2/flow-state";

/** PostgREST's two ways of saying "that column is not there". */
const MISSING_COLUMN = new Set(["42703", "PGRST204", "PGRST202"]);

/**
 * Cached availability probe.
 *
 * One read per process rather than one per turn. A false stays false until the
 * process restarts, which is the correct direction: a deploy applies the
 * migration, and a deploy restarts the process.
 */
let available: boolean | null = null;

export async function flowStateAvailable(clinicId: string): Promise<boolean> {
  if (available !== null) return available;
  try {
    return await probeFlowState(clinicId);
  } catch {
    // A client that throws rather than returning an error — a partially mocked
    // module, a misconfigured key — is "not available this turn". Never cached,
    // and never allowed to propagate: this module sits on the reply path and a
    // throw here would cost the patient their answer over bookkeeping.
    return false;
  }
}

async function probeFlowState(clinicId: string): Promise<boolean> {
  const probe = await probeConversationFlowStateColumn(clinicId);
  if (probe.error && MISSING_COLUMN.has(probe.error.code ?? "")) {
    available = false;
    return false;
  }
  // Any other error is transient — a timeout, a pool exhaustion — and must not
  // latch the engine off for the life of the process. It is treated as "not
  // available *this turn*" without being cached.
  if (probe.error) return false;
  available = true;
  return true;
}

export type FlowStateLoad =
  | { status: "ok"; state: FlowState }
  /** The column is not there, or could not be read. The runtime falls back. */
  | { status: "unavailable" };

export async function loadFlowState(input: {
  clinicId: string;
  conversationId: string;
}): Promise<FlowStateLoad> {
  if (!(await flowStateAvailable(input.clinicId))) return { status: "unavailable" };
  try {
    return await readFlowState(input);
  } catch {
    return { status: "unavailable" };
  }
}

async function readFlowState(input: {
  clinicId: string;
  conversationId: string;
}): Promise<FlowStateLoad> {
  const result = await getConversationFlowState(input);
  if (result.error) return { status: "unavailable" };
  // `parseFlowState` rebuilds against a closed shape and answers a corrupt
  // record with the empty state — which reads as "no active flow", the safe
  // interpretation of "we cannot say what was happening".
  return {
    status: "ok",
    state: result.data?.ai_flow_state
      ? parseFlowState(result.data.ai_flow_state)
      : EMPTY_FLOW_STATE,
  };
}

/**
 * Persists the stack the engine just produced.
 *
 * Replace, never merge — the stack is internally consistent and two partial
 * snapshots could compose into a state that was never true. The RPC takes a row
 * lock, so two workers racing one inbound message serialize rather than
 * clobber.
 *
 * A failed write is reported rather than swallowed. Losing a stage update was
 * survivable in the old engine because the stage was re-derived from collected
 * fields every turn; here the stack *is* the state, and a silently lost write
 * would present the next turn with a booking that had forgotten a step.
 */
export async function saveFlowState(input: {
  clinicId: string;
  conversationId: string;
  state: FlowState;
}): Promise<{ ok: boolean }> {
  if (!(await flowStateAvailable(input.clinicId))) return { ok: false };
  try {
    return await writeFlowState(input);
  } catch {
    return { ok: false };
  }
}

async function writeFlowState(input: {
  clinicId: string;
  conversationId: string;
  state: FlowState;
}): Promise<{ ok: boolean }> {
  const result = await setConversationFlowState({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    // An empty stack is written as null rather than as `{stack: []}`. They mean
    // the same thing and null is what every reset path leaves behind, so
    // normalizing here keeps "no flow" a single representation in the database.
    flowState:
      input.state.stack.length === 0 ? null : serializeFlowState(input.state),
  });
  return { ok: !result.error };
}

/**
 * Clears the stack at an episode boundary.
 *
 * Called from the same places that already clear `ai_collected_data` and
 * `ai_booking_stage` — the assistant close, the staff close, the idle sweep.
 * A new episode carrying the previous episode's flow stack would be this
 * rebuild's own version of the defect it exists to close, one column over.
 *
 * Best-effort by design: a lost reset leaves a stack whose frames are all past
 * their `maxIdle` by the time anybody writes again, and `parkStaleFrames`
 * neutralises those on the next turn. Belt and braces, in that order.
 */
export async function resetFlowState(input: {
  clinicId: string;
  conversationId: string;
}): Promise<void> {
  if (!(await flowStateAvailable(input.clinicId))) return;
  try {
    await Promise.resolve(resetConversationFlowState(input)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Best-effort by design. A lost reset leaves a stack whose frames are all
    // past their `maxIdle` by the time anybody writes again, and
    // `parkStaleFrames` neutralises those on the next turn.
  }
}

/** Test seam. The probe is process-cached; a test needs to clear it. */
export function __resetFlowStateAvailabilityCache(): void {
  available = null;
}
