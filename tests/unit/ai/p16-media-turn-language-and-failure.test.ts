import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P16 — the photo that turned an Arabic thread red and apologised in English.
 *
 * One real patient sent one ordinary picture. Three separate things went wrong
 * on that turn and this file pins all three, on the P15 orchestrator harness:
 *
 *   1. the assistant answered in *English* on a thread that had been Arabic for
 *      twenty turns, because the worker's `[image]` marker is five Latin
 *      letters and the language resolver read it as the patient's own words;
 *   2. an inbound image was classified as a **technical** failure, so the
 *      thread went to "Problem" and the patient got a breakage apology — for a
 *      photograph, which is not a fault;
 *   3. and there was no size of photograph that would have worked: the
 *      certified per-step input guard measures bytes, and any real image's
 *      base64 exceeds a `patient_booking` step's entire budget.
 *
 * What must not change is the other half of §2F: a genuine fault still latches
 * once, still apologises once, and still says nothing technical.
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


/**
 * The worker's stand-in for an uncaptioned photo. Stored in `body`, and
 * therefore what the orchestrator receives as the turn's text.
 */
const IMAGE_MARKER = "[image]";

const ARABIC_FALLBACK =
  "حصلت مشكلة تقنية مؤقتة. حد من فريق العيادة هيتواصل معاك في أقرب وقت.";
const ENGLISH_FALLBACK =
  "We hit a temporary technical issue. Someone from the clinic team will get back to you as soon as possible.";

/** An input-limit refusal, thrown exactly where the real guard throws it. */
class InputLimit extends Error {
  constructor() {
    super("AI input exceeds the certified task policy.");
    this.name = "AiPolicyInputLimitError";
  }
}

describe("P16 — the fallback speaks the conversation's language, not the clinic's", () => {
  it("apologises in Arabic on an Arabic thread whose newest turn is a photo", async () => {
    // The clinic is configured English on purpose: this is the exact
    // production shape, and choosing the language from the clinic (or from the
    // staff member's own UI locale) is the bug.
    state.clinic = { ...CLINIC, locale: "en" };
    state.inbound = [
      { id: "in-3", body: IMAGE_MARKER, received_at: "2026-09-03T01:32:15.000Z" },
      { id: "in-2", body: "عربي كلمني", received_at: "2026-09-03T01:31:00.000Z" },
      { id: "in-1", body: "عايز أحجز معاد", received_at: "2026-09-03T01:30:00.000Z" },
    ];
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(
      { ...baseInput(), messageText: IMAGE_MARKER },
      { runAgent },
    );

    expect(outcome).toMatchObject({ status: "technical_failure", latched: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]!.body).toBe(ARABIC_FALLBACK);
  });

  it("apologises in English on an English thread whose newest turn is a photo", async () => {
    state.clinic = { ...CLINIC, locale: "ar" };
    state.inbound = [
      { id: "in-2", body: IMAGE_MARKER, received_at: "2026-09-03T01:32:15.000Z" },
      { id: "in-1", body: "can I book tomorrow please", received_at: "2026-09-03T01:30:00.000Z" },
    ];
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    await runPatientInboundAiReply(
      { ...baseInput(), messageText: IMAGE_MARKER },
      { runAgent },
    );

    expect(sendMessage.mock.calls[0]![0]!.body).toBe(ENGLISH_FALLBACK);
  });
});

describe("P16 — a patient's media is not a technical AI failure", () => {
  it("degrades to a human when the turn exceeds the certified input budget", async () => {
    state.inbound = [
      { id: "in-1", body: IMAGE_MARKER, received_at: "2026-09-03T01:32:15.000Z" },
    ];
    const runAgent = vi.fn().mockRejectedValue(new InputLimit());

    const outcome = await runPatientInboundAiReply(
      { ...baseInput(), messageText: IMAGE_MARKER },
      { runAgent },
    );

    // The thread stays on the ordinary escalation path. No "Problem" badge, no
    // breakage apology, no latch — because nothing is broken.
    expect(outcome).toMatchObject({ status: "escalated", reason: "low_confidence" });
    expect(latchTechnicalFailure).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: ARABIC_FALLBACK }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: ENGLISH_FALLBACK }),
    );
  });

  it("answers a media-only turn normally when the agent can answer it", async () => {
    state.inbound = [
      { id: "in-1", body: IMAGE_MARKER, received_at: "2026-09-03T01:32:15.000Z" },
    ];
    const runAgent = vi
      .fn()
      .mockResolvedValue({ ok: true, text: "وصلتني الصورة، هبعتها للدكتور." });

    const outcome = await runPatientInboundAiReply(
      { ...baseInput(), messageText: IMAGE_MARKER },
      { runAgent },
    );

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "auto_sent" });
    expect(latchTechnicalFailure).not.toHaveBeenCalled();
  });
});

describe("P16 — a genuine fault still latches once and apologises once", () => {
  it("latches and sends exactly one fallback for a real provider failure", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "technical_failure", latched: true });
    expect(latchTechnicalFailure).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = sendMessage.mock.calls[0]![0]!.body as string;
    expect(body).toBe(ENGLISH_FALLBACK);
    expect(body).not.toMatch(/provider|exploded|stack|token|policy/i);
  });

  it("stays silent on a replayed delivery of the same fault", async () => {
    latchTechnicalFailure.mockResolvedValue({
      data: [{ latched: false, failed_at: "2026-09-03T01:32:19.000Z" }],
      error: null,
    });
    const runAgent = vi.fn().mockRejectedValue(new Error("provider exploded"));

    const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

    expect(outcome).toMatchObject({ status: "technical_failure", latched: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
