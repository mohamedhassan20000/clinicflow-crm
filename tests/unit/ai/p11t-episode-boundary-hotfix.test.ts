import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11T-HOTFIX — the proven live episode-boundary leak, as a regression.
 *
 * ## What actually happened
 *
 * A staff member closed a thread. The close ended the episode correctly, the
 * next inbound message opened a new one correctly, and the inbound row carried
 * the new `episode_id`. The reply the patient then received was the *previous*
 * episode's booking turn ("طبيبك المعالج هو د. …"), with no episode opening in
 * front of it — the assistant resumed a conversation the clinic had ended.
 *
 * The cause was not the episode record, which was right throughout. It was that
 * `runPatientReply` built its `EpisodeContext` from
 * `conversation.ai_context_reset_at` — a value read earlier in the request,
 * over a different connection, before this turn's normalize/reopen writes had
 * necessarily landed — and `EpisodeContext.scope` treated a falsy boundary as
 * *no filter*. One stale read therefore turned every episode-scoped query into
 * a full-thread query: the finished exchange went into the prompt, the previous
 * outbound row came back as "what we last said", and because the mandatory
 * episode opening fires exactly when no outbound exists inside the current
 * episode, it was suppressed by the very history it was meant to replace.
 *
 * ## What these tests hold down
 *
 * 1. The authoritative boundary is the one the RPC returned, even when the
 *    conversation snapshot the request is holding is stale or falsy.
 * 2. A turn that cannot establish a boundary reads nothing and writes nothing.
 * 3. Inbound and the assistant's own outbound share one episode id.
 * 4. The episode opening fires on the first turn of a new episode, however long
 *    the finished one was.
 */

type Row = Record<string, unknown>;

const sendMessage = vi.fn();
const logAgentTool = vi.fn();
const getEntitlements = vi.fn();

/** The finished episode's boundary — the instant staff pressed Close. */
const CLOSED_AT = "2026-09-01T13:16:47.071Z";
const NEW_INBOUND_AT = "2026-09-01T13:25:15.000Z";
const OLD_EPISODE_ID = "episode-old";
const NEW_EPISODE_ID = "episode-new";
/** The patient's whole message on the new episode. */
const NEW_MESSAGE = "السلام عليكم ورحمة الله وبركاته كيف الحال";

const state: {
  clinic: Row | null;
  conversation: Row;
  inbound: Row[];
  outbound: Row[];
  conversationUpdates: Row[];
  /** Every `update {episode_id}` the turn wrote, by table. */
  attributions: { table: string; episodeId: unknown }[];
  /** Set when the episode RPC is unavailable, to exercise the closed path. */
  episodeRpcFails: boolean;
  episodeResolutions: number;
  episodeStartHints: Array<string | null | undefined>;
} = {
  clinic: null,
  conversation: {},
  inbound: [],
  outbound: [],
  conversationUpdates: [],
  attributions: [],
  episodeRpcFails: false,
  episodeResolutions: 0,
  episodeStartHints: [],
};

type Ctx = {
  table: string;
  op: string;
  payload: Row;
  gte: [string, string][];
  order: string | null;
  ascending: boolean;
};

/** A Supabase-shaped stub that really applies `gte`, so the assertions below
 * are about the rows a query would return rather than about how it was built. */
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
      if (
        (table === "inbound_messages" || table === "outbound_messages") &&
        "episode_id" in payload
      ) {
        state.attributions.push({ table, episodeId: payload.episode_id });
      }
      return builder;
    };
    builder.delete = chain;
    builder.maybeSingle = () => Promise.resolve(resolveSingle(ctx));
    builder.single = () => Promise.resolve(resolveSingle(ctx));
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
  if (ctx.op === "update") return { data: [{ id: "row" }], error: null };
  if (ctx.table === "inbound_messages") return { data: applyGte(state.inbound, ctx), error: null };
  if (ctx.table === "outbound_messages") return { data: applyGte(state.outbound, ctx), error: null };
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
  if (ctx.table === "inbound_messages" && ctx.op === "select") {
    return { data: { id: "inbound-new", received_at: NEW_INBOUND_AT }, error: null };
  }
  if (ctx.table === "ai_suggested_replies" && ctx.op === "insert") {
    return { data: { id: "sugg-1" }, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  /**
   * The authoritative resolver. It re-reads the conversation row under a lock,
   * so it answers with the *new* episode even while the caller is still holding
   * a snapshot taken before the reopen — which is precisely the divergence the
   * live failure rode in on.
   */
  resolveConversationEpisode: (input: { startedAt?: string | null }) => {
    state.episodeResolutions += 1;
    state.episodeStartHints.push(input.startedAt);
    if (state.episodeRpcFails) return Promise.resolve({ data: null, error: { message: "down" } });
    return Promise.resolve({
      data: [{ episode_id: NEW_EPISODE_ID, started_at: CLOSED_AT, opened: true }],
      error: null,
    });
  },
  closeConversationEpisode: () =>
    Promise.resolve({ data: [{ episode_id: NEW_EPISODE_ID, closed: true }], error: null }),
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

import { EPISODE_OPENING_COPY } from "@/lib/ai/episode-greeting";
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

/**
 * Episode 1, as it stood on the hosted thread: a booking flow that reached the
 * patient's treating doctor, then staff pressed Close.
 */
const EPISODE_ONE = {
  inbound: [
    { id: "e1-in-1", body: "السلام عليكم ورحمة الله وبركاته", received_at: "2026-09-01T12:03:08.000Z", episode_id: OLD_EPISODE_ID },
    { id: "e1-in-2", body: "لا انا ببدا محادثة جديدة معاك", received_at: "2026-09-01T12:03:30.000Z", episode_id: OLD_EPISODE_ID },
    { id: "e1-in-3", body: "طيب اه العلاج الطبيعي عايز اعرف ايه خدماته", received_at: "2026-09-01T12:04:38.000Z", episode_id: OLD_EPISODE_ID },
  ],
  outbound: [
    { id: "e1-out-1", body: "طبيبك المعالج هو د. Ahmed Nabil. تحب أشوف المواعيد المتاحة معاه؟", body_preview: "طبيبك المعالج", created_at: "2026-09-01T12:03:14.212Z", episode_id: OLD_EPISODE_ID },
    { id: "e1-out-2", body: "الأيام المتاحة مع د. Ahmed Nabil:\n- الأربعاء، ٢ سبتمبر ٢٠٢٦", body_preview: "الأيام المتاحة", created_at: "2026-09-01T12:03:37.766Z", episode_id: OLD_EPISODE_ID },
    { id: "e1-out-3", body: "العلاج الطبيعي — 1000 TRY", body_preview: "العلاج الطبيعي", created_at: "2026-09-01T12:04:46.572Z", episode_id: OLD_EPISODE_ID },
  ],
};

function openConversation(overrides: Row = {}): Row {
  return {
    id: "conv-1",
    status: "open",
    patient_id: "patient-mohamed",
    participant_address: "+201000000000",
    ai_escalated_at: null,
    ai_paused_at: null,
    ai_booking_stage: null,
    ai_collected_data: {},
    ai_context_reset_at: CLOSED_AT,
    created_at: "2026-08-17T17:10:23.475Z",
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
  state.inbound = [
    ...EPISODE_ONE.inbound,
    { id: "inbound-new", body: NEW_MESSAGE, received_at: NEW_INBOUND_AT, episode_id: NEW_EPISODE_ID },
  ];
  state.outbound = [...EPISODE_ONE.outbound];
  state.conversationUpdates = [];
  state.attributions = [];
  state.episodeRpcFails = false;
  state.episodeResolutions = 0;
  state.episodeStartHints = [];
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

/** The model's half of the turn: a plain answer with nothing booking-shaped. */
function plainRunner() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: "أنا بخير، الحمد لله. تحت أمرك.",
    outstanding: true,
    completed: false,
  });
}

describe("P11T-HOTFIX — the hosted Close → new inbound failure", () => {
  it("answers the new episode with the mandatory opening and none of episode 1", async () => {
    const runAgent = plainRunner();
    const outcome = await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    // The episode this turn belongs to is not the one staff closed.
    expect(NEW_EPISODE_ID).not.toBe(OLD_EPISODE_ID);
    expect(state.episodeResolutions).toBeGreaterThan(0);

    // Episode 1 is still stored, in full. Nothing here deletes a message.
    expect(state.inbound).toHaveLength(EPISODE_ONE.inbound.length + 1);
    expect(state.outbound.map((row) => row.id)).toEqual(
      expect.arrayContaining(EPISODE_ONE.outbound.map((row) => row.id)),
    );

    // The model saw this episode's single message and nothing else.
    expect(agentContext(runAgent)).toEqual([NEW_MESSAGE]);
    // Every episode-1 body, minus the one whose text the new message happens to
    // begin with — the patient greeted the clinic the same way both times, and
    // asserting on a substring of the turn's own message would prove nothing.
    const contextText = agentContext(runAgent).join("\n");
    for (const row of [...EPISODE_ONE.inbound, ...EPISODE_ONE.outbound]) {
      const body = String(row.body);
      if (NEW_MESSAGE.includes(body)) continue;
      expect(contextText).not.toContain(body);
    }
    expect(contextText).not.toContain("Ahmed Nabil");
    expect(contextText).not.toContain("طبيبك المعالج");
    expect(contextText).not.toContain("ببدا محادثة جديدة");

    // The reply: the Islamic greeting first, then the clinic and the plain
    // statement that this is an automated assistant.
    const sent = sendMessage.mock.calls.at(-1)?.[0] as { body: string };
    expect(sent.body.startsWith(EPISODE_OPENING_COPY.islamicResponse.ar)).toBe(true);
    expect(sent.body).toContain(CLINIC.name);
    expect(sent.body).toContain(EPISODE_OPENING_COPY.introduction.ar);
    // And none of the finished booking flow, in any form.
    expect(sent.body).not.toContain("طبيبك المعالج");
    expect(sent.body).not.toContain("Ahmed Nabil");
    expect(sent.body).not.toContain("الأيام المتاحة");

    // The workflow starts clean: this turn wrote no booking stage and no
    // collected field carried over from the closed episode.
    expect(state.conversation.ai_booking_stage).toBeNull();
    expect(state.conversation.ai_collected_data).toEqual({});
    for (const update of state.conversationUpdates) {
      expect(update).not.toHaveProperty("ai_booking_stage");
      expect(update).not.toHaveProperty("ai_collected_data");
    }

    expect(outcome).toEqual({
      status: "auto_sent",
      suggestionId: "sugg-1",
      outboundMessageId: "out-new",
    });
  });

  it("gives the inbound turn and the assistant's reply the same episode id", async () => {
    await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent: plainRunner() });

    // Written into the outbound row in the same statement that creates it.
    const sent = sendMessage.mock.calls.at(-1)?.[0] as { episodeId?: string };
    expect(sent.episodeId).toBe(NEW_EPISODE_ID);
    expect(sent.episodeId).not.toBeNull();
    expect(sent.episodeId).not.toBe(OLD_EPISODE_ID);

    // And both rows are attributed to it, inbound and outbound alike.
    const tables = state.attributions.map((row) => row.table).sort();
    expect(tables).toEqual(["inbound_messages", "outbound_messages"]);
    for (const attribution of state.attributions) {
      expect(attribution.episodeId).toBe(NEW_EPISODE_ID);
    }
  });

  it("opens the episode even when the finished one held a hundred replies", async () => {
    state.outbound = Array.from({ length: 100 }, (_, index) => ({
      id: `bulk-${index}`,
      body: `رد قديم رقم ${index}`,
      body_preview: `رد قديم ${index}`,
      created_at: new Date(Date.parse("2026-09-01T10:00:00.000Z") + index * 1000).toISOString(),
      episode_id: OLD_EPISODE_ID,
    }));
    const runAgent = plainRunner();
    await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    // "New episode" is the absence of an outbound row *inside this episode*.
    // A hundred outside it are not evidence of anything.
    expect(agentContext(runAgent)).toEqual([NEW_MESSAGE]);
    const sent = sendMessage.mock.calls.at(-1)?.[0] as { body: string };
    expect(sent.body.startsWith(EPISODE_OPENING_COPY.islamicResponse.ar)).toBe(true);
    expect(sent.body).toContain(EPISODE_OPENING_COPY.introduction.ar);
  });
});

describe("P11T-HOTFIX — the resolved episode outranks the request's snapshot", () => {
  it("uses the persisted first inbound timestamp when a new conversation was created milliseconds later", async () => {
    state.conversation = openConversation({
      ai_context_reset_at: null,
      created_at: "2026-09-01T13:25:17.700Z",
      patient_id: null,
    });

    const outcome = await runPatientInboundAiReply(baseInput(NEW_MESSAGE), {
      runAgent: plainRunner(),
    });

    // A new conversation can be committed after the provider's received_at.
    // Using created_at would exclude the triggering inbound from its own
    // episode. The persisted inbound timestamp is the safe lower bound.
    expect(state.episodeStartHints[0]).toBe(NEW_INBOUND_AT);
    expect(state.episodeStartHints[0]).not.toBe(state.conversation.created_at);
    expect(state.conversation.patient_id).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("auto_sent");
  });

  /**
   * The exact shape of the live defect: the conversation object the request is
   * holding has no boundary on it, while the authoritative resolver — reading
   * the same row under a lock, moments later — returns the correct one. The
   * turn must follow the resolver.
   */
  it("bounds context by the resolved episode when the snapshot is falsy", async () => {
    state.conversation = openConversation({ ai_context_reset_at: null });
    const runAgent = plainRunner();
    await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    expect(agentContext(runAgent)).toEqual([NEW_MESSAGE]);
    const sent = sendMessage.mock.calls.at(-1)?.[0] as { body: string; episodeId?: string };
    expect(sent.episodeId).toBe(NEW_EPISODE_ID);
    expect(sent.body).toContain(EPISODE_OPENING_COPY.introduction.ar);
  });

  it("bounds context by the resolved episode when the snapshot is stale", async () => {
    // A boundary from *two* episodes ago: truthy, plausible, and wrong.
    state.conversation = openConversation({ ai_context_reset_at: "2026-08-20T00:00:00.000Z" });
    const runAgent = plainRunner();
    await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    expect(agentContext(runAgent)).toEqual([NEW_MESSAGE]);
  });
});

describe("P11T-HOTFIX — a boundary that cannot be established reads nothing", () => {
  it("fails closed instead of falling back to the whole thread", async () => {
    state.episodeRpcFails = true;
    state.conversation = openConversation({ ai_context_reset_at: null });
    const runAgent = plainRunner();

    const outcome = await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    expect(outcome).toEqual({ status: "skipped", reason: "episode_boundary_unresolved" });
    // No history read reached a model, nothing was sent, nothing was written.
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.conversationUpdates).toEqual([]);
    expect(state.attributions).toEqual([]);
    // One label-only diagnostic, with no patient content in it.
    const logged = logAgentTool.mock.calls.map((call) => call[0] as Row);
    expect(logged).toEqual([
      {
        clinicId: "clinic-1",
        actorId: null,
        tool: "patient_episode_boundary",
        params: { outcome: "unresolved", action: "fail_closed" },
      },
    ]);
  });

  it("still answers from the P11O boundary when only episode identity is lost", async () => {
    // The RPC is unavailable but the conversation carries its boundary. Losing
    // the episode *record* is survivable; losing the bound is not.
    state.episodeRpcFails = true;
    const runAgent = plainRunner();
    await runPatientInboundAiReply(baseInput(NEW_MESSAGE), { runAgent });

    expect(agentContext(runAgent)).toEqual([NEW_MESSAGE]);
    const sent = sendMessage.mock.calls.at(-1)?.[0] as { episodeId?: string };
    // No id to attribute with, so none is claimed — and none is invented.
    expect(sent.episodeId).toBeUndefined();
    expect(state.attributions).toEqual([]);
  });
});
