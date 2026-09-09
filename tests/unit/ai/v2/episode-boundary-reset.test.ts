/**
 * The episode boundary, as the V2 engine has to experience it.
 *
 * ## The QA report
 *
 * A thread was closed from the Inbox. The same number wrote again. V2 ran — the
 * audit line proves it — and the new episode answered generically and appeared
 * to be carrying the previous exchange.
 *
 * ## What this file pins
 *
 * The required invariant, stated once: **a new inbound after a closed episode
 * starts with no stale V2 intent, slots, clarification or booking frame.**
 * Durable identity and patient linkage may survive; episode state may not.
 *
 * There are exactly two channels through which the previous episode can reach a
 * V2 turn, because `interpreterView` projects only two things that carry
 * conversation: `context.flows` (the stack) and `context.episode.turns` (the
 * transcript). `buildTurnContext` reads nothing else that is episode-scoped —
 * no `ai_collected_data`, no `ai_booking_stage`, no `ai_pending_clarification`.
 * So this file tests those two channels and the writes that are supposed to
 * close them, and nothing else.
 *
 * The blocks marked REGRESSION reproduce defects that are live in the tree.
 * They are expected to fail until the SQL they name is repaired.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Part 1 — the TypeScript boundary: what a close and a reopen actually write
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({ resetFlowState: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/v2/store", () => store);

const episodeMod = vi.hoisted(() => ({ endEpisode: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/episode", () => episodeMod);

/**
 * Records every `update()` payload per table, and every filter applied after
 * it. The filters matter as much as the payload here: the reopen path's whole
 * correctness is one `.is("ai_context_reset_at", null)` guard.
 */
const admin = vi.hoisted(() => {
  const writes: { table: string; payload: Record<string, unknown>; filters: string[] }[] = [];
  const client = {
    from(table: string) {
      const chain = {
        update(payload: Record<string, unknown>) {
          writes.push({ table, payload, filters: [] });
          return chain;
        },
        eq() {
          return chain;
        },
        is(column: string) {
          writes[writes.length - 1]?.filters.push(`is:${column}`);
          return chain;
        },
        select() {
          return chain;
        },
        async maybeSingle() {
          return { data: { id: "conv-1" }, error: null };
        },
        then(resolve: (value: { data: { id: string }[]; error: null }) => unknown) {
          return Promise.resolve({ data: [{ id: "draft-1" }], error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
  return { writes, createClinicScopedAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: admin.createClinicScopedAdminClient,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn(async () => undefined) }));

import { resetConversationAssistantState } from "@/lib/ai/conversation-reset";

/** The conversation payload a reset writes, whichever call carried it. */
function conversationPayload(keys: readonly string[]): Record<string, unknown> | null {
  return (
    admin.writes.find(
      (write) =>
        write.table === "conversations" && keys.every((key) => key in write.payload),
    )?.payload ?? null
  );
}

/** Every column an episode boundary must clear, and the value it must clear to. */
const CLEARED: Record<string, unknown> = {
  ai_collected_data: {},
  ai_pending_clarification: null,
  ai_booking_stage: null,
  ai_escalated_at: null,
  ai_escalation_reason: null,
  ai_paused_at: null,
  ai_last_replied_at: null,
  ai_auto_close_after: null,
  ai_auto_close_armed_at: null,
};

/** Everything about the person, which the same boundary must never touch. */
const DURABLE = [
  "patient_id",
  "patient_link_status",
  "identity_verified_at",
  "display_name",
  "booking_identity_confirmed_at",
];

describe("1. Close thread — what state is cleared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.writes.length = 0;
  });

  it("clears every episode-scoped column and the V2 flow stack", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
    });

    const payload = conversationPayload(["ai_booking_stage"]);
    expect(payload).toEqual(CLEARED);
    expect(store.resetFlowState).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
    });
  });

  it("leaves identity and patient linkage alone", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
    });
    for (const write of admin.writes) {
      for (const column of DURABLE) expect(write.payload).not.toHaveProperty(column);
    }
  });

  it("draws the boundary unconditionally, so the goodbye falls behind it", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
      boundaryAt: "2026-09-05T10:00:00.000Z",
    });
    const stamp = admin.writes.find((write) => "ai_context_reset_at" in write.payload);
    expect(stamp?.payload.ai_context_reset_at).toBe("2026-09-05T10:00:00.000Z");
    expect(stamp?.filters).not.toContain("is:ai_context_reset_at");
  });

  it("ends the durable episode record, so the next turn opens a new one", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
      boundaryAt: "2026-09-05T10:00:00.000Z",
    });
    expect(episodeMod.endEpisode).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
      endedAt: "2026-09-05T10:00:00.000Z",
    });
  });
});

describe("2/3/4. Reopen on a new inbound — the same clearing, minus the ending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.writes.length = 0;
  });

  it("clears the identical column set and the flow stack again", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "reopened",
      boundaryAt: "2026-09-05T11:00:00.000Z",
    });
    expect(conversationPayload(["ai_booking_stage"])).toEqual(CLEARED);
    expect(store.resetFlowState).toHaveBeenCalledTimes(1);
  });

  it("never moves a boundary a close already drew", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "reopened",
      boundaryAt: "2026-09-05T11:00:00.000Z",
    });
    const stamp = admin.writes.find((write) => "ai_context_reset_at" in write.payload);
    // The guard *is* the correctness: re-stamping here would cut the very
    // message that reopened the thread out of its own episode.
    expect(stamp?.filters).toContain("is:ai_context_reset_at");
  });

  it("does not end an episode, because the next turn is about to open one", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "reopened",
    });
    expect(episodeMod.endEpisode).not.toHaveBeenCalled();
  });

});

// ---------------------------------------------------------------------------
// Part 2 — the engine, end to end across the boundary
//
// active V2 booking + open clarification
//   → close episode
//   → new inbound
//   → new V2 turn
//   → the old flow cannot resume and cannot influence intent.
//
// The tool layer is stubbed at the module boundary; the flow definitions, the
// engine, the preconditions and the interpreter projection are all real.
// ---------------------------------------------------------------------------

const tools = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readRescheduleTarget: vi.fn(),
  readKnownDepartments: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));
vi.mock("@/lib/ai/v2/tools", () => tools);

import type { Command } from "@/lib/ai/v2/commands";
import { interpreterView, type TurnContext } from "@/lib/ai/v2/context";
import { runEngine } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import {
  EMPTY_FLOW_STATE,
  activeFrame,
  newFrame,
  parkedFrame,
  type FlowState,
} from "@/lib/ai/v2/flow-state";

/** The first episode: a booking half-collected, with a question outstanding. */
const EPISODE_1_AT = "2026-09-05T09:00:00.000Z";
/**
 * The new inbound that reopens the thread. Forty minutes after the first
 * episode last moved, so `book_appointment`'s 30-minute maxIdle has expired and
 * a surviving frame would be `parked` — the state that gets *offered* back.
 */
const EPISODE_2_AT = "2026-09-05T09:40:00.000Z";

const PT = { value: "dept-pt", label: "Physical Therapy", source: "clinic_directory" as const };
const NABIL = { value: "doc-nabil", label: "Ahmed Nabil", source: "clinic_directory" as const };

/**
 * The contaminated state: an active `book_appointment` frame carrying a
 * department and a doctor, plus an open offer waiting on a day. This is exactly
 * what `ai_flow_state` holds mid-booking, and exactly what must not survive.
 */
function bookingInProgress(): FlowState {
  const base = newFrame({ flow: "book_appointment", at: EPISODE_1_AT });
  return {
    version: 1,
    stack: [
      {
        ...base,
        slots: {
          department: { value: "dept-pt", provenance: "spoken", at: EPISODE_1_AT },
          doctor: { value: "doc-nabil", provenance: "affirmed", at: EPISODE_1_AT },
        },
        offer: {
          id: "offer-day-1",
          slot: "day",
          options: [
            { id: "o1", value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" },
            { id: "o2", value: "2026-09-11", label: "2026-09-11", source: "clinic_directory" },
          ],
          primaryOptionId: null,
          flow: "book_appointment",
          kind: "slot_value",
          at: EPISODE_1_AT,
        },
      },
    ],
  };
}

/** The first episode's transcript, which the boundary must also cut away. */
const EPISODE_1_TURNS = [
  { role: "patient" as const, text: "عايز أحجز علاج طبيعي", at: EPISODE_1_AT },
  { role: "assistant" as const, text: "تمام، مع دكتور أحمد نبيل. أي يوم يناسبك؟", at: EPISODE_1_AT },
] as const;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  const now = new Date(EPISODE_2_AT);
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: EPISODE_2_AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => [],
      knownDepartments: async () => [],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => null,
    },
    history: { search: async () => [] },
    // Durable linkage survives the boundary by design. Keeping it non-anonymous
    // here is what makes the test about *episode* state and nothing else.
    identity: "linked",
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
      timeZone: "Europe/Istanbul",
      locale: "ar",
      country: "TR",
      timeFormat: "24h",
    },
    style: { language: "ar", arabicStyle: "egyptian", tone: "friendly", styleInstruction: null },
    now,
    ...overrides,
  };
}

function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

/**
 * The boundary, applied. This is what `resetConversationAssistantState` plus an
 * episode-scoped `loadHistory` leave the next turn holding: a null flow column
 * and a transcript that starts at the reset instant.
 */
function afterBoundary(): Partial<TurnContext> {
  return { flows: EMPTY_FLOW_STATE, episode: { turns: [] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  tools.readDepartments.mockResolvedValue([PT]);
  tools.readDoctors.mockResolvedValue([NABIL]);
  tools.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  tools.resolveDepartmentSpoken.mockResolvedValue([]);
  tools.readKnownDepartments.mockResolvedValue([]);
  tools.readTreatingDoctors.mockResolvedValue([]);
  tools.readMyAppointments.mockResolvedValue([]);
  tools.readPatientPackages.mockResolvedValue([]);
  tools.readPublicPackages.mockResolvedValue({ groups: [], all: [], currency: null, total: 0 });
  tools.readServices.mockResolvedValue({ groups: [], currency: "TRY", total: 0 });
  tools.readClinicInfo.mockResolvedValue({});
  tools.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-10",
    windowEnd: "2026-09-16",
    days: [{ value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" }],
  });
  tools.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [{ value: "12:15", label: "12:15", source: "clinic_directory" }],
  });
  tools.resolveIdentity.mockResolvedValue({ kind: "none" });
});

describe("5. Contamination, demonstrated — the state that must not cross", () => {
  it("keeps the old booking's slots live when the stack survives the close", async () => {
    // No boundary applied: the previous episode's stack is handed to the new
    // turn. This is the observed defect, and the control for every assertion
    // below. The gap here is inside `book_appointment`'s 30-minute maxIdle, so
    // the frame is not even parked — it is live, with the doctor and the
    // department the patient settled in an episode they have already ended.
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context({
        flows: bookingInProgress(),
        now: new Date("2026-09-05T09:20:00.000Z"),
      }),
    );
    expect(result.trace).toContain("start_flow_already_active");
    expect(Object.keys(activeFrame(result.state)?.slots ?? {})).toEqual([
      "department",
      "doctor",
    ]);
  });

  it("offers to resume the old booking once the frame has parked", async () => {
    const stale = bookingInProgress();
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      // Forty minutes after the frame last moved — past the 30-minute maxIdle.
      context({ flows: stale, now: new Date(EPISODE_2_AT) }),
    );
    // "We can continue the booking we started earlier" — about an episode the
    // patient ended. The parked frame is still readable, which is the point.
    expect(result.trace).toContain("start_flow_offered_resume");
  });
});

describe("5. The invariant — a new episode starts clean", () => {
  it("carries no frame, no slots and no offer into the new turn", () => {
    const ctx = context(afterBoundary());
    expect(ctx.flows.stack).toHaveLength(0);
    expect(activeFrame(ctx.flows)).toBeNull();
    expect(parkedFrame(ctx.flows, "book_appointment")).toBeNull();
  });

  it("shows the interpreter no active flow, no offer and no old transcript", () => {
    const view = interpreterView(
      context({
        ...afterBoundary(),
        turn: { text: "السلام عليكم", receivedAt: EPISODE_2_AT, locale: "ar", attachments: [] },
      }),
    );
    expect(view.activeFlow).toBeNull();
    expect(view.parkedFlow).toBeNull();
    expect(view.suspendedFlow).toBeNull();
    expect(view.openOffer).toBeNull();
    expect(view.recentTurns).toHaveLength(0);
    // Durable identity is deliberately still there. The boundary forgets the
    // episode, never the person.
    expect(view.identity).toBe("linked");
  });

  it("starts a fresh booking rather than offering to resume one", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context(afterBoundary()),
    );
    expect(result.trace).not.toContain("start_flow_offered_resume");
    const frame = activeFrame(result.state);
    expect(frame?.flow).toBe("book_appointment");
    // The doctor and department the previous episode had settled are gone, so
    // the new episode has to ask for them again — which is the correct, and
    // the only honest, behaviour.
    expect(frame?.slots.doctor).toBeUndefined();
    expect(frame?.slots.department).toBeUndefined();
  });

  it("cannot resume the old flow even when the patient explicitly asks to", async () => {
    const result = await turn(
      [{ kind: "resume_flow", flow: "book_appointment" }],
      context(afterBoundary()),
    );
    expect(result.trace).toContain("resume_no_frame");
    expect(activeFrame(result.state)).toBeNull();
  });

  it("cannot accept the previous episode's open offer", async () => {
    // A bare «اه» arriving as the first message of the new episode. The offer
    // it would have accepted belonged to a frame that no longer exists, and its
    // server-minted id is unreachable.
    const result = await turn(
      [{ kind: "affirm_offer", offerId: "offer-day-1" }],
      context(afterBoundary()),
    );
    expect(result.state.stack).toHaveLength(0);
    // No offer is re-opened and nothing is said as though a flow were running.
    expect(result.effects.some((effect) => effect.kind === "offer")).toBe(false);
    expect(activeFrame(result.state)).toBeNull();
  });

  it("keeps the old episode's utterances out of the new turn's transcript", () => {
    // What `loadEpisodeUtterances` returns is bounded by `EpisodeContext`, so
    // the model is handed the new episode only. Asserted on the projection the
    // interpreter actually receives, because that is the surface a leak would
    // arrive on.
    const contaminated = interpreterView(context({ episode: { turns: EPISODE_1_TURNS } }));
    expect(contaminated.recentTurns.map((entry) => entry.text)).toContain(
      "عايز أحجز علاج طبيعي",
    );
    const clean = interpreterView(context(afterBoundary()));
    expect(clean.recentTurns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the two boundaries that run in SQL
//
// `resetConversationAssistantState` is the boundary for the staff close, the
// assistant close and the reopen. Two others never enter a process at all, and
// each has to clear the same state itself. Both are currently incomplete, and
// the two REGRESSION blocks below fail until they are repaired.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

function migration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * Every migration file, oldest first.
 *
 * Discovered from the directory rather than listed here on purpose: a hardcoded
 * list is a test that stops watching the moment somebody adds a file, which is
 * exactly the event these assertions exist to catch.
 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

const HEADER = (name: string) => `create or replace function public.${name}(`;

/**
 * Every migration that redefines `name`, oldest first, with its body.
 *
 * The body is cut at the function's own `$$;` terminator. Slicing to the end of
 * the file instead would let a *later* function in the same migration satisfy an
 * assertion about this one — and this file asserts that the sweep never writes
 * `patient_id`, immediately above a function whose whole purpose is to null it.
 */
function definitions(name: string): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];
  for (const file of migrationFiles()) {
    const sql = migration(file);
    const at = sql.indexOf(HEADER(name));
    if (at < 0) continue;
    const end = sql.indexOf("\n$$;", at);
    found.push({ file, body: sql.slice(at, end < 0 ? undefined : end + 4) });
  }
  return found;
}

/** The body of `name` in the last migration that redefines it. */
function latestDefinition(name: string): string {
  const all = definitions(name);
  const last = all[all.length - 1];
  if (!last) throw new Error(`no definition of ${name}`);
  return last.body;
}

/**
 * The two migrations after which a given behaviour became mandatory.
 *
 * `create or replace` means the newest definition wins outright, so a later
 * migration that reconstructs an older body silently reverts everything added
 * in between — which is exactly how the episode bookkeeping was lost.
 */
const P11T = "20260905120000_p11t_conversation_episodes.sql";
const V2 = "20260913120000_v2_patient_assistant_flow_state.sql";
/**
 * The corrective migration, and the baseline every future one is held to.
 *
 * The scan below deliberately starts here rather than at P11T. The V2 migration
 * is the definition that dropped the episode bookkeeping, it is already applied,
 * and an applied migration is never edited — the fix is this new file replacing
 * the function, not a rewrite of history. So V2 is expected to fail the rule and
 * is excluded by date; everything from the repair onwards must satisfy it.
 */
const REPAIR = "20260915120000_episode_boundary_flow_state_repair.sql";

describe("6. The SQL idle sweep", () => {
  const sweeper = latestDefinition("close_idle_patient_ai_episodes");

  it("clears the V2 flow stack alongside the legacy state", () => {
    expect(sweeper).toContain("ai_flow_state = null");
    expect(sweeper).toContain("ai_booking_stage = null");
    expect(sweeper).toContain("ai_collected_data = '{}'::jsonb");
    expect(sweeper).toContain("ai_context_reset_at = v_now");
  });

  it("ends the durable episode record it closed", () => {
    // P11T taught this sweep to end `conversation_episodes` and clear
    // `current_episode_id`. The V2 migration rebuilt the function from P11S's
    // body — "with one line added and nothing else changed" — and P11S predates
    // P11T, so the rebuild dropped both writes.
    //
    // The consequence is the reported defect. `resolve_conversation_episode`
    // returns the still-`active` episode from *before* the idle close, with its
    // original `started_at`, so `EpisodeContext` bounds the next turn at the old
    // episode's start and `loadHistory` hands V2 the finished conversation. The
    // flow stack is empty (this sweep does clear it), which is why the new
    // episode reads as generic *and* stale at the same time.
    expect(sweeper).toContain("end_reason = 'idle_timeout'");
    expect(sweeper).toContain("current_episode_id = null");
  });
});

describe("7. The stale-link normalizer", () => {
  const normalizer = latestDefinition("normalize_stale_patient_conversation_episode");

  it("moves the episode boundary when it fires", () => {
    expect(normalizer).toContain("ai_context_reset_at = v_boundary");
    expect(normalizer).toContain("ai_booking_stage = null");
  });

  it("clears the V2 flow stack it just started a new episode over", () => {
    // This is a fourth episode boundary: a dangling patient link makes the
    // resolver draw a fresh `ai_context_reset_at` before any stage or authority
    // is read. It clears every legacy column and never learned about
    // `ai_flow_state`, so the new episode it declares begins holding the
    // previous one's booking frame.
    expect(normalizer).toContain("ai_flow_state = null");
  });
});

// ---------------------------------------------------------------------------
// Part 4 — the guard that makes the regression un-repeatable
//
// Asserting on the *latest* definition proves today's schema is right and says
// nothing about tomorrow's. The defect was not a wrong statement; it was a
// correct statement in a body reconstructed from a file that predated it. So
// the assertions below range over every redefinition, not just the last one.
// ---------------------------------------------------------------------------

describe("8. No future migration may drop what an earlier one established", () => {
  const sweeps = definitions("close_idle_patient_ai_episodes");

  it("redefines the sweep in the migrations this file knows about", () => {
    // A sanity check on the scanner itself: if the header ever changes shape,
    // every assertion below would pass vacuously.
    expect(sweeps.map((entry) => entry.file)).toEqual([
      "20260904130000_p11s_patient_episode_idle_auto_close.sql",
      P11T,
      V2,
      "20260915120000_episode_boundary_flow_state_repair.sql",
    ]);
  });

  it.each([
    ["ends the episode", "end_reason = 'idle_timeout'"],
    ["clears the current-episode pointer", "current_episode_id = null"],
    ["clears the V2 flow stack", "ai_flow_state = null"],
    ["clears the legacy booking stage", "ai_booking_stage = null"],
    ["draws the new episode boundary", "ai_context_reset_at = v_now"],
  ])("every definition from the repair onwards %s", (_label, statement) => {
    for (const { file, body } of sweeps) {
      if (file < REPAIR) continue;
      expect(body, `${file} dropped: ${statement}`).toContain(statement);
    }
  });

  it("records the two definitions that predate each rule, so the scan stays honest", () => {
    const p11t = sweeps.find((entry) => entry.file === P11T)?.body ?? "";
    const v2 = sweeps.find((entry) => entry.file === V2)?.body ?? "";
    // P11T established the episode bookkeeping and knew nothing of the stack.
    expect(p11t).toContain("end_reason = 'idle_timeout'");
    expect(p11t).not.toContain("ai_flow_state");
    // V2 added the stack and is the definition that lost the bookkeeping. Left
    // exactly as applied; the repair supersedes it rather than rewriting it.
    expect(v2).toContain("ai_flow_state = null");
    expect(v2).not.toContain("end_reason = 'idle_timeout'");
  });

  it("every definition keeps the service-role guard and the empty search_path", () => {
    for (const { file, body } of sweeps) {
      expect(body, file).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
      expect(body, file).toContain("set search_path = ''");
      expect(body, file).toContain("security definer");
    }
  });

  it("never lets the sweep touch anything belonging to the person", () => {
    for (const { file, body } of sweeps) {
      for (const column of DURABLE) {
        expect(body, `${file} writes ${column}`).not.toContain(`${column} =`);
      }
    }
  });

  it("keeps the normalizer's live-patient early return and its guard", () => {
    // B adds one column to a function whose entire safety rests on refusing to
    // fire for a patient row that is still live. Pinned here so the added line
    // cannot be the edit that loses it.
    const normalizer = latestDefinition("normalize_stale_patient_conversation_episode");
    expect(normalizer).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
    expect(normalizer).toContain("set search_path = ''");
    expect(normalizer).toContain("not p.is_deleted");
    expect(normalizer).toContain("reset_performed := false;");
  });
});
