import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P15 §3/§4/§2F — who the assistant answers, and what happens when it breaks.
 *
 * The subject is the orchestrator's own gate, not the UI: the requirement is
 * that the *authoritative invocation path* enforces the clinic-wide setting and
 * the per-conversation exception, so a control that is bypassed, stale or
 * simply not rendered cannot cause a reply that the clinic said must not
 * happen. Every case below therefore asserts on whether the agent ran at all.
 *
 * The mocks are the P5B orchestrator's standard boundaries — its database, its
 * send path, its notifier, its audit log — plus the two P15 RPCs.
 */

const sendMessage = vi.fn();
const emitClinicNotification = vi.fn();
const logAgentTool = vi.fn();
const getEntitlements = vi.fn();
const latchTechnicalFailure = vi.fn();
const clearTechnicalFailure = vi.fn();

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
  inbound: Record<string, unknown>[];
  departments: Record<string, unknown>[];
} = {
  clinic: null,
  conversation: null,
  suggestions: [],
  conversationUpdates: [],
  inbound: [],
  departments: [],
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
    builder.gte = chain;
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
    if (ctx.op === "select") return { data: state.inbound, error: null };
    return { data: { id: "inbound-1" }, error: null };
  }
  if (ctx.table === "inbound_message_attachments") return { data: [], error: null };
  if (ctx.table === "outbound_messages") return { data: [], error: null };
  if (ctx.table === "departments") return { data: state.departments, error: null };
  if (ctx.table === "ai_suggested_replies") {
    if (ctx.op === "insert") {
      state.suggestions.push(ctx.payload as SuggestionRow);
      return { data: { id: `sugg-${state.suggestions.length}` }, error: null };
    }
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  resolveConversationEpisode: (input: { startedAt?: string | null }) =>
    Promise.resolve({
      data: [{
        episode_id: "episode-current",
        started_at:
          state.conversation?.ai_context_reset_at ??
          input.startedAt ??
          state.conversation?.created_at ??
          null,
        opened: false,
      }],
      error: null,
    }),
  closeConversationEpisode: () =>
    Promise.resolve({ data: [{ episode_id: "episode-current", closed: true }], error: null }),
  getClinicAiReplyContext: () => Promise.resolve({ data: state.clinic, error: null }),
  normalizeStalePatientConversationEpisode: () =>
    Promise.resolve({ data: [{ reset_performed: false, context_reset_at: null }], error: null }),
  latchConversationAiTechnicalFailure: (...a: unknown[]) => latchTechnicalFailure(...a),
  clearConversationAiTechnicalFailure: (...a: unknown[]) => clearTechnicalFailure(...a),
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

function proAiEntitlements() {
  return resolveEntitlements({
    clinicId: "clinic",
    planSlug: "pro_ai",
    planFeatures: {
      ai_assistant: true,
      "ai.patient_suggest": true,
      "ai.patient_auto": true,
      "ai.scheduling": true,
    },
    subscriptionAllowed: true,
    aiTermsAccepted: true,
  });
}

const CLINIC = {
  name: "Smile Clinic",
  locale: "en",
  country: "KW",
  phone: "+96500000000",
  ai_reply_mode: "auto",
};

/** A live thread with an existing, linked patient. */
const CONVERSATION = {
  status: "open",
  patient_id: "patient-1",
  participant_address: "+96550000000",
  ai_escalated_at: null,
  ai_paused_at: null,
  ai_enabled_override: null,
  created_at: "2026-01-01T00:00:00.000Z",
  assigned_to: null,
};

function baseInput() {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    providerMessageId: "wamid-1",
    messageText: "what are your opening hours?",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = { ...CONVERSATION };
  state.suggestions = [];
  state.conversationUpdates = [];
  state.inbound = [];
  state.departments = [];
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-1" });
  // The orchestrator treats the audit log as fire-and-forget on its safe paths,
  // so the double has to be a promise rather than `undefined`.
  logAgentTool.mockResolvedValue(undefined);
  emitClinicNotification.mockResolvedValue(undefined);
  latchTechnicalFailure.mockResolvedValue({
    data: [{ latched: true, failed_at: "2026-09-08T09:00:07.000Z" }],
    error: null,
  });
  clearTechnicalFailure.mockResolvedValue({ data: false, error: null });
  getEntitlements.mockResolvedValue(proAiEntitlements());
});

describe("P15 §2A/B — the assistant answers a live inbound once", () => {
  it("answers an unlinked stranger — being a patient is not a prerequisite", async () => {
    state.conversation = { ...CONVERSATION, patient_id: null };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "Hello! How can I help?" });

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "auto_sent", outboundMessageId: "out-1" });
  });

  it("answers an existing conversation exactly once", async () => {
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9 to 5." });

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "auto_sent" });
  });
});

describe("P15 §3 — the clinic-wide switch, enforced server-side", () => {
  it("does not invoke the assistant when the clinic switch is off", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "off" };
    const runAgent = vi.fn();

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "disabled" });
  });

  /**
   * The asymmetric half of the model, and the one a UI-only implementation
   * would get wrong: the clinic has switched the assistant off everywhere and
   * then explicitly admitted this one thread. It must be answered.
   */
  it("answers a conversation the clinic admitted while the switch is off", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "off" };
    state.conversation = { ...CONVERSATION, ai_enabled_override: true };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "Yes, we do." });

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "auto_sent" });
  });

  it("does not invoke the assistant on a conversation the clinic excluded", async () => {
    state.conversation = { ...CONVERSATION, ai_enabled_override: false };
    const runAgent = vi.fn();

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "ai_disabled_for_conversation",
    });
  });

  /**
   * An admitted conversation cannot buy a feature the clinic has not got. The
   * entitlement gate is the one thing an exception may never overrule, and it
   * still fails closed.
   */
  it("still refuses an admitted conversation without the base entitlement", async () => {
    state.clinic = { ...CLINIC, ai_reply_mode: "off" };
    state.conversation = { ...CONVERSATION, ai_enabled_override: true };
    getEntitlements.mockResolvedValue(
      resolveEntitlements({
        clinicId: "clinic",
        planSlug: "starter",
        planFeatures: { ai_assistant: false },
        subscriptionAllowed: true,
        aiTermsAccepted: true,
      }),
    );
    const runAgent = vi.fn();

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "disabled", mode: "off" });
  });

  /**
   * P8's human takeover is preserved exactly: a colleague holding the thread
   * still gets the one-click draft, and nothing is sent. The P15 gate is
   * deliberately not applied to a takeover, because the two controls answer
   * different questions.
   */
  it("keeps drafting for a human takeover rather than skipping the turn", async () => {
    state.conversation = {
      ...CONVERSATION,
      ai_paused_at: "2026-09-08T09:00:00.000Z",
      ai_enabled_override: false,
    };
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "Draft for staff." });

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "suggested_paused" });
  });
});

describe("P15 §2F — a technical failure sends one apology and stops", () => {
  it("sends one safe localized fallback and latches the failure", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "technical_failure", latched: true });
    expect(latchTechnicalFailure).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = sendMessage.mock.calls[0]![0]!.body as string;
    // The patient is told something actionable and nothing technical.
    expect(body).toContain("temporary technical issue");
    expect(body).not.toMatch(/provider|exploded|error|stack|tool/i);
  });

  it("says it in Arabic to an Arabic conversation", async () => {
    state.clinic = { ...CLINIC, locale: "ar" };
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    await runPatientInboundAiReply(
      { ...baseInput(), messageText: "ممكن أعرف مواعيد العيادة؟" },
      { runAgent },
    );

    expect(sendMessage.mock.calls[0]![0]!.body).toBe(
      "حصلت مشكلة تقنية مؤقتة. حد من فريق العيادة هيتواصل معاك في أقرب وقت.",
    );
  });

  /**
   * The idempotency requirement, expressed the way it is actually enforced:
   * the latch RPC decides, and a caller told "somebody already latched this"
   * sends nothing. A webhook retry, a duplicate provider delivery and two
   * workers racing the same turn all take this branch.
   */
  it("sends nothing when the failure was already latched", async () => {
    latchTechnicalFailure.mockResolvedValue({
      data: [{ latched: false, failed_at: "2026-09-08T09:00:07.000Z" }],
      error: null,
    });
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "technical_failure", latched: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * The database is the thing that is broken. An unlatched apology is an
   * unbounded apology, so nothing is sent — staff have already been notified
   * by the webhook, which is the correct degradation.
   */
  it("sends nothing when the latch itself fails", async () => {
    latchTechnicalFailure.mockRejectedValue(new Error("database unavailable"));
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "technical_failure", latched: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * The explicit non-goal. An agent that answers but is unsure is not a
   * technical fault, and must keep taking the existing escalation path rather
   * than sending the patient a breakage apology.
   */
  it("does not treat low confidence as a technical failure", async () => {
    const runAgent = vi.fn().mockResolvedValue({ ok: false, text: "" });

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "escalated", reason: "low_confidence" });
    expect(latchTechnicalFailure).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("clears the latch once the assistant answers successfully again", async () => {
    const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9 to 5." });

    await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(clearTechnicalFailure).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
    });
  });
});
