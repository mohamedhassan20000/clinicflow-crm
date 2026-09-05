import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11O — who is allowed to move an episode boundary.
 *
 * A close draws it. A reopen must not: the reopen runs *after* the first
 * message of the new episode has been persisted, so re-stamping the boundary
 * there would cut that message out of the episode it starts. The one exception
 * is a thread that carries no boundary at all — closed before this column
 * existed — where the reopen is the only chance to draw one.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  logAgentTool: vi.fn(),
  state: {
    conversation: {} as Row,
    updates: [] as Array<{ table: string; payload: Row; nullFilters: string[] }>,
  },
}));

vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.logAgentTool }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      let op: "select" | "update" = "select";
      let payload: Row = {};
      const nullFilters: string[] = [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.order = self;
      chain.limit = self;
      // The one filter this test is about: `.is(column, null)`.
      chain.is = (column: unknown, value: unknown) => {
        if (value === null) nullFilters.push(String(column));
        return chain;
      };
      chain.update = (next: Row) => {
        op = "update";
        payload = next;
        return chain;
      };
      const settle = (single: boolean) => {
        if (op !== "update") return { data: null, error: null };
        // A conditional update matches nothing when the column is already set,
        // which is what a real `.is(column, null)` would do.
        const blocked = nullFilters.some(
          (column) => mocks.state.conversation[column] !== null &&
            mocks.state.conversation[column] !== undefined,
        );
        mocks.state.updates.push({ table, payload, nullFilters });
        if (blocked) return { data: single ? null : [], error: null };
        if (table === "conversations") {
          Object.assign(mocks.state.conversation, payload);
          return { data: single ? { id: "conv-1" } : [{ id: "conv-1" }], error: null };
        }
        return { data: single ? null : [], error: null };
      };
      chain.maybeSingle = () => Promise.resolve(settle(true));
      chain.then = (onF: (value: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle(false)).then(onF, onR);
      return chain;
    },
  }),
}));

import {
  closeAndResetConversation,
  resetConversationAssistantState,
} from "@/lib/ai/conversation-reset";

const CONVERSATION = "conv-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.updates = [];
  mocks.state.conversation = {
    id: CONVERSATION,
    status: "open",
    patient_id: "patient-1",
    ai_context_reset_at: null,
    ai_booking_stage: { stage: "intake_collecting" },
  };
});

/** Every payload written to `conversations`, merged. */
function conversationWrites(): Row {
  return Object.assign(
    {},
    ...mocks.state.updates.filter((u) => u.table === "conversations").map((u) => u.payload),
  );
}

describe("P11O — a close draws the boundary", () => {
  it("stamps it at the moment of the manual close", async () => {
    const before = new Date().toISOString();
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    const boundary = String(mocks.state.conversation.ai_context_reset_at);
    expect(boundary >= before).toBe(true);
  });

  it("uses one instant for the close and the boundary", async () => {
    await closeAndResetConversation({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "assistant_close",
    });
    const writes = conversationWrites();
    expect(writes.status).toBe("closed");
    // Identical values: an AI auto-close and a staff close leave the same row.
    expect(writes.ai_context_reset_at).toBe(writes.status_updated_at);
  });

  it("overwrites an older boundary — a second close ends a second episode", async () => {
    mocks.state.conversation.ai_context_reset_at = "2026-01-01T00:00:00.000Z";
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "manual_close",
      boundaryAt: "2026-08-30T10:00:00.000Z",
    });
    expect(mocks.state.conversation.ai_context_reset_at).toBe("2026-08-30T10:00:00.000Z");
  });
});

describe("P11O — a reopen never moves a boundary a close already drew", () => {
  it("leaves an existing boundary exactly where the close put it", async () => {
    mocks.state.conversation.ai_context_reset_at = "2026-08-29T12:00:00.000Z";
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "reopened",
      boundaryAt: "2026-08-30T09:00:00.000Z",
    });
    expect(mocks.state.conversation.ai_context_reset_at).toBe("2026-08-29T12:00:00.000Z");
    // The conditional is a real filter, not a read-then-write race.
    const stamp = mocks.state.updates.find((u) => "ai_context_reset_at" in u.payload);
    expect(stamp?.nullFilters).toEqual(["ai_context_reset_at"]);
  });

  it("draws one for a legacy thread that has none", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "reopened",
      boundaryAt: "2026-08-30T09:00:00.000Z",
    });
    expect(mocks.state.conversation.ai_context_reset_at).toBe("2026-08-30T09:00:00.000Z");
  });

  it("still reports success when the boundary was already set", async () => {
    mocks.state.conversation.ai_context_reset_at = "2026-08-29T12:00:00.000Z";
    const result = await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION,
      reason: "reopened",
    });
    // Matching no row is the ordinary outcome here, not a failure.
    expect(result.ok).toBe(true);
    expect(mocks.state.conversation.ai_booking_stage).toBeNull();
  });
});
