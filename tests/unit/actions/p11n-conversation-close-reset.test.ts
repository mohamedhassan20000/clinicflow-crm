import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11N — closing a thread ends the conversation, not just its row.
 *
 * The three properties under test are the ones the production failure violated:
 * a manual close forgets what the assistant was doing, it forgets the drafts it
 * had queued, and it forgets *none* of the permanent record — the patient link,
 * the verified identity and every stored message survive untouched.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  revalidatePath: vi.fn(),
  logAgentTool: vi.fn(),
  sendMessage: vi.fn(),
  state: {
    /** The conversation row, mutated in place by the updates under test. */
    conversation: {} as Row,
    suggestions: [] as Row[],
    updates: [] as Array<{ table: string; payload: Row }>,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({ actionError: (key: string) => Promise.resolve(key) }));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: vi.fn(),
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.logAgentTool }));
vi.mock("@/lib/entitlements", () => ({ getEntitlements: vi.fn(), hasFeature: vi.fn() }));
vi.mock("@/lib/ai/booking-stage-store", () => ({ clearBookingStageEscalation: vi.fn() }));
vi.mock("@/lib/messaging/channel-management", () => ({
  connectDialog360Channel: vi.fn(),
  getActiveWhatsAppProvider: vi.fn(),
  getWhatsAppChannelStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({ submitDialog360Template: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({ submitMetaTemplate: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("@/lib/messaging/outbound-media-diagnostics", () => ({ logOutboundMediaDiagnostic: vi.fn() }));
vi.mock("@/lib/messaging/outbound-media", () => ({
  claimOutboundMedia: vi.fn(),
  finalizeOutboundMedia: vi.fn(),
  releaseOutboundMedia: vi.fn(),
  holdOutboundMedia: vi.fn(),
  isSendableStoragePath: () => true,
  WHATSAPP_OUTBOUND_BUCKET: "whatsapp-outbound",
}));

vi.mock("@/lib/supabase/admin", () => ({
  setInboxConversationPatient: vi.fn(),
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      let op: "select" | "update" = "select";
      let payload: Row = {};
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.order = self;
      chain.limit = self;
      chain.is = self;
      chain.eq = (column: unknown, value: unknown) => {
        filters.push([String(column), value]);
        return chain;
      };
      chain.update = (next: Row) => {
        op = "update";
        payload = next;
        return chain;
      };
      const settle = (single: boolean) => {
        if (op !== "update") {
          if (table === "conversations") return { data: mocks.state.conversation, error: null };
          return { data: null, error: null };
        }
        mocks.state.updates.push({ table, payload });
        if (table === "conversations") {
          Object.assign(mocks.state.conversation, payload);
          return { data: { id: mocks.state.conversation.id }, error: null };
        }
        if (table === "ai_suggested_replies") {
          const wanted = filters.find(([column]) => column === "status")?.[1];
          const id = filters.find(([column]) => column === "id")?.[1];
          const hit = mocks.state.suggestions.filter(
            (row) => row.status === wanted && (id === undefined || row.id === id),
          );
          // The claim reads the row it just took; a sweep reports the set.
          const before = hit.map((row) => ({ ...row }));
          for (const row of hit) Object.assign(row, payload);
          if (single) return { data: before[0] ?? null, error: null };
          return { data: hit.map((row) => ({ id: row.id })), error: null };
        }
        return { data: null, error: null };
      };
      chain.maybeSingle = () => Promise.resolve(settle(true));
      chain.then = (onF: (value: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle(false)).then(onF, onR);
      return chain;
    },
  }),
}));

import { approveAiSuggestion, updateConversationStatus } from "@/actions/messaging";
import { resetConversationAssistantState } from "@/lib/ai/conversation-reset";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

/** A thread mid-intake: exactly the state the production screenshot was stuck in. */
function midIntakeConversation(): Row {
  return {
    id: CONVERSATION_ID,
    status: "open",
    // Permanent — the person this thread is about.
    patient_id: "patient-1",
    patient_link_status: "automatic",
    participant_address: "+201000000000",
    display_name: "Omar",
    identity_verified_at: "2026-08-01T10:00:00.000Z",
    // Conversational — everything the assistant was in the middle of.
    ai_collected_data: { full_name: "Omar", department_id: "dept-1", doctor_id: "doc-1" },
    ai_pending_clarification: { field: "date_of_birth", candidates: ["2000-09-12"] },
    ai_booking_stage: {
      stage: "intake_collecting",
      intakeAsk: { signature: "date_of_birth,national_id", repeats: 2 },
      offeredDoctorIds: ["doc-1"],
    },
    ai_escalated_at: null,
    ai_escalation_reason: null,
    ai_paused_at: "2026-08-20T09:00:00.000Z",
    ai_last_replied_at: "2026-08-20T09:05:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.conversation = midIntakeConversation();
  mocks.state.suggestions = [
    // The draft the production leak was still sitting in.
    {
      id: "11111111-1111-4111-8111-111111111112",
      conversation_id: CONVERSATION_ID,
      status: "pending",
      body: "أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth).",
    },
  ];
  mocks.state.updates = [];
  mocks.requireMutationRole.mockResolvedValue({
    id: "receptionist-1",
    clinicId: "clinic-1",
    role: "receptionist",
  });
});

describe("P11N — manual Close Thread resets the assistant", () => {
  it("clears every piece of conversational state", async () => {
    const result = await updateConversationStatus({
      conversationId: CONVERSATION_ID,
      status: "closed",
    });

    expect(result).toEqual({ success: true });
    const row = mocks.state.conversation;
    expect(row.status).toBe("closed");
    expect(row.ai_collected_data).toEqual({});
    expect(row.ai_pending_clarification).toBeNull();
    expect(row.ai_booking_stage).toBeNull();
    expect(row.ai_escalated_at).toBeNull();
    expect(row.ai_escalation_reason).toBeNull();
    expect(row.ai_paused_at).toBeNull();
    expect(row.ai_last_replied_at).toBeNull();
  });

  it("stale intake state cannot survive the closure", async () => {
    await updateConversationStatus({ conversationId: CONVERSATION_ID, status: "closed" });
    const serialized = JSON.stringify(mocks.state.conversation);
    // The repeated-ask signature is the thing that regenerated the loop; it
    // must not be anywhere in the row afterwards.
    expect(serialized).not.toContain("intakeAsk");
    expect(serialized).not.toContain("date_of_birth");
    expect(serialized).not.toContain("national_id");
  });

  it("supersedes queued assistant drafts instead of leaving them sendable", async () => {
    await updateConversationStatus({ conversationId: CONVERSATION_ID, status: "closed" });
    expect(mocks.state.suggestions[0]!.status).toBe("superseded");
    // Superseded, never deleted: the record of what the assistant proposed is
    // part of the audit trail.
    expect(mocks.state.suggestions).toHaveLength(1);
    expect(mocks.state.suggestions[0]!.body).toContain("national_id");
  });

  it("keeps the permanent patient identity and profile available", async () => {
    await updateConversationStatus({ conversationId: CONVERSATION_ID, status: "closed" });
    const row = mocks.state.conversation;
    expect(row.patient_id).toBe("patient-1");
    expect(row.patient_link_status).toBe("automatic");
    expect(row.participant_address).toBe("+201000000000");
    expect(row.display_name).toBe("Omar");
    expect(row.identity_verified_at).toBe("2026-08-01T10:00:00.000Z");
    // Nothing in the close path touches a message table or the patient table.
    const tables = new Set(mocks.state.updates.map((update) => update.table));
    expect(tables).toEqual(new Set(["conversations", "ai_suggested_replies"]));
  });

  it("draws the episode boundary so the next message starts a new conversation", async () => {
    // P11O — the state columns above are what the assistant was *doing*; this
    // column is what it was allowed to have *said*. Without it, closing the
    // thread cleared the stage and the model still read the whole previous
    // transcript out of the message tables and carried on.
    const before = new Date().toISOString();
    await updateConversationStatus({ conversationId: CONVERSATION_ID, status: "closed" });
    const boundary = String(mocks.state.conversation.ai_context_reset_at);
    expect(boundary >= before).toBe(true);
    // Message tables are untouched: staff keep the full history.
    const tables = new Set(mocks.state.updates.map((update) => update.table));
    expect(tables.has("inbound_messages")).toBe(false);
    expect(tables.has("outbound_messages")).toBe(false);
  });

  it("does not reset when a thread is re-opened by staff", async () => {
    mocks.state.conversation.status = "closed";
    await updateConversationStatus({ conversationId: CONVERSATION_ID, status: "open" });
    // Re-opening by hand is staff resuming *this* thread, not a new episode.
    expect(mocks.state.updates.some((update) => update.table === "ai_suggested_replies")).toBe(false);
  });
});

describe("P11N — the reset boundary itself", () => {
  it("reports what it superseded and audits the reason without patient content", async () => {
    const result = await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION_ID,
      reason: "reopened",
    });
    expect(result).toEqual({ ok: true, supersededSuggestions: 1 });
    expect(mocks.logAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "patient_conversation_reset",
        params: { reason: "reopened", ok: true, superseded_drafts: 1 },
      }),
    );
  });

  it("leaves the thread status alone — resetting and closing are separate facts", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: CONVERSATION_ID,
      reason: "reopened",
    });
    expect(mocks.state.conversation.status).toBe("open");
    expect(mocks.state.conversation.ai_booking_stage).toBeNull();
  });
});

describe("P11N — a stored draft cannot leak schema identifiers either", () => {
  /**
   * The path P11J-2 did not cover.
   *
   * The field-language gate lives in `patient-reply.ts`, so it protects what
   * the agent *sends*. A draft the agent *stored* — written before that fix, or
   * by any path that forgets the gate — was sent verbatim from
   * `approveAiSuggestion`, which is how "(national_id, date_of_birth)" was
   * still reaching patients after the leak was supposedly closed.
   */
  beforeEach(() => {
    mocks.state.conversation = {
      ...midIntakeConversation(),
      channel: "whatsapp",
    };
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      outboundMessageId: "out-1",
      channel: "whatsapp",
      provider: "linked_device",
      providerMessageId: "wamid.out-1",
    });
  });

  it("translates the identifiers out of a stored draft before it is sent", async () => {
    const result = await approveAiSuggestion({ suggestionId: "11111111-1111-4111-8111-111111111112" });
    expect(result).toMatchObject({ success: true });
    const body = (mocks.sendMessage.mock.calls.at(-1)?.[0] as { body: string }).body;
    expect(body).not.toContain("national_id");
    expect(body).not.toContain("date_of_birth");
    expect(body).toContain("رقم الهوية");
    expect(body).toContain("تاريخ الميلاد");
  });

  it("leaves a clean staff edit exactly as the staff member wrote it", async () => {
    const edited = "ممكن تبعتلي رقم الهوية وتاريخ الميلاد؟";
    await approveAiSuggestion({
      suggestionId: "11111111-1111-4111-8111-111111111112",
      body: edited,
    });
    const body = (mocks.sendMessage.mock.calls.at(-1)?.[0] as { body: string }).body;
    expect(body).toBe(edited);
  });
});
