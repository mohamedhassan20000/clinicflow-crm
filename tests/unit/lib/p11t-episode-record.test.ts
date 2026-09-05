import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11T — the close path writes a durable episode record, with a reason.
 *
 * P11O's boundary is a timestamp: it says *when* an episode ended and can never
 * say which of the three endings it was, or that there were four of them. These
 * pin the half P11T adds — that every close ends the episode, that the reason
 * is recorded, that a reopen does not — and, just as importantly, that none of
 * it touches the patient.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  logAgentTool: vi.fn(),
  closeConversationEpisode: vi.fn(),
  state: {
    conversation: {} as Row,
    /** Every payload written to `conversations`. */
    writes: [] as Row[],
  },
}));

vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.logAgentTool }));
vi.mock("@/lib/supabase/admin", () => ({
  closeConversationEpisode: mocks.closeConversationEpisode,
  resolveConversationEpisode: vi.fn(),
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
        const blocked = nullFilters.some(
          (column) =>
            mocks.state.conversation[column] !== null &&
            mocks.state.conversation[column] !== undefined,
        );
        if (table === "conversations") mocks.state.writes.push(payload);
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

import { resetConversationAssistantState } from "@/lib/ai/conversation-reset";

const CLINIC = "clinic-1";
const CONVERSATION = "conv-1";

/**
 * The permanent facts. Every one of these is a property of the *person*, not of
 * an exchange, and the whole point of the boundary is that closing a thread
 * forgets what the assistant was doing without forgetting who it was doing it
 * for.
 */
const PERMANENT: Row = {
  patient_id: "patient-1",
  patient_link_status: "verified",
  display_name: "أحمد نبيل",
  identity_verified_at: "2026-08-01T10:00:00.000Z",
  booking_identity_confirmed_at: "2026-08-01T10:05:00.000Z",
  participant_address: "+201000000000",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeConversationEpisode.mockResolvedValue({
    data: [{ episode_id: "episode-1", closed: true }],
    error: null,
  });
  mocks.state.writes = [];
  mocks.state.conversation = {
    id: CONVERSATION,
    status: "open",
    ai_context_reset_at: null,
    ai_booking_stage: { stage: "intake_collecting" },
    ai_collected_data: { full_name: "سارة" },
    ai_pending_clarification: { question: "أنهي قسم؟" },
    ...PERMANENT,
  };
});

describe("P11T — every ending records the episode that ended", () => {
  it("ends the episode as a manual close when staff close the thread", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    expect(mocks.closeConversationEpisode).toHaveBeenCalledTimes(1);
    expect(mocks.closeConversationEpisode.mock.calls[0]![0]).toMatchObject({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
  });

  it("ends the episode as an assistant close when the patient says they are done", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "assistant_close",
    });
    expect(mocks.closeConversationEpisode.mock.calls[0]![0]).toMatchObject({
      reason: "assistant_close",
    });
  });

  /**
   * A reopen is not an ending. It runs after the first message of the *new*
   * episode has already been persisted, so ending an episode here would close
   * the one the next turn is about to open.
   */
  it("does not end an episode on the reopen repair path", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "reopened",
      boundaryAt: "2026-08-30T09:00:00.000Z",
    });
    expect(mocks.closeConversationEpisode).not.toHaveBeenCalled();
  });

  it("stamps the episode's end at the same instant as the context boundary", async () => {
    const boundary = "2026-08-30T09:00:00.000Z";
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
      boundaryAt: boundary,
    });
    expect(mocks.closeConversationEpisode.mock.calls[0]![0]).toMatchObject({
      endedAt: boundary,
    });
    expect(mocks.state.conversation.ai_context_reset_at).toBe(boundary);
  });

  /**
   * The episode record is metadata. Losing it must never cost the clinic the
   * close, because `ai_context_reset_at` — written independently above — is
   * what actually bounds the model's context.
   */
  it("still closes the thread when the episode record cannot be written", async () => {
    mocks.closeConversationEpisode.mockResolvedValue({
      data: null,
      error: { code: "42883", message: "function does not exist" },
    });
    const result = await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    expect(result.ok).toBe(true);
    expect(mocks.state.conversation.ai_context_reset_at).toEqual(expect.any(String));
    expect(mocks.state.conversation.ai_booking_stage).toBeNull();
  });
});

describe("P11T — closing forgets the exchange, never the person", () => {
  const transient = [
    "ai_collected_data",
    "ai_pending_clarification",
    "ai_booking_stage",
    "ai_escalated_at",
    "ai_escalation_reason",
    "ai_paused_at",
    "ai_last_replied_at",
    "ai_auto_close_after",
    "ai_auto_close_armed_at",
  ] as const;

  it("discards every piece of episode-scoped assistant state", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    const written = Object.assign({}, ...mocks.state.writes) as Row;
    for (const column of transient) {
      expect(column in written, `${column} should be cleared on close`).toBe(true);
    }
    expect(written.ai_collected_data).toEqual({});
    expect(written.ai_booking_stage).toBeNull();
    expect(written.ai_pending_clarification).toBeNull();
  });

  /**
   * The requirement stated as a test: an existing linked patient who starts a
   * new episode must not be asked to recreate their profile. That is only
   * possible if the close left the linkage alone.
   */
  it("leaves the verified patient linkage and identity untouched", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    const written = Object.assign({}, ...mocks.state.writes) as Row;
    for (const column of Object.keys(PERMANENT)) {
      expect(column in written, `${column} must never be written by a close`).toBe(false);
    }
    for (const [column, value] of Object.entries(PERMANENT)) {
      expect(mocks.state.conversation[column], column).toEqual(value);
    }
  });

  it("never deletes a message or a patient", async () => {
    await resetConversationAssistantState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "manual_close",
    });
    // The stub records every write; a delete would have to go through it.
    const written = Object.assign({}, ...mocks.state.writes) as Row;
    expect(written).not.toHaveProperty("is_deleted");
    expect(written).not.toHaveProperty("deleted_at");
  });
});
