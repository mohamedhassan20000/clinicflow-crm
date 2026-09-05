import "server-only";

import type { Tool } from "ai";
import { logAgentTool } from "@/lib/ai/audit";

/**
 * Staff-side tool-call repair (study §12.2 / L2).
 *
 * The patient agent has had `experimental_repairToolCall` since P9C
 * (`lib/ai/tool-call-repair.ts`); the staff agent has had nothing. A staff tool
 * call the SDK cannot parse never reaches `execute`, which means it never
 * reaches `harden()` — so it is not sanitized, not audited, and not turned into
 * a recoverable payload. The model gets the raw validator message as a
 * `tool-output-error` part and has to recover from a schema complaint.
 *
 * That matters more here than on the patient side, because `query_resource`
 * carries the largest and most easily mis-emitted schema in the system: nested
 * filter operators, relations, sorts, and a field list, all optional.
 *
 * ## The policy: only ever subtract
 *
 * 1. Match the tool name case- and punctuation-insensitively against the
 *    **mounted** tools. Only a mounted tool can be the target, so repair can
 *    never reach a tool the caller was not authorized for — non-mounting stays
 *    the primary defence.
 * 2. Drop arguments that fail validation, one offending key at a time. Every
 *    generic staff read answers usefully with fewer arguments: `query_resource`
 *    without filters is the unfiltered page, `describe_action` without an id is
 *    the authorized catalogue.
 * 3. If nothing survives, fall back to a mounted **discovery** tool
 *    (`describe_capabilities`, then `describe_action`, then
 *    `list_my_capabilities`) with no arguments — the move that is always legal,
 *    always answers with the caller's real contract, and starts nothing.
 *
 * ## What it must never do, and why each is structurally impossible here
 *
 * - **Invent a clinic/patient/user id.** The repair only ever removes keys from
 *   the model's own object; there is no code path that writes a value.
 * - **Invent a permission or weaken authorization.** The target is chosen from
 *   the mounted set, which was resolved from the authenticated caller before
 *   the model ran. Every repaired call still enters `harden()` and the tool's
 *   own `execute`, which re-assert role, entitlement, subscription, page
 *   visibility, and per-user permission.
 * - **Fabricate a required identity field.** Subtraction cannot add one; a call
 *   that needs an id it did not carry fails validation, subtracts to `{}`, and
 *   lands on discovery instead of on a guess.
 * - **Turn a denied operation into an allowed one.** `execute_action` is barred
 *   as a repair *target* (`FORBIDDEN_REPAIR_TARGETS`). A malformed write is
 *   never rewritten into a valid write — the model is redirected to discovery
 *   and has to re-emit the write itself, which then runs the full preview →
 *   signed-token → human-confirmation pipeline unchanged.
 *
 * Every repair is audited through the same redacted `logAgentTool` path as any
 * other tool event, with enumerated labels only: the two tool names and the
 * *names* of the dropped arguments. Never a value — a dropped filter value is
 * very often a patient's name.
 */

/**
 * `AI_STAFF_TOOL_CALL_REPAIR=off` removes the repair layer entirely and restores
 * the previous behaviour (a malformed call becomes a `tool-output-error` part).
 * Independent of every other switch.
 */
export function staffToolCallRepairEnabled(): boolean {
  const raw = process.env.AI_STAFF_TOOL_CALL_REPAIR?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

/**
 * Tools a repair may never land on.
 *
 * `execute_action` is the only write surface the model has. Repairing *into* it
 * would mean the system, not the model, chose to attempt a write — and would
 * mean a malformed write silently became a well-formed one. Neither is
 * acceptable, and neither is worth the recovery.
 */
export const FORBIDDEN_REPAIR_TARGETS: ReadonlySet<string> = new Set(["execute_action"]);

/** Ordered fallbacks. The first one mounted for this caller wins. */
const DISCOVERY_FALLBACKS = [
  "describe_capabilities",
  "describe_action",
  "list_my_capabilities",
] as const;

type ZodIssueLike = {
  code?: string;
  path?: Array<PropertyKey>;
  /** Zod's `unrecognized_keys` carries the offending names here, with an empty path. */
  keys?: readonly string[];
};

type ZodLike = {
  safeParse: (value: unknown) => {
    success: boolean;
    error?: { issues?: ZodIssueLike[] };
  };
};

function zodSchemaOf(tool: Tool | undefined): ZodLike | null {
  const schema = (tool as { inputSchema?: unknown } | undefined)?.inputSchema;
  return schema && typeof (schema as ZodLike).safeParse === "function"
    ? (schema as ZodLike)
    : null;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The mounted tool this name means, or null.
 *
 * Recovers the formatting errors models actually make — `query-resource`,
 * `QueryResource`, `functions.query_resource`, a stray space — and nothing
 * else. It never resolves to a *different* tool: two distinct tools cannot
 * normalize to the same string in this registry, and a name that matches
 * nothing stays unmatched rather than being fuzzily attached to the nearest
 * neighbour.
 */
export function matchStaffToolName(
  toolName: string,
  tools: Record<string, Tool>,
): string | null {
  if (tools[toolName]) return toolName;
  const wanted = normalizeName(toolName.includes(".") ? toolName.split(".").pop()! : toolName);
  if (wanted === "") return null;
  const hit = Object.keys(tools).find((name) => normalizeName(name) === wanted);
  return hit ?? null;
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Drops the smallest set of top-level arguments that makes the input valid.
 *
 * Bounded by the number of keys, so a schema that can never be satisfied by
 * subtraction terminates at `{}` rather than looping. Returns null when even
 * `{}` is invalid — i.e. the tool has a genuinely required argument, which is
 * exactly the case where guessing would be the bug.
 */
export function narrowToValid(
  schema: ZodLike,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; dropped: string[] } | null {
  let candidate: Record<string, unknown> = { ...input };
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= Object.keys(input).length; attempt += 1) {
    const result = schema.safeParse(candidate);
    if (result.success) return { input: candidate, dropped };
    // Two shapes of "this key is the problem". A type/shape error names the key
    // in `path[0]`; a strict-object violation reports `unrecognized_keys` with
    // an *empty* path and the names in `keys`. Reading only the first shape is
    // what made an extra argument on a `.strict()` schema unrepairable — the
    // single most common malformation there is, and the one subtraction was
    // built for.
    const offending = new Set<string>();
    for (const issue of result.error?.issues ?? []) {
      const first = issue.path?.[0];
      if (typeof first === "string") offending.add(first);
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys ?? []) offending.add(key);
      }
    }
    if (offending.size === 0) break;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (offending.has(key)) dropped.push(key);
      else next[key] = value;
    }
    candidate = next;
  }
  return null;
}

export type RepairableStaffToolCall = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
};

export type StaffRepairOutcome = {
  call: RepairableStaffToolCall | null;
  audit: {
    requested_tool: string;
    repaired_tool: string | null;
    name_matched: boolean;
    dropped_arguments: string[];
    outcome: "repaired" | "fallback" | "abandoned";
  };
};

/**
 * The pure decision half of the repair, split out so every invariant in the
 * doc comment above is unit-testable without a database, an audit sink, or a
 * clinic.
 */
export function planStaffToolCallRepair(
  toolCall: RepairableStaffToolCall,
  tools: Record<string, Tool>,
): StaffRepairOutcome {
  const requested = toolCall.toolName;
  const matched = matchStaffToolName(requested, tools);

  // A malformed write is never repaired into a valid write. Redirect to
  // discovery so the model re-emits the action itself, with the full
  // preview/confirm pipeline in front of it.
  const target = matched && !FORBIDDEN_REPAIR_TARGETS.has(matched) ? matched : null;

  if (target) {
    const tool = tools[target];
    const schema = zodSchemaOf(tool);
    const parsed = parseInput(toolCall.input);
    const narrowed = schema ? narrowToValid(schema, parsed) : null;
    if (narrowed) {
      return {
        call: {
          ...toolCall,
          type: "tool-call",
          toolName: target,
          input: JSON.stringify(narrowed.input),
        },
        audit: {
          requested_tool: requested,
          repaired_tool: target,
          name_matched: matched === requested,
          dropped_arguments: narrowed.dropped,
          outcome: "repaired",
        },
      };
    }
  }

  const fallback = DISCOVERY_FALLBACKS.find((name) => {
    const tool = tools[name];
    if (!tool) return false;
    const schema = zodSchemaOf(tool);
    // Only a fallback that is genuinely callable with no arguments qualifies —
    // otherwise the "repair" would be a second malformed call.
    return schema ? schema.safeParse({}).success : true;
  });

  if (!fallback) {
    // Nothing safe to land on. Returning null hands the original error back to
    // the model, which is the honest outcome and the pre-existing behaviour.
    return {
      call: null,
      audit: {
        requested_tool: requested,
        repaired_tool: null,
        name_matched: matched !== null,
        dropped_arguments: [],
        outcome: "abandoned",
      },
    };
  }

  return {
    call: {
      ...toolCall,
      type: "tool-call",
      toolName: fallback,
      input: JSON.stringify({}),
    },
    audit: {
      requested_tool: requested,
      repaired_tool: fallback,
      name_matched: matched !== null,
      dropped_arguments: [],
      outcome: "fallback",
    },
  };
}

/**
 * Builds the repair function mounted on the staff agent.
 *
 * `clinicId`/`actorId` are used for the audit line only — the decision itself
 * needs nothing from the caller, which is what keeps it deterministic.
 */
export function createStaffToolCallRepair(input: {
  clinicId: string;
  actorId: string | null;
}) {
  return async function repairStaffToolCall(options: {
    toolCall: RepairableStaffToolCall;
    tools: Record<string, Tool>;
  }): Promise<RepairableStaffToolCall | null> {
    const outcome = planStaffToolCallRepair(options.toolCall, options.tools);
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: input.actorId,
      tool: "staff_tool_call_repaired",
      params: {
        requested_tool: outcome.audit.requested_tool,
        repaired_tool: outcome.audit.repaired_tool,
        name_matched: outcome.audit.name_matched,
        dropped_arguments: outcome.audit.dropped_arguments,
        outcome: outcome.audit.outcome,
      },
    });
    return outcome.call;
  };
}
