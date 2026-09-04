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
  inbound: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  departments: Record<string, unknown>[];
} = {
  clinic: null,
  conversation: null,
  suggestions: [],
  conversationUpdates: [],
  inbound: [],
  attachments: [],
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
    // P11T — every episode-scoped read now carries the boundary. These
    // fixtures are all inside one episode, so the bound is accepted and has
    // nothing to exclude; the isolation itself is proved in the P11O/P11T
    // suites, whose stub really applies it.
    builder.gte = chain;
    builder.order = chain;
    // P11C — `loadClinicDepartmentNames` awaits the builder after `.limit()`,
    // so `limit` has to stay thenable rather than return a bare chain.
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
  if (ctx.table === "inbound_message_attachments") {
    return { data: state.attachments, error: null };
  }
  if (ctx.table === "outbound_messages") return { data: [], error: null };
  // P11C — the escalation classifier reads the clinic's live department names
  // before it classifies anything.
  if (ctx.table === "departments") return { data: state.departments, error: null };
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
vi.mock("@/lib/messaging/attachments", () => ({
  // The bytes themselves are not the subject here; how they are framed is.
  readAttachmentBytes: async () => ({
    bytes: Buffer.from("fake-image-bytes"),
    mimeType: "image/jpeg",
  }),
}));
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
    aiTermsAccepted: true,
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
  /** The thread's own beginning: the episode resolver's last-resort boundary. */
  created_at: "2026-01-01T00:00:00.000Z",
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
  state.inbound = [];
  state.attachments = [];
  state.departments = [];
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-1" });
  getEntitlements.mockResolvedValue(
    proAiEntitlements({ "ai.patient_suggest": true, "ai.scheduling": true, "ai.patient_auto": true }),
  );
});

/**
 * The 24/7 guarantee, asserted rather than assumed.
 *
 * ClinicFlow's Patient Assistant answers patients at any hour. A clinic's
 * configured working hours describe *when appointments may be booked* — they are
 * an input to availability, and to nothing else. The two are easy to conflate,
 * and conflating them is a silent product regression rather than a crash: a
 * patient who writes at 02:00 simply gets nothing back until morning, the staff
 * inbox notification looks like the system working, and the only way anyone
 * finds out is a clinic asking why the assistant "stops at five".
 *
 * The mocks above are the P5B orchestrator's own fixtures; the additions here
 * are a clinic with a closed-for-the-night schedule and a message that arrives
 * outside it. Every other AI eligibility condition is deliberately held at its
 * normal passing value — mode `auto`, entitlement granted, thread open, not
 * escalated, not paused — so the only variable is the clock.
 */

/** 09:00–17:00, Sunday to Thursday. Shaped as the clinic settings store it. */
const CLINIC_HOURS = {
  working_hours_start: "09:00",
  working_hours_end: "17:00",
  timezone: "Asia/Kuwait",
};

/** 02:47 local time on a Friday: outside the schedule on both counts. */
const AFTER_HOURS = "2026-02-27T23:47:00.000Z";

describe("P11U — the Patient Assistant answers outside clinic working hours", () => {
  it("auto-sends a fresh inbound that arrives in the middle of the night", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_HOURS));
    try {
      state.clinic = { ...CLINIC, ...CLINIC_HOURS, ai_reply_mode: "auto" };
      const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9am to 5pm." });

      const outcome = await runPatientInboundAiReply(
        baseInput({ messageText: "are you open tomorrow?" }),
        { runAgent },
      );

      // The whole claim: the agent ran and the reply went out, at 02:47, on a
      // day the clinic is closed.
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ status: "auto_sent", outboundMessageId: "out-1" });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(state.suggestions[0]).toMatchObject({ status: "sent", mode: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still drafts a suggestion after hours when the clinic is in suggest mode", async () => {
    // Suggest mode is the other half of the same guarantee: the draft has to be
    // waiting for staff when they open, not generated when they do.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_HOURS));
    try {
      state.clinic = { ...CLINIC, ...CLINIC_HOURS, ai_reply_mode: "suggest" };
      const runAgent = vi.fn().mockResolvedValue({ ok: true, text: "We open 9am to 5pm." });

      const outcome = await runPatientInboundAiReply(baseInput(), { runAgent });

      expect(outcome.status).toBe("suggested");
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(state.suggestions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates an after-hours emergency and sends the safety copy", async () => {
    // The one message that must never wait for opening time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_HOURS));
    try {
      state.clinic = { ...CLINIC, ...CLINIC_HOURS, ai_reply_mode: "suggest" };

      const outcome = await runPatientInboundAiReply(
        baseInput({ messageText: "I have severe chest pain" }),
        { runAgent: vi.fn() },
      );

      expect(outcome).toMatchObject({ status: "escalated", reason: "emergency", sent: true });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps working hours out of the reply pipeline entirely", async () => {
    // Structural, and deliberately so. The behavioural tests above prove the
    // gate is not there *today*; this one makes adding it a failing test rather
    // than a silent regression, and names the file where hours legitimately
    // belong. `getClinicAiReplyContext` does not even select the columns.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

    for (const file of ["lib/ai/patient-reply.ts", "lib/messaging/webhooks.ts"]) {
      expect(read(file), `${file} must not consult working hours`).not.toMatch(
        /working_hours|workingHours|clinic_working_hours/,
      );
    }

    // And the place hours *are* consulted is untouched: availability still
    // refuses a slot outside them.
    expect(read("lib/booking/availability.ts")).toMatch(/working_hours_passed/);
    expect(read("lib/booking/availability.ts")).toMatch(/clinic_working_hours/);
  });
});
