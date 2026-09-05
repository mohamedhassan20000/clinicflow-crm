/**
 * Loop and dead-end safeguards for the Staff Assistant step budget.
 *
 * Raising `staff_clinical_summary.maxSteps` from 8 to 12 (study §12.6) buys the
 * headroom a real clinical turn needs — T2 measures at 5–6 steps with a
 * clarification or a schema miss able to exhaust the rest. It also buys four
 * more steps for a model that has stopped making progress to spend. These two
 * conditions bound that:
 *
 *   - **Repeated identical tool call.** The same tool with the same arguments,
 *     three times in a turn, is not a retry strategy; it is a loop. The second
 *     call can be a legitimate retry after a transient failure (the document
 *     tool's description explicitly prescribes exactly one), so the threshold is
 *     three.
 *   - **Repeated failure.** Four failed tool calls in a turn — validation
 *     errors, thrown tool errors — means the model is not converging on the
 *     schema, and every further step spends the clinic's budget to learn the
 *     same thing.
 *
 * Both are **recoverable stops**, not aborts: they end the tool loop, so the
 * model produces its final message from what it already has, the turn is
 * persisted, and the user gets an answer plus whatever the assistant did
 * manage. Nothing is thrown, no error surface changes, and the budget ledger
 * reconciles the turn as the success it is.
 *
 * Pure module by design — no `server-only`, no SDK types in the signatures — so
 * the two thresholds are testable against synthetic step traces.
 */

export const STAFF_LOOP_GUARD = {
  /** Identical (tool, arguments) invocations tolerated inside one turn. */
  maxIdenticalToolCalls: 3,
  /** Failed tool calls tolerated inside one turn. */
  maxFailedToolCalls: 4,
} as const;

export type LoopGuardToolCall = { toolName: string; input?: unknown };

export type LoopGuardStep = {
  toolCalls?: readonly LoopGuardToolCall[];
  content?: readonly { type?: string }[];
};

function callSignature(call: LoopGuardToolCall): string {
  let args = "";
  try {
    // Key order is whatever the model emitted; two calls that differ only in key
    // order are the same call, so the signature sorts them.
    args = JSON.stringify(call.input, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort())
        : value,
    ) ?? "";
  } catch {
    args = "[unserializable]";
  }
  return `${call.toolName}:${args}`;
}

export type LoopGuardVerdict = {
  stop: boolean;
  reason: "repeated_tool_call" | "repeated_tool_failure" | null;
  identicalCalls: number;
  failedCalls: number;
};

/** Evaluates the guard over the steps taken so far in one turn. */
export function evaluateStaffLoopGuard(
  steps: readonly LoopGuardStep[],
): LoopGuardVerdict {
  const counts = new Map<string, number>();
  let failed = 0;
  let maxIdentical = 0;

  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const key = callSignature(call);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > maxIdentical) maxIdentical = next;
    }
    for (const part of step.content ?? []) {
      if (part?.type === "tool-error") failed += 1;
    }
  }

  if (maxIdentical >= STAFF_LOOP_GUARD.maxIdenticalToolCalls) {
    return {
      stop: true,
      reason: "repeated_tool_call",
      identicalCalls: maxIdentical,
      failedCalls: failed,
    };
  }
  if (failed >= STAFF_LOOP_GUARD.maxFailedToolCalls) {
    return {
      stop: true,
      reason: "repeated_tool_failure",
      identicalCalls: maxIdentical,
      failedCalls: failed,
    };
  }
  return { stop: false, reason: null, identicalCalls: maxIdentical, failedCalls: failed };
}
