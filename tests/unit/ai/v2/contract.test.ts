/**
 * The command contract and the fail-closed store.
 *
 * Two properties the rest of the architecture rests on:
 *
 *   1. **nothing a model can emit reaches a business action unvalidated.** The
 *      parser is the only door, and every way through it that is not a valid
 *      command comes out as `ask_clarification`.
 *   2. **a build ahead of its migration loses the engine, not the
 *      conversation.** The V2 store fails closed and the legacy path answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const admin = vi.hoisted(() => ({
  probeConversationFlowStateColumn: vi.fn(),
  getConversationFlowState: vi.fn(),
  setConversationFlowState: vi.fn(),
  resetConversationFlowState: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => admin);

import {
  CommandSchema,
  COMMAND_KINDS,
  MAX_COMMANDS_PER_TURN,
  parseCommands,
} from "@/lib/ai/v2/commands";
import {
  __resetFlowStateAvailabilityCache,
  loadFlowState,
  saveFlowState,
} from "@/lib/ai/v2/store";
import { EMPTY_FLOW_STATE, newFrame } from "@/lib/ai/v2/flow-state";

describe("the command union is closed", () => {
  it("declares exactly the kinds the schema accepts", () => {
    // `COMMAND_KINDS` is what the interpreter prompt is generated against and
    // what the audit line labels a turn with. A kind in one list and not the
    // other is a silent hole, so the two are pinned to each other.
    expect(new Set(COMMAND_KINDS).size).toBe(COMMAND_KINDS.length);
    expect(CommandSchema.safeParse({ kind: "delete_patient" }).success).toBe(false);
    expect(CommandSchema.safeParse({ kind: "run_sql", sql: "drop table" }).success).toBe(
      false,
    );
  });

  it("refuses a slot the vocabulary does not contain", () => {
    expect(
      CommandSchema.safeParse({ kind: "set_slot", slot: "price", value: "0" }).success,
    ).toBe(false);
  });

  it("refuses an offer reference the server did not issue", () => {
    // The format is server-minted, so a model that invents one names nothing.
    expect(CommandSchema.safeParse({ kind: "affirm_offer", offerId: "yes" }).success).toBe(
      false,
    );
    expect(
      CommandSchema.safeParse({ kind: "affirm_offer", offerId: "ofr_deadbeef" }).success,
    ).toBe(true);
  });

  it("refuses a slot value long enough to be a paragraph", () => {
    expect(
      CommandSchema.safeParse({
        kind: "set_slot",
        slot: "full_name",
        value: "x".repeat(500),
      }).success,
    ).toBe(false);
  });
});

describe("the parser is the only door, and it fails closed", () => {
  it.each([
    ["prose", "The patient would like to book with Dr Ahmed Nabil on Tuesday."],
    ["an object that is not a command list", { intent: "book" }],
    ["a nested lie", { commands: "book everything" }],
    ["an empty array", []],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a truncated JSON array", '[{"kind":"start_flow","flow":"book_'],
  ])("turns %s into a clarification", (_label, raw) => {
    const parsed = parseCommands(raw);
    expect(parsed.commands).toEqual([
      { kind: "ask_clarification", reason: "unspecified_request" },
    ]);
    expect(parsed.outcome).toBe("rejected");
  });

  it("recovers valid commands from a fenced block", () => {
    // A formatting habit is not a different intent, and failing a turn over one
    // would send a patient to a human for no reason.
    const parsed = parseCommands(
      '```json\n[{"kind":"start_flow","flow":"book_appointment"}]\n```',
    );
    expect(parsed.commands).toEqual([{ kind: "start_flow", flow: "book_appointment" }]);
    expect(parsed.outcome).toBe("ok");
  });

  it("keeps the valid commands and counts the rest", () => {
    const parsed = parseCommands([
      { kind: "start_flow", flow: "book_appointment" },
      { kind: "wire_money", amount: 1000 },
    ]);
    expect(parsed.commands).toEqual([{ kind: "start_flow", flow: "book_appointment" }]);
    expect(parsed.outcome).toBe("partial");
    expect(parsed.dropped).toBe(1);
  });

  it("bounds how much one turn may carry", () => {
    const many = Array.from({ length: MAX_COMMANDS_PER_TURN + 4 }, () => ({
      kind: "small_talk",
      talk: "greeting",
    }));
    const parsed = parseCommands(many);
    expect(parsed.commands).toHaveLength(MAX_COMMANDS_PER_TURN);
    expect(parsed.dropped).toBe(4);
  });
});

describe("the store fails closed when its migration is not applied", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFlowStateAvailabilityCache();
  });

  it("reports unavailable when the column does not exist", async () => {
    admin.probeConversationFlowStateColumn.mockResolvedValue({
      error: { code: "42703" },
    });
    const loaded = await loadFlowState({ clinicId: "c", conversationId: "v" });
    // The caller answers this by handing the turn to the legacy engine. A V2
    // that ran with nowhere to persist a stack would see an empty stack every
    // turn — which looks exactly like "no flow is active" and would silently
    // restart every booking.
    expect(loaded).toEqual({ status: "unavailable" });
    expect(admin.getConversationFlowState).not.toHaveBeenCalled();
  });

  it("refuses to persist when the column does not exist", async () => {
    admin.probeConversationFlowStateColumn.mockResolvedValue({
      error: { code: "PGRST204" },
    });
    const saved = await saveFlowState({
      clinicId: "c",
      conversationId: "v",
      state: {
        version: 1,
        stack: [newFrame({ flow: "book_appointment", at: "2026-09-04T12:00:00.000Z" })],
      },
    });
    expect(saved).toEqual({ ok: false, code: "column_unavailable" });
    expect(admin.setConversationFlowState).not.toHaveBeenCalled();
  });

  it("classifies a failed write without quoting the database message", async () => {
    // The audit line only ever said `state_write_failed`, which is equally true
    // of a missing migration, a permission denial and a client-side TypeError.
    // The code separates them; the message, which can quote the failing row,
    // stays out of `audit_logs` entirely.
    admin.probeConversationFlowStateColumn.mockResolvedValue({ error: null });
    admin.setConversationFlowState.mockResolvedValue({
      error: { code: "42501", message: "permission denied for conversation 5f2c…" },
    });
    const denied = await saveFlowState({
      clinicId: "c",
      conversationId: "v",
      state: EMPTY_FLOW_STATE,
    });
    expect(denied).toEqual({ ok: false, code: "rpc_error:42501" });

    // A wrapper that *throws* is a client fault, not a database one — the
    // production defect was exactly this, and it must not read as a DB error.
    admin.setConversationFlowState.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'rest')"),
    );
    const threw = await saveFlowState({
      clinicId: "c",
      conversationId: "v",
      state: EMPTY_FLOW_STATE,
    });
    expect(threw).toEqual({ ok: false, code: "client_threw:TypeError" });
  });

  it("never throws into the reply path", async () => {
    // A partially mocked module, a missing key, a client that raises rather
    // than returning an error. Bookkeeping must not cost a patient their reply.
    admin.probeConversationFlowStateColumn.mockRejectedValue(new Error("no client"));
    await expect(loadFlowState({ clinicId: "c", conversationId: "v" })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("reads and writes normally once the column is there", async () => {
    admin.probeConversationFlowStateColumn.mockResolvedValue({ error: null });
    admin.getConversationFlowState.mockResolvedValue({
      data: { ai_flow_state: null },
      error: null,
    });
    admin.setConversationFlowState.mockResolvedValue({ error: null });

    const loaded = await loadFlowState({ clinicId: "c", conversationId: "v" });
    expect(loaded).toEqual({ status: "ok", state: EMPTY_FLOW_STATE });

    const saved = await saveFlowState({
      clinicId: "c",
      conversationId: "v",
      state: EMPTY_FLOW_STATE,
    });
    expect(saved).toEqual({ ok: true });
    // An empty stack normalizes to null, so "no flow" has one representation in
    // the database rather than two.
    expect(admin.setConversationFlowState).toHaveBeenCalledWith(
      expect.objectContaining({ flowState: null }),
    );
  });
});
