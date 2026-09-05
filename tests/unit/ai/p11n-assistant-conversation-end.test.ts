import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11N — the assistant ends its own conversations.
 *
 * The orchestrator is exercised with an injected agent runner, so what is under
 * test is the deterministic half: when the offer is appended, when a negative
 * answer closes the thread, and what closing does to the record.
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
import {
  ANYTHING_ELSE_PROMPT,
  CONVERSATION_CLOSING_REPLY,
} from "@/lib/ai/conversation-lifecycle";

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
    // The thread's own beginning: the episode resolver's last-resort boundary
    // for a thread nobody has closed yet.
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

/** The last body actually handed to the messaging boundary. */
function sentBody(): string {
  const call = sendMessage.mock.calls.at(-1)?.[0] as { body: string } | undefined;
  return call?.body ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = openConversation();
  state.suggestions = [];
  state.conversationUpdates = [];
  state.outbound = [];
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

describe("P11N — a completed request asks whether anything else is needed", () => {
  it("appends the offer when a booking has actually completed", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تم إرسال طلب الحجز وهيتواصل معاك فريق العيادة لتأكيده.",
      outstanding: false,
      completed: true,
    });
    const outcome = await runPatientInboundAiReply(baseInput("احجزلي الأربع"), { runAgent });
    expect(outcome.status).toBe("auto_sent");
    expect(sentBody()).toContain(ANYTHING_ELSE_PROMPT.ar);
    expect(sentBody()).toContain("تم إرسال طلب الحجز");
  });

  it("does NOT ask while a booking or intake is still unfinished", async () => {
    // P11S — this exchange is already under way, so the turn is not the first
    // of an episode and carries no episode opening. What is under test here is
    // the "anything else?" prompt, not the greeting.
    state.outbound = [
      { body: "تحت أمرك.", created_at: "2026-08-29T10:00:00.000Z" },
    ];
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تمام يا فندم، ممكن تاريخ الميلاد؟",
      outstanding: true,
    });
    await runPatientInboundAiReply(baseInput("عمر حسن"), { runAgent });
    expect(sentBody()).not.toContain(ANYTHING_ELSE_PROMPT.ar);
    expect(sentBody()).toBe("تمام يا فندم، ممكن تاريخ الميلاد؟");
    // Nothing was closed and nothing was forgotten.
    expect(state.conversation.status).toBe("open");
    expect(state.conversation.ai_booking_stage).toBeUndefined();
  });

  it("does not ask when the turn's stage state could not be resolved", async () => {
    // An injected runner that says nothing about outstanding work is the same
    // situation as stage tracking being switched off: propose no ending.
    // P11S — this exchange is already under way, so the turn is not the first
    // of an episode and carries no episode opening. What is under test here is
    // the "anything else?" prompt, not the greeting.
    state.outbound = [
      { body: "تحت أمرك.", created_at: "2026-08-29T10:00:00.000Z" },
    ];
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "العيادة فاتحة من ٩ لـ٥." });
    await runPatientInboundAiReply(baseInput("مواعيد العيادة إيه"), { runAgent });
    expect(sentBody()).toBe("العيادة فاتحة من ٩ لـ٥.");
  });

  it("does NOT ask after a trivial FAQ turn that finished nothing", async () => {
    // Nothing outstanding, but nothing accomplished either: the answer stands
    // on its own and the thread simply stays open.
    // P11S — this exchange is already under way, so the turn is not the first
    // of an episode and carries no episode opening. What is under test here is
    // the "anything else?" prompt, not the greeting.
    state.outbound = [
      { body: "تحت أمرك.", created_at: "2026-08-29T10:00:00.000Z" },
    ];
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "الكشف ٣٠٠ جنيه.",
      outstanding: false,
      completed: false,
    });
    const outcome = await runPatientInboundAiReply(baseInput("الكشف بكام؟"), { runAgent });
    expect(outcome.status).toBe("auto_sent");
    expect(sentBody()).toBe("الكشف ٣٠٠ جنيه.");
    expect(sentBody()).not.toContain(ANYTHING_ELSE_PROMPT.ar);
    expect(state.conversation.status).toBe("open");
  });

  it("asks after a cancellation or other completed action", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تم إلغاء الموعد.",
      outstanding: false,
      completed: true,
    });
    await runPatientInboundAiReply(baseInput("ألغي الموعد"), { runAgent });
    expect(sentBody()).toContain(ANYTHING_ELSE_PROMPT.ar);
  });
});

describe("P11N — a negative answer closes the thread and resets the assistant", () => {
  beforeEach(() => {
    // The previous outbound turn is our own offer, which is what makes a bare
    // "لا" an ending rather than an answer.
    state.outbound = [{ body: `تمام.\n\n${ANYTHING_ELSE_PROMPT.ar}`, created_at: "2026-08-29T10:00:00.000Z" }];
  });

  it("sends a short closing line instead of the drafted reply", async () => {
    // `completed` is deliberately absent: ending a conversation does not depend
    // on our having judged the patient's goal substantial.
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تحب أرشحلك دكاترة تانيين؟",
      outstanding: false,
    });
    await runPatientInboundAiReply(baseInput("لا"), { runAgent });
    expect(sentBody()).toBe(CONVERSATION_CLOSING_REPLY.ar);
  });

  it("closes the thread and clears the conversational state", async () => {
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "تمام.", outstanding: false });
    await runPatientInboundAiReply(baseInput("لأ شكرا"), { runAgent });
    expect(state.conversation.status).toBe("closed");
    expect(state.conversation.ai_collected_data).toEqual({});
    expect(state.conversation.ai_pending_clarification).toBeNull();
    expect(state.conversation.ai_booking_stage).toBeNull();
    // The permanent link to the patient's file is untouched.
    expect(state.conversation.patient_id).toBe("patient-1");
    expect(state.conversation.participant_address).toBe("+201000000000");
  });

  it("closes on a bare goodbye even without a preceding offer", async () => {
    state.outbound = [{ body: "تمام يا فندم.", created_at: "2026-08-29T10:00:00.000Z" }];
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "العفو.", outstanding: false });
    await runPatientInboundAiReply(baseInput("شكرا"), { runAgent });
    expect(state.conversation.status).toBe("closed");
  });

  it("keeps the thread open when the patient asks something else", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تمام، هشوفلك مواعيد الأسبوع الجاي.",
      outstanding: true,
    });
    const outcome = await runPatientInboundAiReply(
      baseInput("أيوه، عايز أغير الميعاد"),
      { runAgent },
    );
    expect(outcome.status).toBe("auto_sent");
    expect(state.conversation.status).toBe("open");
    expect(sentBody()).toBe("تمام، هشوفلك مواعيد الأسبوع الجاي.");
  });

  it("never closes a thread whose reply was only drafted, not sent", async () => {
    // Suggest mode: staff have not sent anything, so nothing has ended.
    state.clinic = { ...CLINIC, ai_reply_mode: "suggest" };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "تمام.", outstanding: false });
    const outcome = await runPatientInboundAiReply(baseInput("لا"), { runAgent });
    expect(outcome.status).toBe("suggested");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.conversation.status).toBe("open");
  });
});

describe("P11N — a closed thread is not answered from stale state", () => {
  it("refuses the turn outright while the thread is still closed", async () => {
    state.conversation = { ...openConversation(), status: "closed" };
    const runAgent = vi.fn();
    const outcome = await runPatientInboundAiReply(baseInput("أهلا"), { runAgent });
    expect(outcome).toEqual({ status: "skipped", reason: "conversation_unavailable" });
    expect(runAgent).not.toHaveBeenCalled();
  });
});
