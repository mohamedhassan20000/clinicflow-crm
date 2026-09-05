import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11O — a closed conversation is a *finished episode*, and the next message
 * starts a new one.
 *
 * P11N already cleared the assistant's state columns on close, and the observed
 * bug survived it: close the thread, send "السلام عليكم", and the assistant
 * carried on the previous department flow. Clearing `ai_booking_stage` cannot
 * prevent that, because the model's context is not the stage — it is the
 * thread's own transcript, read unbounded out of `inbound_messages` /
 * `outbound_messages`.
 *
 * These tests assert the boundary at the only place it matters: the messages
 * actually handed to the agent. The runner is injected, so what is under test
 * is the deterministic assembly, not a model.
 */

type Row = Record<string, unknown>;

const sendMessage = vi.fn();
const logAgentTool = vi.fn();
const getEntitlements = vi.fn();

const state: {
  clinic: Row | null;
  conversation: Row;
  inbound: Row[];
  outbound: Row[];
  suggestions: Row[];
  conversationUpdates: Row[];
  deletes: string[];
  softDeletedPatientIds: Set<string>;
  staleResetCount: number;
} = {
  clinic: null,
  conversation: {},
  inbound: [],
  outbound: [],
  suggestions: [],
  conversationUpdates: [],
  deletes: [],
  softDeletedPatientIds: new Set(),
  staleResetCount: 0,
};

type Ctx = {
  table: string;
  op: string;
  payload: Row;
  gte: [string, string][];
  order: string | null;
  ascending: boolean;
};

/**
 * A Supabase-shaped stub that actually *applies* the `gte` filters, so the
 * assertions below are about the rows the query would really return rather than
 * about the shape of the call.
 */
function makeScopedClient() {
  const from = (table: string) => {
    const ctx: Ctx = { table, op: "select", payload: {}, gte: [], order: null, ascending: true };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.is = chain;
    builder.limit = chain;
    builder.gte = (column: string, value: string) => {
      ctx.gte.push([column, value]);
      return builder;
    };
    builder.order = (column: string, options?: { ascending?: boolean }) => {
      ctx.order = column;
      ctx.ascending = options?.ascending !== false;
      return builder;
    };
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
    builder.delete = () => {
      ctx.op = "delete";
      state.deletes.push(table);
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(resolveSingle(ctx));
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolveList(ctx)).then(onF, onR);
    return builder;
  };
  return { from };
}

function applyGte(rows: Row[], ctx: Ctx): Row[] {
  const filtered = rows.filter((row) =>
    ctx.gte.every(([column, value]) => String(row[column] ?? "") >= value),
  );
  if (!ctx.order) return filtered;
  const column = ctx.order;
  return [...filtered].sort((a, b) => {
    const compared = String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
    return ctx.ascending ? compared : -compared;
  });
}

function resolveList(ctx: Ctx) {
  if (ctx.table === "conversations" && ctx.op === "update") {
    state.conversationUpdates.push(ctx.payload);
    Object.assign(state.conversation, ctx.payload);
    return { data: [{ id: "conv-1" }], error: null };
  }
  if (ctx.table === "inbound_messages") return { data: applyGte(state.inbound, ctx), error: null };
  if (ctx.table === "outbound_messages") return { data: applyGte(state.outbound, ctx), error: null };
  if (ctx.table === "ai_suggested_replies") return { data: [], error: null };
  return { data: [], error: null };
}

function resolveSingle(ctx: Ctx) {
  if (ctx.table === "clinics") return { data: state.clinic, error: null };
  if (ctx.table === "conversations") {
    if (ctx.op === "update") {
      state.conversationUpdates.push(ctx.payload);
      Object.assign(state.conversation, ctx.payload);
      return { data: { id: "conv-1" }, error: null };
    }
    return { data: state.conversation, error: null };
  }
  if (ctx.table === "inbound_messages") return { data: { id: "inbound-new" }, error: null };
  if (ctx.table === "ai_suggested_replies" && ctx.op === "insert") {
    state.suggestions.push(ctx.payload);
    return { data: { id: `sugg-${state.suggestions.length}` }, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  /**
   * P11T — `resolve_conversation_episode`, with the SQL function's own
   * `coalesce` chain: the conversation's boundary, then the caller's hint, then
   * the conversation's own `created_at`. It never returns a null start, which
   * is why the reply path can treat "no start" as a hard failure rather than as
   * permission to read the whole thread.
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
        opened: state.conversation.ai_context_reset_at !== null,
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
  normalizeStalePatientConversationEpisode: () => {
    const patientId = typeof state.conversation.patient_id === "string"
      ? state.conversation.patient_id
      : null;
    if (!patientId || !state.softDeletedPatientIds.has(patientId)) {
      return Promise.resolve({
        data: [{ reset_performed: false, context_reset_at: state.conversation.ai_context_reset_at ?? null }],
        error: null,
      });
    }
    const boundary = state.inbound
      .map((row) => String(row.received_at ?? ""))
      .sort()
      .at(-1) ?? new Date().toISOString();
    Object.assign(state.conversation, {
      patient_id: null,
      patient_link_status: "unlinked",
      booking_identity_confirmed_at: null,
      identity_verified_at: null,
      identity_verification_failures: 0,
      identity_verification_locked_until: null,
      ai_collected_data: {},
      ai_pending_clarification: null,
      ai_booking_stage: null,
      ai_escalated_at: null,
      ai_escalation_reason: null,
      ai_paused_at: null,
      ai_last_replied_at: null,
      ai_context_reset_at: boundary,
    });
    state.staleResetCount += 1;
    return Promise.resolve({
      data: [{ reset_performed: true, context_reset_at: boundary }],
      error: null,
    });
  },
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/attachments", () => ({ readAttachmentBytes: async () => null }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: vi.fn() }));
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

/** The previous, finished episode: a department question and a name. */
const CLOSED_AT = "2026-08-29T12:00:00.000Z";
const PREVIOUS_EPISODE: { inbound: Row[]; outbound: Row[] } = {
  inbound: [
    { id: "in-old-1", body: "عايز أحجز", received_at: "2026-08-29T11:00:00.000Z" },
    { id: "in-old-2", body: "سارة عبد الرحمن", received_at: "2026-08-29T11:20:00.000Z" },
  ],
  outbound: [
    {
      id: "out-old-1",
      body: "تحب تحجز في أنهي قسم؟ عندنا الجلدية والأسنان والباطنة.",
      body_preview: "تحب تحجز في أنهي قسم؟",
      created_at: "2026-08-29T11:10:00.000Z",
    },
    {
      id: "out-old-2",
      body: "تمام يا سارة، محتاج تاريخ ميلاد سارة عبد الرحمن.",
      body_preview: "تمام يا سارة",
      created_at: "2026-08-29T11:30:00.000Z",
    },
    // The goodbye the assistant sent just before it closed the thread.
    {
      id: "out-old-3",
      body: CONVERSATION_CLOSING_REPLY.ar,
      body_preview: CONVERSATION_CLOSING_REPLY.ar,
      created_at: "2026-08-29T11:59:59.000Z",
    },
  ],
};

/** The first message of the new episode, arriving after the boundary. */
function newInbound(body: string): Row {
  return { id: "inbound-new", body, received_at: "2026-08-30T09:00:00.000Z" };
}

function openConversation(overrides: Row = {}): Row {
  return {
    id: "conv-1",
    status: "open",
    patient_id: "patient-mohamed",
    participant_address: "+201000000000",
    ai_escalated_at: null,
    ai_paused_at: null,
    ai_context_reset_at: null,
    // The thread's own beginning. `resolve_conversation_episode` falls back to
    // it for a thread that has never been closed, so "no boundary drawn yet"
    // is one explicit episode covering the whole thread rather than an
    // unbounded read.
    created_at: "2026-01-01T00:00:00.000Z",
    assigned_to: null,
    ...overrides,
  };
}

function baseInput(messageText: string) {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    providerMessageId: "wamid-new",
    messageText,
  };
}

/** Everything the agent was actually shown this turn, flattened to text. */
function agentContext(runAgent: ReturnType<typeof vi.fn>): string[] {
  const call = runAgent.mock.calls.at(-1)?.[0] as
    | { messages: { role: string; parts: { type: string; text?: string }[] }[] }
    | undefined;
  return (call?.messages ?? []).map((message) =>
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" "),
  );
}

/**
 * Seeds a thread whose previous episode is finished: the messages are all still
 * there (staff keep them), and the boundary sits after the last of them.
 */
function seedClosedEpisode(newMessage: string, boundary: string | null = CLOSED_AT) {
  state.conversation = openConversation({ ai_context_reset_at: boundary });
  state.inbound = [...PREVIOUS_EPISODE.inbound, newInbound(newMessage)];
  state.outbound = [...PREVIOUS_EPISODE.outbound];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = openConversation();
  state.inbound = [];
  state.outbound = [];
  state.suggestions = [];
  state.conversationUpdates = [];
  state.deletes = [];
  state.softDeletedPatientIds = new Set();
  state.staleResetCount = 0;
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-new" });
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

function greetingRunner() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: "وعليكم السلام ورحمة الله وبركاته، أهلاً وسهلاً. أقدر أساعدك بإيه؟",
    outstanding: false,
    completed: false,
  });
}

describe("P11O — the first turn after a close sees only the new episode", () => {
  it("hands the agent the greeting and nothing else", async () => {
    seedClosedEpisode("السلام عليكم");
    const runAgent = greetingRunner();
    const outcome = await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent });

    expect(outcome.status).toBe("auto_sent");
    expect(agentContext(runAgent)).toEqual(["السلام عليكم"]);
  });

  it("carries no department question across the boundary", async () => {
    seedClosedEpisode("السلام عليكم");
    const runAgent = greetingRunner();
    await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent });

    const context = agentContext(runAgent).join("\n");
    expect(context).not.toContain("قسم");
    expect(context).not.toContain("الجلدية");
  });

  it("cannot inherit a name typed during the previous episode", async () => {
    seedClosedEpisode("السلام عليكم");
    const runAgent = greetingRunner();
    await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent });

    const context = agentContext(runAgent).join("\n");
    expect(context).not.toContain("سارة");
    expect(context).not.toContain("عبد الرحمن");
  });

  it("does not read the previous episode's goodbye as our last turn", async () => {
    // The closing line is the newest outbound row on the thread. Read across
    // the boundary it would become "what we last said", and a bare "لا" on the
    // first turn of a new conversation would close it again on the spot.
    seedClosedEpisode("لا");
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تمام. تحب أساعدك في إيه؟",
      outstanding: false,
      completed: false,
    });
    await runPatientInboundAiReply(baseInput("لا"), { runAgent });

    const body = (sendMessage.mock.calls.at(-1)?.[0] as { body: string }).body;
    expect(body).not.toBe(CONVERSATION_CLOSING_REPLY.ar);
  });

  it("starts a fresh booking flow when the new message is a direct request", async () => {
    seedClosedEpisode("عايز احجز جلدية");
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "أهلاً بيك. تمام، هبدأ حجز في الجلدية.",
      outstanding: true,
    });
    await runPatientInboundAiReply(baseInput("عايز احجز جلدية"), { runAgent });

    expect(agentContext(runAgent)).toEqual(["عايز احجز جلدية"]);
  });
});

describe("soft-deleted patient links start a fresh episode before the agent runs", () => {
  const freshBooking = "مساء الخير، كنت عايز أحجز عند دكتور جلدية لو سمحت";

  function seedStaleDeletedPatient() {
    const deletedPatientId = "patient-deleted";
    state.softDeletedPatientIds.add(deletedPatientId);
    state.conversation = openConversation({
      patient_id: deletedPatientId,
      patient_link_status: "manual",
      booking_identity_confirmed_at: "2026-08-29T10:00:00.000Z",
      identity_verified_at: "2026-08-29T10:00:00.000Z",
      identity_verification_failures: 2,
      identity_verification_locked_until: "2026-09-01T10:00:00.000Z",
      ai_collected_data: {
        full_name: "سارة عبد الرحمن",
        department_id: "old-dermatology",
        doctor_id: "old-doctor",
        appointment_date: "2026-09-10",
        appointment_time: 600,
      },
      ai_pending_clarification: { field: "date_of_birth" },
      ai_booking_stage: {
        stage: "intake_collecting",
        offeredDoctorIds: ["old-doctor"],
        offeredDays: ["2026-09-10"],
        offeredSlots: ["2026-09-10|10:00"],
        turns: 8,
      },
      ai_context_reset_at: null,
    });
    state.inbound = [...PREVIOUS_EPISODE.inbound, newInbound(freshBooking)];
    state.outbound = [...PREVIOUS_EPISODE.outbound];
  }

  it("clears stale identity and booking/intake state before the fresh Arabic booking turn", async () => {
    seedStaleDeletedPatient();
    const runAgent = vi.fn().mockResolvedValue({
      ok: true,
      text: "تمام، هعرض لك دكاترة الجلدية المتاحين.",
      outstanding: true,
    });

    await runPatientInboundAiReply(baseInput(freshBooking), { runAgent });

    expect(state.staleResetCount).toBe(1);
    expect(state.conversation).toMatchObject({
      patient_id: null,
      patient_link_status: "unlinked",
      booking_identity_confirmed_at: null,
      identity_verified_at: null,
      identity_verification_failures: 0,
      identity_verification_locked_until: null,
      ai_collected_data: {},
      ai_pending_clarification: null,
      ai_booking_stage: null,
    });
    expect(state.conversation.ai_context_reset_at).toBe("2026-08-30T09:00:00.000Z");
    expect(agentContext(runAgent)).toEqual([freshBooking]);
    expect(agentContext(runAgent).join("\n")).not.toMatch(/سارة|old-doctor|2026-09-10/);
  });

  it("is idempotent after the invalid link has been detached", async () => {
    seedStaleDeletedPatient();
    const runAgent = greetingRunner();
    await runPatientInboundAiReply(baseInput(freshBooking), { runAgent });
    const boundary = state.conversation.ai_context_reset_at;

    await runPatientInboundAiReply(baseInput(freshBooking), { runAgent });

    expect(state.staleResetCount).toBe(1);
    expect(state.conversation.ai_context_reset_at).toBe(boundary);
  });

  it("does not reset a valid linked patient even when the booking state is populated", async () => {
    state.conversation = openConversation({
      patient_id: "patient-active",
      ai_collected_data: { department_id: "active-department" },
      ai_booking_stage: { stage: "selecting_doctor", offeredDoctorIds: ["active-doctor"] },
    });
    state.inbound = [newInbound(freshBooking)];
    const runAgent = greetingRunner();

    await runPatientInboundAiReply(baseInput(freshBooking), { runAgent });

    expect(state.staleResetCount).toBe(0);
    expect(state.conversation.patient_id).toBe("patient-active");
    expect(state.conversation.ai_collected_data).toEqual({ department_id: "active-department" });
  });
});

describe("P11O — the boundary bounds context only", () => {
  it("never deletes a message: staff keep the whole thread", async () => {
    seedClosedEpisode("السلام عليكم");
    await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent: greetingRunner() });

    expect(state.deletes).toEqual([]);
    expect(state.inbound).toHaveLength(3);
    expect(state.outbound).toHaveLength(3);
    expect(state.inbound.map((row) => row.id)).toContain("in-old-1");
  });

  it("leaves the permanent patient link untouched", async () => {
    seedClosedEpisode("السلام عليكم");
    await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent: greetingRunner() });

    expect(state.conversation.patient_id).toBe("patient-mohamed");
    for (const update of state.conversationUpdates) {
      expect(update).not.toHaveProperty("patient_id");
      expect(update).not.toHaveProperty("patient_link_status");
      expect(update).not.toHaveProperty("display_name");
      expect(update).not.toHaveProperty("identity_verified_at");
    }
  });

  it("shows the agent the whole thread when no boundary has ever been drawn", async () => {
    seedClosedEpisode("كمل معايا", null);
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "تمام.", outstanding: true });
    await runPatientInboundAiReply(baseInput("كمل معايا"), { runAgent });

    expect(agentContext(runAgent)).toHaveLength(6);
    expect(agentContext(runAgent).join("\n")).toContain("سارة");
  });

  it("includes the message that sits exactly on the boundary", async () => {
    // The reopen path stamps the boundary with the triggering message's own
    // arrival time. An exclusive comparison would hide it from the agent.
    state.conversation = openConversation({ ai_context_reset_at: "2026-08-30T09:00:00.000Z" });
    state.inbound = [...PREVIOUS_EPISODE.inbound, newInbound("السلام عليكم")];
    state.outbound = [...PREVIOUS_EPISODE.outbound];
    const runAgent = greetingRunner();
    await runPatientInboundAiReply(baseInput("السلام عليكم"), { runAgent });

    expect(agentContext(runAgent)).toEqual(["السلام عليكم"]);
  });
});

describe("P11O — an AI auto-close leaves the same record as a staff close", () => {
  it("stamps the episode boundary when the assistant ends the thread", async () => {
    state.conversation = openConversation();
    state.inbound = [newInbound("شكرا")];
    state.outbound = [];
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "تمام.", outstanding: false });
    await runPatientInboundAiReply(baseInput("شكرا"), { runAgent });

    expect(state.conversation.status).toBe("closed");
    expect(state.conversation.ai_context_reset_at).toEqual(expect.any(String));
    // Everything the next episode must not inherit is gone with it.
    expect(state.conversation.ai_booking_stage).toBeNull();
    expect(state.conversation.ai_collected_data).toEqual({});
    expect(state.conversation.ai_pending_clarification).toBeNull();
  });

  it("cuts the boundary after the goodbye it just sent", async () => {
    state.conversation = openConversation();
    state.inbound = [newInbound("شكرا")];
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "تمام.", outstanding: false });
    const before = new Date().toISOString();
    await runPatientInboundAiReply(baseInput("شكرا"), { runAgent });

    // The closing line was sent before the close, so it falls outside the new
    // episode and can never be read back as the assistant's previous turn.
    const boundary = String(state.conversation.ai_context_reset_at);
    expect(boundary >= before).toBe(true);
    expect(String(state.conversation.status_updated_at)).toBe(boundary);
  });
});
