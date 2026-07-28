import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks: the orchestrator's DB, send, notify, and audit boundaries.
const sendMessage = vi.fn();
const emitClinicNotification = vi.fn();
const logAgentTool = vi.fn();
const getEntitlements = vi.fn();

type SuggestionRow = {
  status: string;
  mode: string;
  body: string;
  escalate: boolean;
  escalation_reason: string | null;
  outbound_message_id: string | null;
};

const state: {
  clinic: Record<string, unknown> | null;
  conversation: Record<string, unknown> | null;
  suggestions: SuggestionRow[];
  conversationUpdates: Record<string, unknown>[];
} = {
  clinic: null,
  conversation: null,
  suggestions: [],
  conversationUpdates: [],
};

function makeScopedClient() {
  const from = (table: string) => {
    const ctx: { table: string; op: string; payload: unknown } = {
      table,
      op: "select",
      payload: null,
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.is = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.insert = (payload: unknown) => {
      ctx.op = "insert";
      ctx.payload = payload;
      return builder;
    };
    builder.update = (payload: unknown) => {
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

function resolve(ctx: { table: string; op: string; payload: unknown }) {
  if (ctx.table === "clinics") return { data: state.clinic, error: null };
  if (ctx.table === "conversations") {
    if (ctx.op === "update") {
      state.conversationUpdates.push(ctx.payload as Record<string, unknown>);
      return { data: { id: "conv" }, error: null };
    }
    return { data: state.conversation, error: null };
  }
  if (ctx.table === "inbound_messages") {
    if (ctx.op === "select") return { data: [], error: null };
    return { data: { id: "inbound-1" }, error: null };
  }
  if (ctx.table === "outbound_messages") return { data: [], error: null };
  if (ctx.table === "ai_suggested_replies") {
    if (ctx.op === "insert") {
      const row = ctx.payload as SuggestionRow;
      state.suggestions.push(row);
      return { data: { id: `sugg-${state.suggestions.length}` }, error: null };
    }
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  getClinicAiReplyContext: () => Promise.resolve({ data: state.clinic, error: null }),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: (...a: unknown[]) => emitClinicNotification(...a),
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: (...a: unknown[]) => logAgentTool(...a) }));
vi.mock("@/lib/entitlements", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entitlements")>("@/lib/entitlements");
  return { ...actual, getEntitlements: (...a: unknown[]) => getEntitlements(...a) };
});

import { runPatientInboundAiReply } from "@/lib/ai/patient-reply";
import { resolveEntitlements } from "@/lib/entitlements";

function proAiEntitlements(features: Record<string, boolean>) {
  return resolveEntitlements({
    clinicId: "clinic",
    planSlug: "pro_ai",
    planFeatures: { ai_assistant: true, ...features },
    subscriptionAllowed: true,
  });
}

const CLINIC = {
  name: "Smile Clinic",
  locale: "en",
  country: "KW",
  phone: "+96500000000",
  ai_reply_mode: "suggest",
};
const OPEN_CONVERSATION = {
  status: "open",
  patient_id: "patient-1",
  participant_address: "+96550000000",
  ai_escalated_at: null,
  assigned_to: null,
};

function baseInput(overrides: Partial<Parameters<typeof runPatientInboundAiReply>[0]> = {}) {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    providerMessageId: "wamid-1",
    messageText: "what are your opening hours?",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = { ...OPEN_CONVERSATION };
  state.suggestions = [];
  state.conversationUpdates = [];
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-1" });
  getEntitlements.mockResolvedValue(
    proAiEntitlements({ "ai.patient_suggest": true, "ai.scheduling": true, "ai.patient_auto": true }),
  );
});

describe("P5B — patient reply orchestrator (§6.2)", () => {
  it("returns disabled when the clinic reply mode is off", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "off" };
    const runAgent = vi.fn();
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome).toEqual({ status: "disabled", mode: "off" });
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suggest mode records a pending suggestion and notifies staff without sending", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "suggest" };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9am to 5pm." });
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome.status).toBe("suggested");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0]).toMatchObject({ status: "pending", mode: "suggest", escalate: false });
    expect(emitClinicNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ai_suggestion" }),
    );
  });

  it("auto mode sends the reply and records it as sent", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "auto" };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9am to 5pm." });
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome).toMatchObject({ status: "auto_sent", outboundMessageId: "out-1" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state.suggestions[0]).toMatchObject({ status: "sent", mode: "auto", outbound_message_id: "out-1" });
  });

  it("escalates an emergency and sends the safety response even in suggest mode", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "suggest" };
    const runAgent = vi.fn();
    const outcome = await runPatientInboundAiReply(
      baseInput({ messageText: "I have severe chest pain" }),
      { runAgent },
    );
    expect(outcome).toMatchObject({ status: "escalated", reason: "emergency", sent: true });
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(emitClinicNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ai_escalation" }),
    );
    expect(state.conversationUpdates.some((u) => u.ai_escalation_reason === "emergency")).toBe(true);
  });

  it("escalates an explicit human request; suggest mode does not auto-send", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "suggest" };
    const outcome = await runPatientInboundAiReply(
      baseInput({ messageText: "I want to talk to a human" }),
      { runAgent: vi.fn() },
    );
    expect(outcome).toMatchObject({ status: "escalated", reason: "human_requested", sent: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.suggestions[0]).toMatchObject({ status: "pending", escalate: true });
  });

  it("escalates to a human on a low-confidence (empty) model answer", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "auto" };
    const runAgent = vi.fn().mockResolvedValue({ ok: false, text: "" });
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome).toMatchObject({ status: "escalated", reason: "low_confidence" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips a conversation already handed to a human", async () => {
    state.conversation = { ...OPEN_CONVERSATION, ai_escalated_at: "2026-07-28T00:00:00Z" };
    const runAgent = vi.fn();
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome).toEqual({ status: "skipped", reason: "already_escalated" });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("skips a closed conversation", async () => {
    state.conversation = { ...OPEN_CONVERSATION, status: "closed" };
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent: vi.fn() });
    expect(outcome).toEqual({ status: "skipped", reason: "conversation_unavailable" });
  });

  it("degrades to a human when the agent throws", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "auto" };
    const runAgent = vi.fn().mockRejectedValue(new Error("provider down"));
    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(outcome).toMatchObject({ status: "escalated", reason: "low_confidence" });
  });

  it("routes to the FAQ task when scheduling is not entitled", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "suggest" };
    getEntitlements.mockResolvedValue(
      proAiEntitlements({ "ai.patient_suggest": true, "ai.scheduling": false }),
    );
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "hi" });
    await runPatientInboundAiReply(baseInput(), { runAgent });
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ task: "patient_faq" }));
  });
});
