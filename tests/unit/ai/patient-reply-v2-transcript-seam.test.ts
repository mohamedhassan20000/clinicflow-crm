import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seam between `patient-reply.ts` and the V2 runtime.
 *
 * ## Why this file exists
 *
 * Every V2 test builds its `TurnContext` by hand, and two of them
 * (`firewall`, `episode-boundary-reset`) even put `role: "assistant"` turns in
 * the episode. So the engine's handling of a transcript was well covered, and
 * the transcript it was handed in production was covered by nothing at all.
 *
 * It was wrong. `episodeTurns` was assembled by relabelling the F-8/F-11
 * provenance utterances — an `inbound_messages`-only read — as conversation
 * turns, every entry stamped `role: "patient"` and every entry stamped with the
 * same timestamp. V2's interpreter therefore never saw a single thing the
 * assistant had said, and «طيب والعنوان ورقم التليفون؟» had no antecedent to
 * resolve against.
 *
 * A unit test on the engine cannot catch that, because the engine was fine.
 * These assert the *caller's* contract: what actually reaches the runtime.
 *
 * The Supabase client is stubbed at the module boundary and applies the `gte`
 * filters for real, so the episode bound below is the one the query would
 * genuinely produce rather than the shape of a call.
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
} = { clinic: null, conversation: {}, inbound: [], outbound: [] };

type Ctx = {
  table: string;
  op: string;
  payload: Row;
  gte: [string, string][];
  order: string | null;
  ascending: boolean;
};

function makeScopedClient() {
  const from = (table: string) => {
    const ctx: Ctx = {
      table,
      op: "select",
      payload: {},
      gte: [],
      order: null,
      ascending: true,
    };
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
    builder.delete = chain;
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
    Object.assign(state.conversation, ctx.payload);
    return { data: [{ id: "conv-1" }], error: null };
  }
  if (ctx.table === "inbound_messages") return { data: applyGte(state.inbound, ctx), error: null };
  if (ctx.table === "outbound_messages") return { data: applyGte(state.outbound, ctx), error: null };
  return { data: [], error: null };
}

function resolveSingle(ctx: Ctx) {
  if (ctx.table === "clinics") return { data: state.clinic, error: null };
  if (ctx.table === "conversations") {
    if (ctx.op === "update") {
      Object.assign(state.conversation, ctx.payload);
      return { data: { id: "conv-1" }, error: null };
    }
    return { data: state.conversation, error: null };
  }
  if (ctx.table === "inbound_messages") return { data: { id: "inbound-new" }, error: null };
  if (ctx.table === "ai_suggested_replies" && ctx.op === "insert") {
    return { data: { id: "sugg-1" }, error: null };
  }
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  resolveConversationEpisode: (input: { startedAt?: string | null }) =>
    Promise.resolve({
      data: [
        {
          episode_id: "episode-current",
          started_at:
            state.conversation.ai_context_reset_at ??
            input.startedAt ??
            state.conversation.created_at ??
            null,
          opened: state.conversation.ai_context_reset_at !== null,
        },
      ],
      error: null,
    }),
  closeConversationEpisode: () =>
    Promise.resolve({ data: [{ episode_id: "episode-current", closed: true }], error: null }),
  getClinicAiReplyContext: () => Promise.resolve({ data: state.clinic, error: null }),
  latchConversationAiTechnicalFailure: () =>
    Promise.resolve({ data: [{ latched: true, failed_at: null }], error: null }),
  clearConversationAiTechnicalFailure: () => Promise.resolve({ data: false, error: null }),
  normalizeStalePatientConversationEpisode: () =>
    Promise.resolve({
      data: [
        {
          reset_performed: false,
          context_reset_at: state.conversation.ai_context_reset_at ?? null,
        },
      ],
      error: null,
    }),
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
  time_format: "24h",
  ai_reply_mode: "auto",
  ai_language_mode: "auto",
  ai_arabic_style: "egyptian",
  ai_tone: "friendly",
  ai_style_instruction: null,
};

/** The boundary. Everything before it belongs to a finished episode. */
const CLOSED_AT = "2026-08-30T00:00:00.000Z";

type EpisodeTurn = { role: "patient" | "assistant"; text: string; at: string };

function lastCall(runAgent: ReturnType<typeof vi.fn>) {
  return runAgent.mock.calls.at(-1)?.[0] as {
    episodeTurns?: EpisodeTurn[];
    episodeUtterances?: string[];
  };
}

async function run(message: string) {
  const runAgent = vi.fn().mockResolvedValue({
    ok: true,
    text: "تمام.",
    outstanding: false,
    completed: true,
  });
  await runPatientInboundAiReply(
    {
      clinicId: "clinic-1",
      conversationId: "conv-1",
      providerMessageId: "wamid-new",
      messageText: message,
    },
    { runAgent },
  );
  return lastCall(runAgent);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.clinic = { ...CLINIC };
  state.conversation = {
    id: "conv-1",
    status: "open",
    patient_id: "patient-mohamed",
    participant_address: "+201000000000",
    ai_escalated_at: null,
    ai_paused_at: null,
    ai_context_reset_at: CLOSED_AT,
    created_at: "2026-01-01T00:00:00.000Z",
    assigned_to: null,
  };
  // The 14:12 exchange: the patient asks a compound question, the assistant
  // answers, the patient follows up. Interleaved on purpose — the follow-up is
  // only readable against the answer that preceded it.
  state.inbound = [
    {
      id: "in-1",
      body: "عايز اعرف العنوان ورقم التليفون والاقسام الموجودة عندكم",
      received_at: "2026-08-30T14:12:00.000Z",
    },
    {
      id: "in-2",
      body: "طيب والعنوان ورقم التليفون؟",
      received_at: "2026-08-30T14:26:00.000Z",
    },
  ];
  state.outbound = [
    {
      id: "out-1",
      body: "أقسام العيادة: الجلدية، الأسنان، الباطنة.",
      body_preview: "أقسام العيادة",
      created_at: "2026-08-30T14:13:00.000Z",
    },
  ];
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

describe("the transcript V2 is actually handed", () => {
  it("contains the assistant's own turns, not only the patient's", async () => {
    const call = await run("طيب والعنوان ورقم التليفون؟");
    const turns = call.episodeTurns ?? [];
    expect(turns.length).toBeGreaterThan(0);
    // The whole defect, in one assertion.
    expect(turns.some((turn) => turn.role === "assistant")).toBe(true);
    expect(turns.some((turn) => turn.role === "patient")).toBe(true);
    expect(turns.find((turn) => turn.role === "assistant")?.text).toContain("أقسام العيادة");
  });

  it("interleaves the two tables in chronological order", async () => {
    const turns = (await run("طيب والعنوان ورقم التليفون؟")).episodeTurns ?? [];
    // Not "all the patient's messages, then all the assistant's" — that reads
    // as two monologues and destroys every antecedent in the thread.
    expect(turns.map((turn) => turn.role)).toEqual(["patient", "assistant", "patient"]);
    const stamps = turns.map((turn) => turn.at);
    expect([...stamps].sort()).toEqual(stamps);
    // Distinct timestamps: the relabelled utterances all carried the same one.
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("stays inside the episode boundary", async () => {
    state.inbound.unshift({
      id: "old-in",
      body: "كلام من حلقة قديمة خالص",
      received_at: "2026-08-29T10:00:00.000Z",
    });
    state.outbound.unshift({
      id: "old-out",
      body: "رد قديم من حلقة اتقفلت",
      body_preview: "رد قديم",
      created_at: "2026-08-29T10:05:00.000Z",
    });
    const turns = (await run("طيب والعنوان ورقم التليفون؟")).episodeTurns ?? [];
    const text = turns.map((turn) => turn.text).join("\n");
    expect(text).not.toContain("حلقة قديمة");
    expect(text).not.toContain("رد قديم");
    expect(turns.every((turn) => turn.at >= CLOSED_AT)).toBe(true);
  });

  it("keeps the provenance utterances a separate, inbound-only read", async () => {
    // These two values answer different questions — "what did the patient
    // utter?" and "what was said, by whom, in what order?" — and collapsing
    // them is exactly how the assistant lost its own voice. The F-8/F-11 gates
    // depend on the first staying inbound-only.
    const call = await run("طيب والعنوان ورقم التليفون؟");
    expect(call.episodeUtterances).toEqual([
      "عايز اعرف العنوان ورقم التليفون والاقسام الموجودة عندكم",
      "طيب والعنوان ورقم التليفون؟",
    ]);
    expect(call.episodeUtterances?.length).not.toEqual(call.episodeTurns?.length);
  });

  it("drops empty bodies rather than passing blank turns", async () => {
    state.outbound.push({
      id: "out-blank",
      body: "   ",
      body_preview: null,
      created_at: "2026-08-30T14:27:00.000Z",
    });
    const turns = (await run("طيب والعنوان ورقم التليفون؟")).episodeTurns ?? [];
    expect(turns.every((turn) => turn.text.trim().length > 0)).toBe(true);
  });
});
