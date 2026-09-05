import "server-only";

import type { Tool } from "ai";
import { logAgentTool } from "@/lib/ai/audit";

/**
 * P9C — the last boundary at which a booking turn can still fail silently.
 *
 * A tool call the SDK cannot parse never reaches `execute`. That means it never
 * reaches `protectPatientTool`, so it is not audited, not traced, and not turned
 * into a recoverable payload; the model receives the raw validator message as a
 * `tool-error` part and reads it as a broken system. In the production trace of
 * conversation 763b1c6b this is the turn shape that has two model steps and zero
 * `agent_tool:` rows, and whose stage line says `tool_called: "none"` — the turn
 * where the patient was told to phone the clinic.
 *
 * Widening the schemas (see `tools/booking-refs.ts`) removes the cause that
 * actually fired. This removes the *class*: whatever the model emits, it is
 * turned into some valid call on some mounted tool, so the model always gets a
 * real tool result with real guidance and the patient never hears about it.
 *
 * The repair is deliberately dumb, and only ever subtracts:
 *
 *   1. an unknown tool name is matched case-insensitively, then dropped;
 *   2. arguments that fail validation are removed one at a time, because every
 *      patient booking tool is designed to answer usefully with fewer arguments
 *      — that is what `booking-target.ts` is for;
 *   3. if nothing survives, the call becomes `prepare_booking({})`, which is the
 *      one move that is always legal, always answers with the real roster, and
 *      restarts nothing.
 *
 * It never adds an argument, never guesses an id, and never invents a value the
 * patient did not say. A repair that fabricated a plausible `doctor_id` would be
 * the same bug wearing a different hat.
 */

/** Where a repair that could salvage nothing else always lands. */
const SAFE_FALLBACK_TOOL = "prepare_booking";

type ZodLike = {
  safeParse: (value: unknown) => {
    success: boolean;
    error?: { issues?: Array<{ path?: Array<PropertyKey> }> };
  };
};

function zodSchemaOf(tool: Tool | undefined): ZodLike | null {
  const schema = (tool as { inputSchema?: unknown } | undefined)?.inputSchema;
  return schema && typeof (schema as ZodLike).safeParse === "function"
    ? (schema as ZodLike)
    : null;
}

/** The mounted tool this name means, or null. Never a guess at a *different* tool. */
function matchToolName(
  toolName: string,
  tools: Record<string, Tool>,
): string | null {
  if (tools[toolName]) return toolName;
  const wanted = toolName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = Object.keys(tools).find(
    (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted,
  );
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
 * subtraction terminates at `{}` rather than looping.
 */
function narrowToValid(
  schema: ZodLike,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; dropped: string[] } | null {
  let candidate: Record<string, unknown> = { ...input };
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= Object.keys(input).length; attempt += 1) {
    const result = schema.safeParse(candidate);
    if (result.success) return { input: candidate, dropped };
    const offending = new Set(
      (result.error?.issues ?? [])
        .map((issue) => issue.path?.[0])
        .filter((key): key is string => typeof key === "string"),
    );
    if (offending.size === 0) break;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      if (offending.has(key)) dropped.push(key);
      else next[key] = value;
    }
    candidate = next;
  }
  return schema.safeParse({}).success ? { input: {}, dropped } : null;
}

export type RepairableToolCall = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
};

/**
 * Builds the repair function for the patient agent.
 *
 * `clinicId` is only used for the audit line — the repair itself needs nothing
 * from the clinic, which is what keeps it deterministic and testable.
 */
export function createPatientToolCallRepair(clinicId: string) {
  return async function repairPatientToolCall(options: {
    toolCall: RepairableToolCall;
    tools: Record<string, Tool>;
  }): Promise<RepairableToolCall | null> {
    const { toolCall, tools } = options;
    const requested = toolCall.toolName;
    const matched = matchToolName(requested, tools);
    const targetName = matched ?? SAFE_FALLBACK_TOOL;
    const target = tools[targetName];
    if (!target) return null;

    const schema = zodSchemaOf(target);
    const parsed = matched ? parseInput(toolCall.input) : {};
    // With no zod schema to consult there is nothing to subtract against, so the
    // honest repair is the argument-free call rather than a guess.
    const narrowed = schema ? narrowToValid(schema, parsed) : { input: {}, dropped: [] };
    const finalName = narrowed ? targetName : SAFE_FALLBACK_TOOL;
    const finalInput = narrowed ? narrowed.input : {};

    // Enumerated labels only, exactly like every other line in this trace: the
    // two tool names and the *names* of the arguments dropped. No values — a
    // dropped argument is very often the patient's own words.
    await logAgentTool({
      clinicId,
      actorId: null,
      tool: "patient_tool_call_repaired",
      params: {
        requested_tool: requested,
        repaired_tool: finalName,
        name_matched: matched !== null,
        dropped_arguments: narrowed?.dropped ?? [],
      },
    });

    return {
      ...toolCall,
      type: "tool-call",
      toolName: finalName,
      input: JSON.stringify(finalInput),
    };
  };
}
