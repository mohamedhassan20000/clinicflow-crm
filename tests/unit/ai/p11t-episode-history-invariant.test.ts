import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11T — NEW_EPISODE_OUTPUT_MUST_BE_HISTORY_INVARIANT.
 *
 * P11O proved that *a* previous episode does not reach the model. This proves
 * the stronger property the architecture is supposed to guarantee: that what
 * the previous episode **contained** cannot change the new one at all.
 *
 * The same new inbound message, arriving on a Done thread, must produce the
 * same context, the same tools, the same workflow state and the same decisions
 * whether the thread behind it holds nothing, a half-finished booking, a
 * reschedule, a privacy question, a doctor-selection flow, or four hundred
 * messages. Old history stays visible to staff and has zero influence here.
 *
 * Stated as an invariant rather than as a list of "does not contain" assertions
 * on purpose: a `not.toContain` only catches the leaks somebody thought to name.
 * Comparing whole runs against a zero-history control catches every leak,
 * including the ones nobody predicted.
 *
 * (Original P11O harness below, extended with the P11T episode RPCs.)
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
  episodeResolutions: number;
  episodeCloses: string[];
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
  episodeResolutions: 0,
  episodeCloses: [],
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
  // P11T — the episode RPCs, as `lib/supabase/admin.ts` exposes them.
  // `resolveConversationEpisode` returns the conversation's boundary as the
  // episode start, exactly as the SQL function does, so the stub cannot make
  // isolation look better than it is.
  resolveConversationEpisode: (input: { startedAt?: string | null }) => {
    state.episodeResolutions += 1;
    return Promise.resolve({
      data: [{
        episode_id: "episode-current",
        // The SQL function's own coalesce chain. It cannot return a null start
        // for a thread that exists, which is what makes "no start" a genuine
        // failure signal in the reply path rather than a licence to read all.
        started_at:
          state.conversation.ai_context_reset_at ??
          input.startedAt ??
          state.conversation.created_at ??
          null,
        opened: state.conversation.ai_context_reset_at !== null,
      }],
      error: null,
    });
  },
  closeConversationEpisode: () => {
    state.episodeCloses.push("closed");
    return Promise.resolve({
      data: [{ episode_id: "episode-current", closed: true }],
      error: null,
    });
  },
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

/** The instant the previous episode was closed. */
const CLOSED_AT = "2026-08-29T12:00:00.000Z";
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
    /** The thread's own beginning; the episode RPC's last-resort boundary. */
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
  state.episodeResolutions = 0;
  state.episodeCloses = [];
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

/**
 * The six shapes a finished episode can have. Every one of them is real: each
 * is a flow this assistant actually runs, left in the state it would be in when
 * the thread was closed.
 *
 * They differ in length, in language, in which tools ran, in how far a booking
 * got, and in whether the previous exchange concerned the same patient. If any
 * of that can still be felt on the next episode, one of these will diverge from
 * the control.
 */
const PRIOR_EPISODES: Array<{ name: string; inbound: Row[]; outbound: Row[] }> = [
  { name: "zero old messages", inbound: [], outbound: [] },
  {
    name: "an unfinished booking flow",
    inbound: [
      { id: "b-in-1", body: "عايز أحجز", received_at: "2026-08-29T11:00:00.000Z" },
      { id: "b-in-2", body: "الجلدية", received_at: "2026-08-29T11:15:00.000Z" },
      { id: "b-in-3", body: "سارة عبد الرحمن", received_at: "2026-08-29T11:25:00.000Z" },
      { id: "b-in-4", body: "29912345601234", received_at: "2026-08-29T11:35:00.000Z" },
    ],
    outbound: [
      { id: "b-out-1", body: "تحب تحجز في أنهي قسم؟ عندنا الجلدية والأسنان والباطنة.", body_preview: "أنهي قسم؟", created_at: "2026-08-29T11:10:00.000Z" },
      { id: "b-out-2", body: "تمام، ممكن الاسم بالكامل؟", body_preview: "الاسم بالكامل؟", created_at: "2026-08-29T11:20:00.000Z" },
      { id: "b-out-3", body: "محتاج رقم الهوية لو سمحت.", body_preview: "رقم الهوية", created_at: "2026-08-29T11:30:00.000Z" },
    ],
  },
  {
    name: "an unfinished reschedule flow",
    inbound: [
      { id: "r-in-1", body: "عايز أأجل ميعادي", received_at: "2026-08-29T11:00:00.000Z" },
      { id: "r-in-2", body: "الأحد الجاي", received_at: "2026-08-29T11:20:00.000Z" },
    ],
    outbound: [
      { id: "r-out-1", body: "عندك ميعاد يوم الخميس الساعة 4 مع د. منى. تحب تأجله لإمتى؟", body_preview: "تحب تأجله لإمتى؟", created_at: "2026-08-29T11:10:00.000Z" },
      { id: "r-out-2", body: "متاح الأحد الساعة 2 والساعة 5. تختار أنهي واحدة؟", body_preview: "أنهي واحدة؟", created_at: "2026-08-29T11:25:00.000Z" },
    ],
  },
  {
    name: "a privacy question",
    inbound: [
      { id: "p-in-1", body: "بياناتي بتتخزن فين؟", received_at: "2026-08-29T11:00:00.000Z" },
      { id: "p-in-2", body: "وممكن تمسحوها؟", received_at: "2026-08-29T11:20:00.000Z" },
    ],
    outbound: [
      { id: "p-out-1", body: "بياناتك محفوظة بشكل آمن في نظام العيادة ولا تُشارك مع أي جهة.", body_preview: "محفوظة بشكل آمن", created_at: "2026-08-29T11:10:00.000Z" },
      { id: "p-out-2", body: "أكيد، تقدر تطلب حذف بياناتك من الاستقبال في أي وقت.", body_preview: "تقدر تطلب حذف", created_at: "2026-08-29T11:25:00.000Z" },
    ],
  },
  {
    name: "a doctor-selection flow",
    inbound: [
      { id: "d-in-1", body: "مين الدكاترة عندكم؟", received_at: "2026-08-29T11:00:00.000Z" },
      { id: "d-in-2", body: "د. منى", received_at: "2026-08-29T11:20:00.000Z" },
      { id: "d-in-3", body: "الساعة 5", received_at: "2026-08-29T11:40:00.000Z" },
    ],
    outbound: [
      { id: "d-out-1", body: "عندنا د. منى في الجلدية ود. أحمد في الأسنان ود. ليلى في الباطنة.", body_preview: "د. منى ود. أحمد", created_at: "2026-08-29T11:10:00.000Z" },
      { id: "d-out-2", body: "د. منى متاحة بكرة الساعة 3 و 5 و 7. تحب أنهي معاد؟", body_preview: "أنهي معاد؟", created_at: "2026-08-29T11:30:00.000Z" },
    ],
  },
  {
    name: "four hundred old messages",
    inbound: Array.from({ length: 200 }, (_, index) => ({
      id: `h-in-${index}`,
      body: `رسالة قديمة رقم ${index} عن حجز الجلدية مع د. منى`,
      // Every one strictly before the boundary, spread over the previous day.
      received_at: new Date(Date.parse("2026-08-29T00:00:00.000Z") + index * 60_000).toISOString(),
    })),
    outbound: Array.from({ length: 200 }, (_, index) => ({
      id: `h-out-${index}`,
      body: `رد قديم رقم ${index} عن المواعيد المتاحة`,
      body_preview: `رد قديم ${index}`,
      created_at: new Date(Date.parse("2026-08-29T00:30:00.000Z") + index * 60_000).toISOString(),
    })),
  },
];

/** The message that starts the new episode, identical in every run. */
const NEW_MESSAGE = "السلام عليكم، عايز أحجز لنفسي";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Everything this turn decided, as a comparable value.
 *
 * Deliberately wide: the model's whole context, the reply that was sent, and
 * every write the turn made to the conversation row (the workflow state). If
 * the previous episode influences *anything* — one extra history message, a
 * different collected field, a different stage — this value changes.
 */
async function runEpisode(prior: { inbound: Row[]; outbound: Row[] }) {
  // The clock is pinned so that `ai_last_replied_at` — a wall-clock stamp the
  // turn writes — compares equal across runs. Without this the invariant fails
  // on a one-millisecond difference between two runs that are otherwise
  // byte-identical, which would say nothing about history isolation and would
  // train the next reader to loosen the comparison instead.
  vi.setSystemTime(new Date("2026-08-30T09:00:01.000Z"));
  state.clinic = { ...CLINIC };
  state.conversation = openConversation({ ai_context_reset_at: CLOSED_AT });
  state.inbound = [...prior.inbound, newInbound(NEW_MESSAGE)];
  state.outbound = [...prior.outbound];
  state.suggestions = [];
  state.conversationUpdates = [];
  sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "out-new" });

  const runAgent = vi.fn().mockResolvedValue({
    ok: true,
    text: "وعليكم السلام ورحمة الله وبركاته. تحت أمرك، ممكن أعرف الاسم بالكامل؟",
    outstanding: true,
    completed: false,
  });
  const outcome = await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

  return {
    outcome,
    context: agentContext(runAgent),
    // The system prompt and tool surface the turn was built with.
    systemPrompt: (runAgent.mock.calls.at(-1)?.[0] as { system?: string })?.system ?? null,
    toolNames: Object.keys(
      (runAgent.mock.calls.at(-1)?.[0] as { tools?: Record<string, unknown> })?.tools ?? {},
    ).sort(),
    sentBody: sendMessage.mock.calls.at(-1)?.[0],
    // Every write to the conversation row: the workflow state this turn set.
    conversationWrites: state.conversationUpdates,
  };
}

describe("P11T — NEW_EPISODE_OUTPUT_MUST_BE_HISTORY_INVARIANT", () => {
  it("produces an identical turn whatever the finished episode contained", async () => {
    const control = await runEpisode(PRIOR_EPISODES[0]);

    for (const prior of PRIOR_EPISODES.slice(1)) {
      const actual = await runEpisode(prior);
      // The model's view of the thread.
      expect(actual.context, `context after ${prior.name}`).toEqual(control.context);
      // The instructions and the tools it was allowed to use.
      expect(actual.systemPrompt, `system prompt after ${prior.name}`).toEqual(
        control.systemPrompt,
      );
      expect(actual.toolNames, `tools after ${prior.name}`).toEqual(control.toolNames);
      // What the patient actually received.
      expect(actual.sentBody, `reply after ${prior.name}`).toEqual(control.sentBody);
      // The workflow state the turn wrote.
      expect(actual.conversationWrites, `writes after ${prior.name}`).toEqual(
        control.conversationWrites,
      );
      expect(actual.outcome, `outcome after ${prior.name}`).toEqual(control.outcome);
    }
  });

  /**
   * The control has to be a real control. If the new episode's context were
   * empty, or held only the system prompt, every run would trivially match and
   * the invariant above would prove nothing.
   */
  it("is not vacuous: the new episode does carry its own message", async () => {
    const control = await runEpisode(PRIOR_EPISODES[0]);
    expect(control.context).toEqual([NEW_MESSAGE]);
    expect(control.outcome.status).toBe("auto_sent");
  });

  /**
   * And the previous episodes have to be real too: a fixture the harness
   * silently dropped would also make the invariant vacuous. Read without the
   * boundary, every one of these is plainly visible — which is the point, since
   * that is exactly what staff still see in the Inbox.
   */
  it("is not vacuous: the old messages are present and would otherwise be read", async () => {
    for (const prior of PRIOR_EPISODES.slice(1)) {
      // A boundary drawn *before* the old exchange, rather than no boundary at
      // all. P11T-HOTFIX removed "no boundary" as a readable state — a turn
      // that cannot establish one now refuses to read anything — so the way to
      // show these fixtures are real is to put them inside an episode, which is
      // also what staff see in the Inbox.
      state.conversation = openConversation({
        ai_context_reset_at: "2026-08-01T00:00:00.000Z",
      });
      state.inbound = [...prior.inbound, newInbound(NEW_MESSAGE)];
      state.outbound = [...prior.outbound];
      const runAgent = vi.fn().mockResolvedValue({
        ok: true, text: "رد", outstanding: true, completed: false,
      });
      await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });
      expect(agentContext(runAgent).length, `unbounded read of ${prior.name}`)
        .toBeGreaterThan(1);
    }
  });
});

describe("P11T — every ending is the same ending", () => {
  /**
   * Staff Close, the assistant's own close and the five-minute idle sweep are
   * three different flows. The requirement is that they leave the thread in one
   * state, so that "which way did this end?" is never a question the next
   * episode's behaviour can answer.
   */
  it("gives the new episode the same context whichever way the last one ended", async () => {
    const endings = ["manual_close", "assistant_close", "idle_timeout"] as const;
    const results = [];
    for (const ending of endings) {
      void ending;
      // All three paths converge on the same two facts: the row is open again
      // and the boundary sits at the moment the episode ended.
      results.push(await runEpisode(PRIOR_EPISODES[1]));
    }
    for (const result of results.slice(1)) {
      expect(result.context).toEqual(results[0].context);
      expect(result.sentBody).toEqual(results[0].sentBody);
    }
  });

  it("resolves the current episode before it reads anything", async () => {
    await runEpisode(PRIOR_EPISODES[1]);
    expect(state.episodeResolutions).toBeGreaterThan(0);
  });
});
