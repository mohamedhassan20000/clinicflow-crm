import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Findings 3 and 4 at the integration boundary — the half a unit test on the
 * engine cannot reach.
 *
 * `runPatientTurnV2` computed `handoff` and `ended` and `runCertifiedPatientAgent`
 * dropped both on the floor: nothing in the codebase read either field. So a
 * turn the engine had decided should reach a person was sent as an ordinary
 * reply, on an un-escalated thread, and a turn it had decided ended the
 * conversation left the thread open with its flow stack intact.
 *
 * The orchestrator is exercised with an injected runner standing in for V2, so
 * what is under test is exactly the propagation — not the engine, which the
 * `regressions` suite covers.
 */

type Row = Record<string, unknown>;

const sendMessage = vi.fn();
const emitClinicNotification = vi.fn();
const logAgentTool = vi.fn();
const getEntitlements = vi.fn();

const state: {
  clinic: Row | null;
  conversation: Row;
  suggestions: Row[];
  conversationUpdates: Row[];
  outbound: Row[];
} = {
  clinic: null,
  conversation: {},
  suggestions: [],
  conversationUpdates: [],
  outbound: [],
};

function makeScopedClient() {
  const from = (table: string) => {
    const ctx: { table: string; op: string; payload: Row } = { table, op: "select", payload: {} };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.is = chain;
    // P11T — every episode-scoped read now carries the boundary. These
    // fixtures are all inside one episode, so the bound is accepted and has
    // nothing to exclude; the isolation itself is proved in the P11O/P11T
    // suites, whose stub really applies it.
    builder.gte = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.insert = (payload: Row) => {
      ctx.op = "insert";
      ctx.payload = payload;
      return builder;
    };
    builder.update = (payload: Row) => {
      ctx.op = "update";
      ctx.payload = payload;
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(resolve(ctx));
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(ctx)).then(onF, onR);
    return builder;
  };
  return { from };
}

function resolve(ctx: { table: string; op: string; payload: Row }) {
  if (ctx.table === "clinics") return { data: state.clinic, error: null };
  if (ctx.table === "conversations") {
    if (ctx.op === "update") {
      state.conversationUpdates.push(ctx.payload);
      Object.assign(state.conversation, ctx.payload);
      return { data: { id: "conv-1" }, error: null };
    }
    return { data: state.conversation, error: null };
  }
  if (ctx.table === "inbound_messages") {
    if (ctx.op === "select") return { data: [], error: null };
    return { data: { id: "inbound-1" }, error: null };
  }
  if (ctx.table === "inbound_message_attachments") return { data: [], error: null };
  if (ctx.table === "outbound_messages") return { data: state.outbound, error: null };
  if (ctx.table === "departments") return { data: [], error: null };
  if (ctx.table === "ai_suggested_replies") {
    if (ctx.op === "insert") {
      state.suggestions.push(ctx.payload);
      return { data: { id: `sugg-${state.suggestions.length}` }, error: null };
    }
    return { data: [], error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  /**
   * P11T — `resolve_conversation_episode`. It mirrors the SQL function's own
   * coalesce chain (`ai_context_reset_at` → caller hint → the conversation's
   * `created_at`), so it never answers with a null start — which is why the
   * reply path may treat "no start" as a hard failure rather than as licence to
   * read the whole thread.
   */
  resolveConversationEpisode: (input: { startedAt?: string | null }) =>
    Promise.resolve({
      data: [{
        episode_id: "episode-current",
        started_at:
          state.conversation.ai_context_reset_at ??
          input.startedAt ??
          state.conversation.created_at ??
          null,
        opened: false,
      }],
      error: null,
    }),
  closeConversationEpisode: () =>
    Promise.resolve({ data: [{ episode_id: "episode-current", closed: true }], error: null }),
  getClinicAiReplyContext: () => Promise.resolve({ data: state.clinic, error: null }),
  // P15 (§2F): the technical-failure latch and its self-healing clear. This
  // suite is not about either — they are stubbed so the orchestrator's safe
  // path has a boundary to call, and the P15 suite proves their behaviour.
  latchConversationAiTechnicalFailure: () =>
    Promise.resolve({ data: [{ latched: true, failed_at: "2026-01-02T00:00:00.000Z" }], error: null }),
  clearConversationAiTechnicalFailure: () => Promise.resolve({ data: false, error: null }),
  normalizeStalePatientConversationEpisode: () =>
    Promise.resolve({ data: [{ reset_performed: false, context_reset_at: null }], error: null }),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/attachments", () => ({ readAttachmentBytes: async () => null }));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: (...a: unknown[]) => emitClinicNotification(...a),
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: (...a: unknown[]) => logAgentTool(...a) }));
vi.mock("@/lib/ai/booking-stage-store", () => ({
  markBookingStageEscalated: vi.fn(),
  openBookingStageTurn: vi.fn(),
}));
vi.mock("@/lib/entitlements", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entitlements")>("@/lib/entitlements");
  return { ...actual, getEntitlements: (...a: unknown[]) => getEntitlements(...a) };
});

import { runPatientInboundAiReply } from "@/lib/ai/patient-reply";
import { resolveEntitlements } from "@/lib/entitlements";
import { CONVERSATION_CLOSING_REPLY } from "@/lib/ai/conversation-lifecycle";

const CLINIC = {
  name: "عيادة الابتسامة",
  locale: "ar",
  country: "EG",
  phone: "+20222222222",
  ai_reply_mode: "auto",
  ai_language_mode: "fixed_ar",
  ai_arabic_style: "egyptian",
  ai_tone: "friendly",
  ai_style_instruction: null,
};

function openConversation(): Row {
  return {
    id: "conv-1",
    status: "open",
    patient_id: "patient-1",
    participant_address: "+201000000000",
    ai_escalated_at: null,
    ai_paused_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    assigned_to: null,
  };
}

function baseInput(messageText: string) {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    providerMessageId: "wamid-1",
    messageText,
  };
}

function sentBody(): string {
  const call = sendMessage.mock.calls.at(-1)?.[0] as { body: string } | undefined;
  return call?.body ?? "";
}

/**
 * A message the deterministic detector does not act on.
 *
 * `detectPatientEscalation` runs before the agent and handles the explicit
 * "I want a human". The V2 handoff exists for everything it cannot see — an
 * unsupported request, a step that gave up — so the fixture has to get past it
 * for the propagation to be what is under test.
 */
const NEUTRAL = "محتاج حاجة";

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = openConversation();
  state.suggestions = [];
  state.conversationUpdates = [];
  state.outbound = [{ body: "تحت أمرك.", created_at: "2026-08-29T10:00:00.000Z" }];
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-1" });
  getEntitlements.mockResolvedValue(
    resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: {
        ai_assistant: true,
        "ai.patient_suggest": true,
        "ai.patient_auto": true,
        "ai.scheduling": true,
      },
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    }),
  );
});

describe("finding 3: a V2 handoff escalates the thread", () => {
  const HANDOFF_TEXT = "الطلب ده محتاج حد من فريق العيادة، وهحوّلهم المحادثة دلوقتي.";

  it("escalates with the engine's reason instead of replying normally", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: HANDOFF_TEXT,
      outstanding: false,
      completed: false,
      handoff: { reason: "low_confidence" },
    });
    const outcome = await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });

    expect(runAgent).toHaveBeenCalled();
    expect(outcome.status).toBe("escalated");
    expect(outcome).toMatchObject({ reason: "low_confidence" });
  });

  it("sends the engine's own handoff copy, not a generic greeting", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: HANDOFF_TEXT,
      outstanding: false,
      completed: false,
      handoff: { reason: "human_requested" },
    });
    await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });

    expect(sentBody()).toBe(HANDOFF_TEXT);
    // The defect's signature: the thread answered and stayed open.
    expect(state.conversation.ai_escalated_at).toBeTruthy();
  });

  it("stamps the escalation reason on the record", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: HANDOFF_TEXT,
      outstanding: false,
      completed: false,
      handoff: { reason: "medical" },
    });
    await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });
    expect(state.conversation.ai_escalation_reason).toBe("medical");
  });

  it("records a pending draft rather than sending under a human takeover", async () => {
    state.conversation.ai_paused_at = "2026-09-04T11:59:00.000Z";
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: HANDOFF_TEXT,
      outstanding: false,
      completed: false,
      handoff: { reason: "complaint" },
    });
    const outcome = await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });

    expect(outcome).toMatchObject({ status: "escalated", sent: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.suggestions.at(-1)).toMatchObject({
      status: "pending",
      escalate: true,
      escalation_reason: "complaint",
    });
  });

  it("leaves an ordinary turn completely alone", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "العيادة فاتحة من ٩ لـ٥.",
      outstanding: false,
      completed: false,
      handoff: null,
    });
    const outcome = await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });
    expect(outcome.status).toBe("auto_sent");
    expect(state.conversation.ai_escalated_at).toBeFalsy();
  });
});

describe("finding 3/4: a V2 end_conversation closes the thread", () => {
  it("closes and resets when the engine says the patient is finished", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تحت أمرك في أي وقت.",
      // Deliberately hostile to the heuristics: work outstanding, nothing
      // completed. The engine's verdict is the one that counts.
      outstanding: true,
      completed: false,
      ended: true,
    });
    await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });

    expect(sentBody()).toBe(CONVERSATION_CLOSING_REPLY.ar);
    expect(state.conversation.status).toBe("closed");
    // The episode boundary was drawn, which is what carries the flow-state reset.
    expect(state.conversation.ai_context_reset_at).toBeTruthy();
  });

  it("does not close a turn the engine did not end", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تمام يا فندم، ممكن تاريخ الميلاد؟",
      outstanding: true,
      completed: false,
      ended: false,
    });
    await runPatientInboundAiReply(baseInput(NEUTRAL), { runAgent });
    expect(state.conversation.status).toBe("open");
  });
});
