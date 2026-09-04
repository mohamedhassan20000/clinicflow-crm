/**
 * Staff tool-call repair, and the loop/dead-end guards that bound the raised
 * clinical step budget.
 *
 * The repair suite is written against the *real* zod schemas the staff tools
 * mount (`resourceQueryInputSchema` and friends), not synthetic ones, because
 * the whole claim is about what happens to a mis-emitted `query_resource` —
 * the largest schema in the system — and a hand-rolled stand-in would prove
 * nothing about it.
 *
 * The final block measures repair coverage over a corpus of the malformed calls
 * models actually emit. That number is the "repaired tool-call rate" the
 * improvement report quotes; before this layer existed it was 0 by
 * construction, because a call the SDK cannot parse never reaches `execute`.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Tool } from "ai";

vi.mock("server-only", () => ({}));

import { resourceQueryInputSchema } from "@/lib/ai/tools/resource-input";
import {
  FORBIDDEN_REPAIR_TARGETS,
  matchStaffToolName,
  narrowToValid,
  planStaffToolCallRepair,
  staffToolCallRepairEnabled,
  type RepairableStaffToolCall,
} from "@/lib/ai/staff-tool-call-repair";
import {
  STAFF_LOOP_GUARD,
  evaluateStaffLoopGuard,
} from "@/lib/ai/staff-loop-guard";

function fakeTool(schema: z.ZodType): Tool {
  return { inputSchema: schema, execute: async () => ({}) } as unknown as Tool;
}

/** A mount shaped like a real staff mount: generic reads, discovery, the writer. */
const MOUNT: Record<string, Tool> = {
  query_resource: fakeTool(resourceQueryInputSchema),
  get_record: fakeTool(
    z.object({ resource: z.string(), id: z.string().uuid() }).strict(),
  ),
  describe_capabilities: fakeTool(z.object({ resource: z.string().optional() }).strict()),
  describe_action: fakeTool(z.object({ action: z.string().optional() }).strict()),
  list_my_capabilities: fakeTool(z.object({}).strict()),
  execute_action: fakeTool(
    z.object({ action: z.string(), input: z.record(z.string(), z.unknown()) }).strict(),
  ),
};

function call(toolName: string, input: unknown): RepairableStaffToolCall {
  return {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: typeof input === "string" ? input : JSON.stringify(input),
  };
}

describe("staff tool-call repair · recovers what is safely recoverable", () => {
  it("recovers tool-name formatting errors against the mounted set", () => {
    for (const name of ["Query_Resource", "query-resource", "queryResource", "functions.query_resource", " query_resource "]) {
      expect(matchStaffToolName(name, MOUNT), name).toBe("query_resource");
    }
  });

  it("does not fuzzily attach an unrecognisable name to a neighbouring tool", () => {
    expect(matchStaffToolName("query_resources_v2", MOUNT)).toBeNull();
    expect(matchStaffToolName("delete_all_patients", MOUNT)).toBeNull();
    expect(matchStaffToolName("", MOUNT)).toBeNull();
  });

  it("drops an invalid optional argument and keeps the rest of the call", () => {
    const outcome = planStaffToolCallRepair(
      call("query_resource", {
        resource: "appointments",
        filters: { status: "booked" },
        page_size: "twenty-five",
      }),
      MOUNT,
    );
    expect(outcome.audit.outcome).toBe("repaired");
    expect(outcome.call!.toolName).toBe("query_resource");
    const repaired = JSON.parse(outcome.call!.input) as Record<string, unknown>;
    expect(repaired.resource).toBe("appointments");
    expect(repaired.filters).toEqual({ status: "booked" });
    expect(repaired.page_size).toBeUndefined();
    expect(outcome.audit.dropped_arguments).toContain("page_size");
  });

  it("repairs a malformed name and a malformed argument in one pass", () => {
    const outcome = planStaffToolCallRepair(
      call("Query-Resource", { resource: "patients", sort: 42 }),
      MOUNT,
    );
    expect(outcome.call!.toolName).toBe("query_resource");
    expect(outcome.audit.name_matched).toBe(false);
    expect(JSON.parse(outcome.call!.input)).toEqual({ resource: "patients" });
  });

  it("parses a stringified-JSON input, and survives one that is not JSON at all", () => {
    const fromString = planStaffToolCallRepair(
      call("query_resource", '{"resource":"patients","page":0}'),
      MOUNT,
    );
    expect(JSON.parse(fromString.call!.input)).toEqual({ resource: "patients" });

    const garbage = planStaffToolCallRepair(call("query_resource", "not json at all"), MOUNT);
    // `resource` is required, so subtraction cannot save it: discovery instead.
    expect(garbage.call!.toolName).toBe("describe_capabilities");
    expect(garbage.audit.outcome).toBe("fallback");
  });

  it("falls back to discovery when the tool name means nothing", () => {
    const outcome = planStaffToolCallRepair(call("summon_the_database", { x: 1 }), MOUNT);
    expect(outcome.call!.toolName).toBe("describe_capabilities");
    expect(JSON.parse(outcome.call!.input)).toEqual({});
  });

  it("abandons the call rather than inventing a landing place", () => {
    const outcome = planStaffToolCallRepair(call("whatever", {}), {
      execute_action: MOUNT.execute_action!,
    });
    expect(outcome.call).toBeNull();
    expect(outcome.audit.outcome).toBe("abandoned");
  });
});

describe("staff tool-call repair · what it must never do", () => {
  it("never lands on execute_action, even when that is the name the model emitted", () => {
    expect(FORBIDDEN_REPAIR_TARGETS.has("execute_action")).toBe(true);
    const outcome = planStaffToolCallRepair(
      call("execute_action", { action: "patients.soft_delete" }),
      MOUNT,
    );
    expect(outcome.call!.toolName).not.toBe("execute_action");
    expect(outcome.call!.toolName).toBe("describe_capabilities");
  });

  it("never rewrites a malformed write into a well-formed one", () => {
    // A write missing its input is exactly the call a naive repair would
    // "helpfully" complete. It must not be completed: the model has to re-emit
    // it, and the preview → signed-token → human-confirm pipeline runs in full.
    const outcome = planStaffToolCallRepair(
      call("Execute_Action", { action: "appointments.permanent_delete" }),
      MOUNT,
    );
    expect(outcome.call!.toolName).toBe("describe_capabilities");
    expect(outcome.call!.input).not.toContain("permanent_delete");
  });

  it("never adds a key the model did not emit — subtraction only", () => {
    const inputs: Array<Record<string, unknown>> = [
      { resource: "patients", filters: { full_name: "Ahmed" }, bogus: 1 },
      { resource: "appointments", page: -3, page_size: 9_999 },
      { resource: "documents", relations: "not-an-object" },
    ];
    for (const input of inputs) {
      const outcome = planStaffToolCallRepair(call("query_resource", input), MOUNT);
      const repaired = JSON.parse(outcome.call!.input) as Record<string, unknown>;
      for (const key of Object.keys(repaired)) {
        expect(Object.keys(input), JSON.stringify(input)).toContain(key);
        expect(repaired[key]).toEqual(input[key]);
      }
    }
  });

  it("never fabricates a required identity field", () => {
    // `get_record` needs a uuid. A repair that guessed one would be the bug.
    const outcome = planStaffToolCallRepair(
      call("get_record", { resource: "patients", id: "the one we discussed" }),
      MOUNT,
    );
    expect(outcome.call!.toolName).toBe("describe_capabilities");
    expect(outcome.call!.input).toBe("{}");
  });

  it("only ever targets a mounted tool, so repair cannot widen authorization", () => {
    // A doctor's mount has no financial tools. Naming one repairs to discovery,
    // never to the tool — non-mounting stays the primary defence.
    const doctorMount = { ...MOUNT };
    delete doctorMount.execute_action;
    const outcome = planStaffToolCallRepair(call("get_revenue_summary", {}), doctorMount);
    expect(outcome.call!.toolName).toBe("describe_capabilities");
  });

  it("returns null when even {} fails, rather than looping on subtraction", () => {
    const required = z.object({ id: z.string().uuid() }).strict();
    expect(narrowToValid(required, { id: "nope" })).toBeNull();
    expect(narrowToValid(required, { id: "11111111-1111-4111-8111-111111111111" })).toEqual({
      input: { id: "11111111-1111-4111-8111-111111111111" },
      dropped: [],
    });
  });

  it("audits every repair with enumerated labels and no argument values", () => {
    const outcome = planStaffToolCallRepair(
      call("query_resource", { resource: "patients", filters: { full_name: "Ahmed Hassan" }, page_size: "x" }),
      MOUNT,
    );
    const audit = JSON.stringify(outcome.audit);
    expect(audit).toContain("page_size");
    // The dropped argument's *value* is very often a patient's name.
    expect(audit).not.toContain("Ahmed Hassan");
  });
});

describe("staff tool-call repair · feature flag", () => {
  it("is on by default and off behind the documented switch", () => {
    const original = process.env.AI_STAFF_TOOL_CALL_REPAIR;
    delete process.env.AI_STAFF_TOOL_CALL_REPAIR;
    expect(staffToolCallRepairEnabled()).toBe(true);
    for (const value of ["off", "0", "false"]) {
      process.env.AI_STAFF_TOOL_CALL_REPAIR = value;
      expect(staffToolCallRepairEnabled(), value).toBe(false);
    }
    if (original === undefined) delete process.env.AI_STAFF_TOOL_CALL_REPAIR;
    else process.env.AI_STAFF_TOOL_CALL_REPAIR = original;
  });
});

/**
 * The measurement the improvement report quotes.
 *
 * "Recovered" means the model got a real tool result from a mounted tool
 * instead of a raw validator string. It is split from "on-target" — recovered
 * *on the tool the model was reaching for* — because landing on discovery is a
 * genuine recovery but a weaker one, and reporting them as a single number
 * would overstate the result.
 */
describe("staff tool-call repair · coverage over a malformed-call corpus", () => {
  const CORPUS: Array<{ label: string; call: RepairableStaffToolCall; onTarget: string | null }> = [
    { label: "camelCase tool name", call: call("queryResource", { resource: "patients" }), onTarget: "query_resource" },
    { label: "kebab-case tool name", call: call("query-resource", { resource: "patients" }), onTarget: "query_resource" },
    { label: "namespaced tool name", call: call("functions.query_resource", { resource: "patients" }), onTarget: "query_resource" },
    { label: "wrong-typed page_size", call: call("query_resource", { resource: "patients", page_size: "25" }), onTarget: "query_resource" },
    { label: "unknown extra argument", call: call("query_resource", { resource: "patients", order: "desc" }), onTarget: "query_resource" },
    { label: "filters as a string", call: call("query_resource", { resource: "patients", filters: "status=booked" }), onTarget: "query_resource" },
    { label: "sort as a number", call: call("query_resource", { resource: "appointments", sort: 1 }), onTarget: "query_resource" },
    { label: "stringified JSON input", call: call("query_resource", '{"resource":"patients"}'), onTarget: "query_resource" },
    { label: "unparseable input", call: call("query_resource", "resource=patients"), onTarget: null },
    { label: "non-uuid record id", call: call("get_record", { resource: "patients", id: "10432" }), onTarget: null },
    { label: "unknown tool", call: call("list_all_revenue", {}), onTarget: null },
    { label: "malformed write", call: call("execute_action", { action: "patients.soft_delete" }), onTarget: null },
  ];

  it("recovers every malformed call into a valid call on a mounted tool", () => {
    const outcomes = CORPUS.map((entry) => ({
      ...entry,
      outcome: planStaffToolCallRepair(entry.call, MOUNT),
    }));

    const recovered = outcomes.filter((entry) => entry.outcome.call !== null);
    const onTarget = outcomes.filter(
      (entry) => entry.onTarget !== null && entry.outcome.call?.toolName === entry.onTarget,
    );

    // Reported in docs/reviews/AI_STAFF_ASSISTANT_CURRENT_ARCHITECTURE_IMPROVEMENTS.md.
    console.log(
      `repair coverage: recovered ${recovered.length}/${CORPUS.length}, on-target ${onTarget.length}/${CORPUS.filter((e) => e.onTarget !== null).length}`,
    );

    expect(recovered.length).toBe(CORPUS.length);
    expect(onTarget.length).toBe(CORPUS.filter((entry) => entry.onTarget !== null).length);

    // Every landing place is mounted, and none of them is the write carrier.
    for (const entry of outcomes) {
      expect(Object.keys(MOUNT), entry.label).toContain(entry.outcome.call!.toolName);
      expect(entry.outcome.call!.toolName, entry.label).not.toBe("execute_action");
    }
  });
});

describe("staff loop guard · bounds what the raised step budget can be spent on", () => {
  const step = (calls: Array<{ toolName: string; input?: unknown }>, errors = 0) => ({
    toolCalls: calls,
    content: Array.from({ length: errors }, () => ({ type: "tool-error" })),
  });

  it("does not stop a healthy multi-step turn", () => {
    const verdict = evaluateStaffLoopGuard([
      step([{ toolName: "search_authorized_patients", input: { query: "Ahmed" } }]),
      step([{ toolName: "query_resource", input: { resource: "appointments" } }]),
      step([{ toolName: "query_resource", input: { resource: "prescriptions" } }]),
    ]);
    expect(verdict.stop).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it("tolerates one prescribed retry of an identical call", () => {
    const identical = step([{ toolName: "preview_document", input: { document: "patient_history" } }]);
    expect(evaluateStaffLoopGuard([identical, identical]).stop).toBe(false);
  });

  it("stops on the third identical call", () => {
    const identical = step([{ toolName: "query_resource", input: { resource: "patients", page: 1 } }]);
    const verdict = evaluateStaffLoopGuard([identical, identical, identical]);
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe("repeated_tool_call");
    expect(verdict.identicalCalls).toBe(STAFF_LOOP_GUARD.maxIdenticalToolCalls);
  });

  it("treats key order as irrelevant when comparing calls", () => {
    const a = step([{ toolName: "query_resource", input: { resource: "patients", page: 1 } }]);
    const b = step([{ toolName: "query_resource", input: { page: 1, resource: "patients" } }]);
    expect(evaluateStaffLoopGuard([a, b, a]).stop).toBe(true);
  });

  it("stops after too many failed tool calls", () => {
    const failing = step([{ toolName: "query_resource", input: { resource: "x" } }], 1);
    const varied = [1, 2, 3, 4].map((n) =>
      step([{ toolName: "query_resource", input: { resource: `r${n}` } }], 1),
    );
    expect(evaluateStaffLoopGuard(varied.slice(0, 3)).stop).toBe(false);
    const verdict = evaluateStaffLoopGuard(varied);
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe("repeated_tool_failure");
    expect(verdict.failedCalls).toBe(STAFF_LOOP_GUARD.maxFailedToolCalls);
    expect(failing.content).toHaveLength(1);
  });

  it("survives an unserializable argument instead of throwing inside the loop", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const verdict = evaluateStaffLoopGuard([
      { toolCalls: [{ toolName: "query_resource", input: cyclic }] },
    ]);
    expect(verdict.stop).toBe(false);
  });

  it("handles an empty trace", () => {
    expect(evaluateStaffLoopGuard([])).toEqual({
      stop: false,
      reason: null,
      identicalCalls: 0,
      failedCalls: 0,
    });
  });
});
