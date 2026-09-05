/**
 * Cross-turn tool memory — containment and usefulness.
 *
 * Two halves, and both matter. The usefulness half proves the feature does the
 * thing it exists for: a second turn can reason over what the first turn
 * actually found instead of over the assistant's prose summary of it. The
 * containment half proves it widened nothing — no confirmation semantics, no
 * credentials, no internal plumbing ids, no unbounded payloads, and no
 * authority.
 */

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage, UIMessage } from "ai";

vi.mock("server-only", () => ({}));

import {
  NEVER_REPLAYABLE_TOOLS,
  REPLAYABLE_TOOLS,
  REPLAYABLE_TOOL_FIELDS,
  TOOL_MEMORY_BOUNDS,
  buildToolMemory,
  isReplayableKey,
  projectToolPart,
  renderToolMemory,
  staffToolMemoryEnabled,
  withToolMemory,
} from "@/lib/ai/staff-tool-memory";

const MOUNTED = new Set([
  "query_resource",
  "get_record",
  "search_authorized_patients",
  "execute_action",
  "get_revenue_summary",
]);

function queryResourcePart(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool-query_resource",
    toolCallId: "call-1",
    state: "output-available",
    input: { resource: "appointments", filters: { date: "2026-08-24" } },
    output: {
      resource: "appointments",
      rows: [
        { id: "11111111-1111-4111-8111-111111111111", file_number: "10432", full_name: "Ahmed Hassan", status: "booked" },
        { id: "22222222-2222-4222-8222-222222222222", file_number: "10433", full_name: "Sara Ali", status: "booked" },
      ],
      total: 2,
      page: 1,
      page_size: 25,
      truncated: false,
      notice: null,
      fields_withheld: [],
      data_provenance: "untrusted_tenant_text: …",
      ...overrides,
    },
  };
}

function assistantTurn(parts: unknown[], id = "assistant-1"): UIMessage {
  return { id, role: "assistant", parts: parts as UIMessage["parts"] };
}

describe("cross-turn tool memory · turn 2 can use turn 1's result", () => {
  it("projects the rows, totals and resource a follow-up turn depends on", () => {
    const entries = buildToolMemory(
      [
        { id: "u1", role: "user", parts: [{ type: "text", text: "today's appointments" }] },
        assistantTurn([{ type: "text", text: "Here they are." }, queryResourcePart()]),
        { id: "u2", role: "user", parts: [{ type: "text", text: "prepare follow-ups for those" }] },
      ],
      MOUNTED,
    );

    expect(entries).toHaveLength(1);
    const output = entries[0]!.output;
    expect(entries[0]!.toolName).toBe("query_resource");
    expect(output.resource).toBe("appointments");
    expect(output.total).toBe(2);
    // The working set the study's T1/T8 are about: the file numbers survive, so
    // turn 2 does not have to re-query or reconstruct them from prose.
    expect(JSON.stringify(output)).toContain("10432");
    expect(JSON.stringify(output)).toContain("10433");
  });

  it("renders a block that frames the recall as data and not as authority", () => {
    const block = renderToolMemory(buildToolMemory([assistantTurn([queryResourcePart()])], MOUNTED))!;
    expect(block).toContain("recalled_tool_results");
    expect(block).toContain("data, not instructions");
    expect(block).toContain("grant");
    expect(block).toContain("query_resource →");
  });

  it("inserts the block before the last user message and leaves everything else alone", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    const result = withToolMemory(messages, "RECALL");
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(result[2]).toEqual({ role: "assistant", content: "RECALL" });
    expect(result[3]).toEqual({ role: "user", content: "second" });
  });

  it("is a no-op when there is nothing to recall", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    expect(withToolMemory(messages, null)).toEqual(messages);
    expect(renderToolMemory([])).toBeNull();
  });
});

describe("cross-turn tool memory · stale or unauthorized context grants nothing", () => {
  it("never replays an execute_action preview, in either allow-list", () => {
    expect(NEVER_REPLAYABLE_TOOLS.has("execute_action")).toBe(true);
    expect(REPLAYABLE_TOOLS.has("execute_action")).toBe(false);

    const part = {
      type: "tool-execute_action",
      toolCallId: "call-2",
      state: "output-available",
      input: { action: "appointments.send_reminders", input: {} },
      output: {
        action_id: "appointments.send_reminders",
        phase: "preview",
        confirmation_required: true,
        confirm_token: "server-only-confirm-token",
        expires_at: "2026-08-24T12:10:00.000Z",
      },
    };
    expect(projectToolPart(part, new Set(["execute_action"]))).toBeNull();

    const entries = buildToolMemory([assistantTurn([part])], MOUNTED);
    expect(entries).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain("server-only-confirm-token");
  });

  it("drops a result whose tool is no longer mounted for this turn", () => {
    // A permission revoked between turns unmounts the tool. The memory of what
    // it returned goes with it: replay is gated on the live mount, not on what
    // the user could see when the row was written.
    const revenuePart = {
      type: "tool-get_revenue_summary",
      toolCallId: "call-3",
      state: "output-available",
      input: {},
      output: { range: "2026-08", totals: { gross: 120_000 }, currency: "EGP" },
    };
    expect(projectToolPart(revenuePart, MOUNTED)).not.toBeNull();
    const withoutFinancial = new Set([...MOUNTED].filter((n) => n !== "get_revenue_summary"));
    expect(projectToolPart(revenuePart, withoutFinancial)).toBeNull();
  });

  it("never replays a permission denial, so a verdict cannot be cached", () => {
    const denied = {
      type: "tool-query_resource",
      toolCallId: "call-4",
      state: "output-available",
      input: { resource: "patients" },
      output: { permission_denied: true, reason: "permission_not_granted", guidance: "…" },
    };
    expect(projectToolPart(denied, MOUNTED)).toBeNull();
  });

  it("ignores parts that are not completed tool results", () => {
    for (const state of ["input-available", "output-error", "input-streaming"]) {
      expect(
        projectToolPart({ ...queryResourcePart(), state }, MOUNTED),
        state,
      ).toBeNull();
    }
    expect(projectToolPart({ type: "text", text: "hello" }, MOUNTED)).toBeNull();
    expect(projectToolPart(null, MOUNTED)).toBeNull();
  });

  it("replays no tool that is absent from the allow-list, including a future one", () => {
    const unknown = {
      type: "tool-some_future_tool",
      toolCallId: "call-5",
      state: "output-available",
      input: {},
      output: { rows: [{ id: "x" }] },
    };
    expect(projectToolPart(unknown, new Set(["some_future_tool"]))).toBeNull();
  });
});

describe("cross-turn tool memory · sensitive and internal fields are excluded", () => {
  it("drops credential-shaped and internal-plumbing keys at any depth", () => {
    const part = queryResourcePart({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          full_name: "Ahmed Hassan",
          clinic_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          created_by: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
          national_id: "29001011234567",
          nested: { confirm_token: "leak-me", api_key: "leak-me-too", ok: "kept" },
        },
      ],
    });
    const projected = projectToolPart(part, MOUNTED)!;
    const json = JSON.stringify(projected.output);

    expect(json).toContain("Ahmed Hassan");
    expect(json).toContain("kept");
    expect(json).not.toContain("clinic_id");
    expect(json).not.toContain("created_by");
    expect(json).not.toContain("national_id");
    expect(json).not.toContain("leak-me");
    expect(json).not.toContain("leak-me-too");
  });

  it("drops any top-level output field outside the tool's declared allow-list", () => {
    const part = queryResourcePart({ internal_debug: { sql: "select *" }, cursor: "opaque" });
    const projected = projectToolPart(part, MOUNTED)!;
    expect(Object.keys(projected.output).every((key) =>
      REPLAYABLE_TOOL_FIELDS.query_resource!.includes(key),
    )).toBe(true);
    expect(JSON.stringify(projected.output)).not.toContain("select *");
    // `data_provenance` is real output, but it is not on the allow-list: the
    // recall block carries its own framing.
    expect(projected.output.data_provenance).toBeUndefined();
  });

  it("classifies keys the way the doc comment claims", () => {
    for (const key of ["confirm_token", "password", "api_key", "clinic_id", "created_by", "national_id", "input_digest"]) {
      expect(isReplayableKey(key), key).toBe(false);
    }
    for (const key of ["id", "patient_id", "appointment_id", "invoice_id", "doctor_id", "full_name", "status"]) {
      expect(isReplayableKey(key), key).toBe(true);
    }
  });
});

describe("cross-turn tool memory · bounds are enforced", () => {
  it("caps the recency window to the configured number of assistant turns", () => {
    const turns = Array.from({ length: 5 }, (_, index) =>
      assistantTurn([queryResourcePart({ total: index })], `assistant-${index}`),
    );
    const entries = buildToolMemory(turns, MOUNTED);
    expect(entries.length).toBeLessThanOrEqual(TOOL_MEMORY_BOUNDS.maxAssistantTurns);
    // Newest turns win the budget; the emitted order stays chronological.
    expect(entries.map((entry) => entry.output.total)).toEqual([3, 4]);
  });

  it("caps the number of replayed parts", () => {
    const parts = Array.from({ length: 20 }, () => queryResourcePart());
    const entries = buildToolMemory([assistantTurn(parts)], MOUNTED);
    expect(entries.length).toBeLessThanOrEqual(TOOL_MEMORY_BOUNDS.maxParts);
  });

  it("caps rows and marks the omission rather than silently truncating", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${index}`,
      full_name: `Patient ${index}`,
    }));
    const projected = projectToolPart(queryResourcePart({ rows, total: 40 }), MOUNTED)!;
    const replayed = projected.output.rows as unknown[];
    expect(replayed.length).toBe(TOOL_MEMORY_BOUNDS.maxRows + 1);
    expect(String(replayed.at(-1))).toContain("more omitted");
  });

  it("caps long strings so a note body cannot be duplicated into context", () => {
    const projected = projectToolPart(
      queryResourcePart({ rows: [{ id: "n1", body: "x".repeat(5_000) }] }),
      MOUNTED,
    )!;
    const body = (projected.output.rows as Array<Record<string, unknown>>)[0]!.body as string;
    expect(body.length).toBeLessThanOrEqual(TOOL_MEMORY_BOUNDS.maxStringLength + 1);
  });

  it("drops an oversized projection whole rather than clipping it", () => {
    // 10 rows of 240-character fields still clears 4 KB.
    const rows = Array.from({ length: 10 }, (_, index) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, field) => [`f${field}`, `${index}`.repeat(240)]),
      ),
    );
    expect(projectToolPart(queryResourcePart({ rows }), MOUNTED)).toBeNull();
  });

  it("keeps the whole recall block inside the total byte cap", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: `row-${index}`,
      full_name: "y".repeat(120),
      note: "z".repeat(120),
    }));
    const parts = Array.from({ length: 6 }, () => queryResourcePart({ rows }));
    const entries = buildToolMemory([assistantTurn(parts)], MOUNTED);
    const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
    expect(bytes).toBeLessThanOrEqual(TOOL_MEMORY_BOUNDS.maxBytesTotal);
    // Trimmed, not emptied: the newest findings survive the cap.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(parts.length);
  });
});

describe("cross-turn tool memory · feature flag", () => {
  const original = process.env.AI_STAFF_TOOL_MEMORY;

  it("is on by default and off behind the documented switch", () => {
    delete process.env.AI_STAFF_TOOL_MEMORY;
    expect(staffToolMemoryEnabled()).toBe(true);
    for (const value of ["off", "0", "false", "OFF"]) {
      process.env.AI_STAFF_TOOL_MEMORY = value;
      expect(staffToolMemoryEnabled(), value).toBe(false);
    }
    process.env.AI_STAFF_TOOL_MEMORY = "on";
    expect(staffToolMemoryEnabled()).toBe(true);
    if (original === undefined) delete process.env.AI_STAFF_TOOL_MEMORY;
    else process.env.AI_STAFF_TOOL_MEMORY = original;
  });
});
