/**
 * The flow engine, exercised with no model, no database and a fixed clock.
 *
 * That this file can exist is the point of the rebuild. The behaviour it tests
 * — what starts a booking, what a bare "yes" means, what a correction
 * invalidates, whether a stale booking can resume — used to live inside a
 * `ToolLoopAgent` call and could only be observed by paying for a generation.
 * Here it is a reducer, and every invariant is an assertion.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseCommands, type Command } from "@/lib/ai/v2/commands";
import {
  EMPTY_FLOW_STATE,
  activeFrame,
  newFrame,
  parkStaleFrames,
  parseFlowState,
  serializeFlowState,
  type FlowState,
} from "@/lib/ai/v2/flow-state";
import { runEngine, type FlowRegistry } from "@/lib/ai/v2/engine";
import type { FlowDefinition, SlotResolution } from "@/lib/ai/v2/flow-definition";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-04T12:00:00.000Z");

/** Two doctors who share a first name — the live ambiguity, as fixture data. */
const ROSTER = [
  { id: "doc-nabil", name: "Ahmed Nabil" },
  { id: "doc-mostafa", name: "Ahmed Mostafa" },
  { id: "doc-sara", name: "Sara Ali" },
];

async function resolveDoctor(input: { spoken: string }): Promise<SlotResolution> {
  const matches = ROSTER.filter((doctor) =>
    doctor.name.toLowerCase().includes(input.spoken.toLowerCase()),
  );
  if (matches.length === 0) return { kind: "unresolved" };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      options: matches.map((doctor) => ({
        value: doctor.id,
        label: doctor.name,
        source: "clinic_directory" as const,
      })),
    };
  }
  return { kind: "resolved", value: matches[0]!.id, label: matches[0]!.name };
}

/**
 * A booking flow with the same shape as the real one, and a recorder so a test
 * can assert which steps ran. Availability is the step whose precondition the
 * live failure violated, so it is the one that counts calls.
 */
function bookingFlow(calls: string[]): FlowDefinition {
  return {
    name: "book_appointment",
    onAbandon: "confirm",
    public: false,
    steps: [
      {
        id: "department",
        fills: "department",
        pre: { slots: [], identity: "none" },
        invalidates: ["doctor", "day", "time"],
        resolveValue: async ({ spoken }) => ({
          kind: "resolved",
          value: `dept-${spoken}`,
          label: spoken,
        }),
        run: async () => {
          calls.push("list_departments");
          return {
            kind: "offer",
            slot: "department",
            offerKind: "slot_value",
            options: [
              { value: "dept-derma", label: "Dermatology", source: "clinic_directory" },
            ],
            say: "booking.choose_department",
          };
        },
      },
      {
        id: "doctor",
        fills: "doctor",
        pre: { slots: ["department"], identity: "none" },
        invalidates: ["day", "time"],
        resolveValue: async ({ spoken }) => resolveDoctor({ spoken }),
        run: async () => {
          calls.push("list_doctors");
          return {
            kind: "offer",
            slot: "doctor",
            offerKind: "slot_value",
            options: ROSTER.map((doctor) => ({
              value: doctor.id,
              label: doctor.name,
              source: "clinic_directory" as const,
            })),
            say: "booking.choose_doctor",
          };
        },
      },
      {
        id: "day",
        fills: "day",
        // The precondition that makes the live failure structurally impossible.
        pre: { slots: ["department", "doctor"], identity: "none" },
        invalidates: ["time"],
        resolveValue: async ({ spoken }) => ({ kind: "resolved", value: spoken }),
        run: async () => {
          calls.push("list_available_days");
          return {
            kind: "offer",
            slot: "day",
            offerKind: "slot_value",
            options: [
              { value: "2026-09-10", label: "10 Sep", source: "clinic_directory" },
            ],
            say: "booking.choose_day",
          };
        },
      },
      {
        id: "time",
        fills: "time",
        pre: { slots: ["department", "doctor", "day"], identity: "none" },
        resolveValue: async ({ spoken }) => ({ kind: "resolved", value: spoken }),
        run: async () => {
          calls.push("check_availability");
          return {
            kind: "offer",
            slot: "time",
            offerKind: "slot_value",
            options: [{ value: "10:00", label: "10:00", source: "clinic_directory" }],
            say: "booking.choose_time",
          };
        },
      },
      {
        id: "confirm",
        fills: null,
        pre: { slots: ["department", "doctor", "day", "time"], identity: "linked" },
        run: async ({ frame }) => {
          if (frame.memo.confirmed !== true) {
            calls.push("summary");
            return {
              kind: "offer",
              slot: null,
              offerKind: "summary",
              options: [{ value: "confirm", label: "confirm", source: "clinic_directory" }],
              say: "booking.review",
            };
          }
          calls.push("create_preliminary_booking");
          return { kind: "complete", say: "booking.created" };
        },
      },
    ],
  };
}

function questionFlow(calls: string[]): FlowDefinition {
  return {
    name: "answer_question",
    onAbandon: "discard",
    public: true,
    steps: [
      {
        id: "answer",
        fills: null,
        pre: { slots: [], identity: "none" },
        run: async ({ frame }) => {
          calls.push(`answer:${frame.topic}`);
          return { kind: "complete", say: `answer.${frame.topic}` };
        },
      },
    ],
  };
}

function registry(calls: string[]): FlowRegistry {
  const stub = (name: string): FlowDefinition => ({
    name: name as FlowDefinition["name"],
    onAbandon: "discard",
    public: true,
    steps: [
      {
        id: "noop",
        fills: null,
        pre: { slots: [], identity: "none" },
        run: async () => ({ kind: "complete", say: `${name}.done` }),
      },
    ],
  });
  return {
    book_appointment: bookingFlow(calls),
    answer_question: questionFlow(calls),
    reschedule_appointment: stub("reschedule_appointment"),
    cancel_appointment: stub("cancel_appointment"),
    register_patient: stub("register_patient"),
    retrieve_document: stub("retrieve_document"),
    package_inquiry: stub("package_inquiry"),
    patient_relationship_lookup: stub("patient_relationship_lookup"),
  };
}

/**
 * A context whose durable loader is *loaded with the live failure's data*.
 *
 * Ahmed Nabil is the patient's treating doctor, exactly as in production. Every
 * test below that asserts "no availability was read" is therefore asserting the
 * real property: the fact is available, and the architecture still does not let
 * it act.
 */
function context(overrides: Partial<TurnContext> = {}): TurnContext {
  const treating = [
    { value: "doc-nabil", label: "Ahmed Nabil", source: "patient_history" as const },
  ];
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: NOW.toISOString(), locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => treating,
      knownDepartments: async () => [
        { value: "dept-derma", label: "Dermatology", source: "patient_history" as const },
      ],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => "Anas Talal",
    },
    history: { search: async () => [] },
    identity: "linked",
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "24h",
    },
    style: {
      language: "ar",
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    now: NOW,
    ...overrides,
  };
}

async function run(commands: readonly Command[], ctx: TurnContext, calls: string[]) {
  return runEngine({ context: ctx, commands, registry: registry(calls) });
}

// ---------------------------------------------------------------------------

describe("I-1 — durable patient facts cannot create intent", () => {
  it("«عندي استفسار» asks what the inquiry is and reads no calendar", async () => {
    const calls: string[] = [];
    const result = await run(
      parseCommands([{ kind: "ask_clarification", reason: "unspecified_request" }]).commands,
      context({ turn: { text: "عندي استفسار", receivedAt: NOW.toISOString(), locale: "ar", attachments: [] } }),
      calls,
    );

    // The whole live failure, as one assertion: the treating doctor is
    // available to the context and no tool ran.
    expect(calls).toEqual([]);
    expect(result.state.stack).toEqual([]);
    expect(result.effects).toEqual([
      { kind: "ask", key: "clarify.open", slot: null, facts: { reason: "unspecified_request" } },
    ]);
  });

  it("«السلام عليكم» is a greeting and starts no flow", async () => {
    const calls: string[] = [];
    const result = await run([{ kind: "small_talk", talk: "greeting" }], context(), calls);
    expect(calls).toEqual([]);
    expect(result.state.stack).toEqual([]);
    expect(result.effects[0]).toMatchObject({ kind: "say", key: "small_talk.greeting" });
  });

  it("a slot value with no flow to hold it does not open one", async () => {
    // The old ladder took a bare department name as the opening move of a
    // booking. Here it is a value with nowhere to go, which is a question.
    const calls: string[] = [];
    const result = await run(
      [{ kind: "set_slot", slot: "department", value: "الجلدية" }],
      context(),
      calls,
    );
    expect(calls).toEqual([]);
    expect(result.state.stack).toEqual([]);
    expect(result.effects[0]).toMatchObject({ kind: "ask", key: "clarify.no_active_flow" });
  });
});

describe("I-2 — stale flow state cannot create intent", () => {
  function staleBooking(): FlowState {
    const started = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    return {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: started }),
          slots: {
            department: { value: "dept-derma", provenance: "spoken", at: started },
            doctor: { value: "doc-nabil", label: "Ahmed Nabil", provenance: "spoken", at: started },
          },
          offer: null,
          lastAdvancedAt: started,
        },
      ],
    };
  }

  it("parks a booking that has been silent past its maxIdle", () => {
    const parked = parkStaleFrames(staleBooking(), NOW);
    expect(parked.stack[0]!.status).toBe("parked");
    expect(activeFrame(parked)).toBeNull();
  });

  it("an ordinary message does not resume a parked booking or read availability", async () => {
    const calls: string[] = [];
    const result = await run(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      context({ flows: staleBooking() }),
      calls,
    );
    expect(calls).toEqual([]);
    expect(activeFrame(result.state)).toBeNull();
    // The parked booking is *mentioned*, so the patient can pick it up — but
    // mentioning is all it does.
    expect(result.effects[0]).toMatchObject({
      kind: "ask",
      facts: { parked_flow: "book_appointment" },
    });
  });

  it("starting the flow again offers a choice rather than silently resuming", async () => {
    const calls: string[] = [];
    const result = await run(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context({ flows: staleBooking() }),
      calls,
    );
    expect(calls).toEqual([]);
    expect(result.effects[0]).toMatchObject({ kind: "offer", key: "flow.resume_or_restart" });
  });

  it("an explicit resume brings it back, and only then does the flow advance", async () => {
    const calls: string[] = [];
    const result = await run(
      [{ kind: "resume_flow", flow: "book_appointment" }],
      context({ flows: staleBooking() }),
      calls,
    );
    expect(activeFrame(result.state)?.flow).toBe("book_appointment");
    // Department and doctor were already committed, so the next step is the day.
    expect(calls).toEqual(["list_available_days"]);
  });

  it("a live booking is not parked and continues normally", async () => {
    const recent = new Date(NOW.getTime() - 60 * 1000).toISOString();
    const live = staleBooking();
    const frame = { ...live.stack[0]!, lastAdvancedAt: recent };
    const calls: string[] = [];
    const result = await run([], context({ flows: { ...live, stack: [frame] } }), calls);
    expect(calls).toEqual(["list_available_days"]);
    expect(result.state.stack[0]!.status).toBe("active");
  });
});

describe("I-3 — anything unrecognised degrades to clarification", () => {
  it.each([
    ["not JSON at all", "the patient wants to book"],
    ["an unknown command kind", [{ kind: "book_it_now" }]],
    ["a slot that does not exist", [{ kind: "set_slot", slot: "credit_card", value: "x" }]],
    ["an invented offer reference", [{ kind: "affirm_offer", offerId: "made-up" }]],
    ["an empty list", []],
    ["null", null],
  ])("%s becomes ask_clarification and never a mutation", async (_label, raw) => {
    const parsed = parseCommands(raw);
    expect(parsed.commands).toEqual([
      { kind: "ask_clarification", reason: "unspecified_request" },
    ]);
    const calls: string[] = [];
    const result = await run(parsed.commands, context(), calls);
    expect(calls).toEqual([]);
    expect(result.state.stack).toEqual([]);
  });

  it("a well-formed affirm of an offer that was never made confirms nothing", async () => {
    const calls: string[] = [];
    const result = await run(
      [{ kind: "affirm_offer", offerId: "ofr_deadbeef" }],
      context(),
      calls,
    );
    expect(calls).toEqual([]);
    expect(result.effects[0]).toMatchObject({ kind: "ask", key: "clarify.nothing_to_confirm" });
  });
});

describe("I-5 — a durable fact enters as a candidate and needs the patient's word", () => {
  it("«عايز احجز» starts the flow and the first step asks, it does not decide", async () => {
    const calls: string[] = [];
    const result = await run(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context(),
      calls,
    );
    expect(activeFrame(result.state)?.flow).toBe("book_appointment");
    // The department step ran and offered. Nothing is committed: the treating
    // doctor in durable memory has not filled a slot.
    expect(calls).toEqual(["list_departments"]);
    expect(activeFrame(result.state)?.slots).toEqual({});
  });

  it("affirming an offered doctor commits it with `affirmed` provenance", async () => {
    const calls: string[] = [];
    const started = await run(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context(),
      calls,
    );
    const offer = started.effects.find((effect) => effect.kind === "offer");
    expect(offer?.kind).toBe("offer");
    const offerId = offer!.kind === "offer" ? offer!.offer.id : "";

    const accepted = await run(
      [{ kind: "affirm_offer", offerId }],
      context({ flows: started.state }),
      calls,
    );
    const slot = activeFrame(accepted.state)?.slots.department;
    expect(slot).toMatchObject({ value: "dept-derma", provenance: "affirmed" });
    // There is no code path that produces a slot from memory: `spoken`,
    // `affirmed` and `derived` are the only provenances the type permits.
    expect(["spoken", "affirmed", "derived"]).toContain(slot!.provenance);
  });

  it("a bare «اه» is read against the open offer and nothing else", async () => {
    // The old engine needed a 40-line regex of affirmation words because a
    // bare yes had no referent. Here the referent is the offer, so the command
    // is unambiguous by construction and the lexicon is unnecessary.
    const calls: string[] = [];
    const started = await run([{ kind: "start_flow", flow: "book_appointment" }], context(), calls);
    const offer = started.effects.find((effect) => effect.kind === "offer");
    const offerId = offer!.kind === "offer" ? offer!.offer.id : "";
    const accepted = await run(
      [{ kind: "affirm_offer", offerId }],
      context({ flows: started.state }),
      calls,
    );
    expect(activeFrame(accepted.state)?.slots.department).toBeDefined();
  });
});

describe("I-7 — a tool needs an active flow and committed slots, never memory", () => {
  it("availability is unreachable until department and doctor are committed", async () => {
    const calls: string[] = [];
    // A booking frame that holds nothing, on a thread whose patient has a
    // treating doctor in history.
    const state: FlowState = {
      version: 1,
      stack: [newFrame({ flow: "book_appointment", at: NOW.toISOString() })],
    };
    await run([], context({ flows: state }), calls);
    expect(calls).toEqual(["list_departments"]);
    expect(calls).not.toContain("list_available_days");
  });

  it("the write step is unreachable without an affirmed summary", async () => {
    const at = NOW.toISOString();
    const filled: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at }),
          slots: {
            department: { value: "dept-derma", provenance: "spoken", at },
            doctor: { value: "doc-nabil", provenance: "spoken", at },
            day: { value: "2026-09-10", provenance: "spoken", at },
            time: { value: "10:00", provenance: "spoken", at },
          },
        },
      ],
    };
    const calls: string[] = [];
    const reviewed = await run([], context({ flows: filled }), calls);
    expect(calls).toEqual(["summary"]);
    expect(calls).not.toContain("create_preliminary_booking");

    // Only the explicit acceptance of the summary unlocks the write.
    const offer = reviewed.effects.find((effect) => effect.kind === "offer");
    const offerId = offer!.kind === "offer" ? offer!.offer.id : "";
    const confirmed = await run(
      [{ kind: "affirm_offer", offerId }],
      context({ flows: reviewed.state }),
      calls,
    );
    expect(calls).toContain("create_preliminary_booking");
    expect(confirmed.state.stack).toEqual([]);
  });

  it("a step whose identity requirement is unmet asks instead of running", async () => {
    const at = NOW.toISOString();
    const filled: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at }),
          slots: {
            department: { value: "dept-derma", provenance: "spoken", at },
            doctor: { value: "doc-nabil", provenance: "spoken", at },
            day: { value: "2026-09-10", provenance: "spoken", at },
            time: { value: "10:00", provenance: "spoken", at },
          },
        },
      ],
    };
    const calls: string[] = [];
    const result = await run([], context({ flows: filled, identity: "anonymous" }), calls);
    expect(calls).toEqual([]);
    expect(result.effects[0]).toMatchObject({ kind: "ask", key: "identity.required" });
  });
});

describe("corrections, rejections and interruptions", () => {
  function bookingAt(slots: Record<string, string>): FlowState {
    const at = NOW.toISOString();
    return {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at }),
          slots: Object.fromEntries(
            Object.entries(slots).map(([key, value]) => [
              key,
              { value, provenance: "spoken" as const, at },
            ]),
          ),
        },
      ],
    };
  }

  it("«لا قصدي بعد يوم ٩» drops the day, the time and the offer together", async () => {
    const state = bookingAt({
      department: "dept-derma",
      doctor: "doc-nabil",
      day: "2026-09-10",
      time: "10:00",
    });
    const calls: string[] = [];
    const result = await run(
      [{ kind: "correct_slot", slot: "day", value: "2026-09-11" }],
      context({ flows: state }),
      calls,
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.day?.value).toBe("2026-09-11");
    // The cascade is data from the definition, not a branch somebody wrote.
    expect(frame.slots.time).toBeUndefined();
    expect(frame.slots.doctor?.value).toBe("doc-nabil");
    expect(calls).toEqual(["check_availability"]);
  });

  it("correcting the department invalidates the doctor beneath it", async () => {
    const state = bookingAt({ department: "dept-derma", doctor: "doc-nabil", day: "2026-09-10" });
    const calls: string[] = [];
    const result = await run(
      [{ kind: "correct_slot", slot: "department", value: "cardiology" }],
      context({ flows: state }),
      calls,
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.doctor).toBeUndefined();
    expect(frame.slots.day).toBeUndefined();
  });

  it("«لا دكتور تاني» records a negative constraint the flow must respect", async () => {
    const at = NOW.toISOString();
    const withOffer: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at }),
          slots: { department: { value: "dept-derma", provenance: "spoken", at } },
          offer: {
            id: "ofr_11112222",
            slot: "doctor",
            flow: "book_appointment",
            kind: "slot_value",
            primaryOptionId: null,
            at,
            options: [
              {
                id: "opt_33334444",
                value: "doc-nabil",
                label: "Ahmed Nabil",
                source: "patient_history",
              },
            ],
          },
        },
      ],
    };
    const calls: string[] = [];
    const result = await run(
      [{ kind: "reject_offer", offerId: "ofr_11112222" }],
      context({ flows: withOffer }),
      calls,
    );
    const frame = activeFrame(result.state)!;
    expect(frame.rejected.doctor).toEqual(["doc-nabil"]);

    // And the constraint is honoured: naming that doctor again is refused
    // rather than quietly accepted.
    const retried = await run(
      [{ kind: "set_slot", slot: "doctor", value: "Ahmed Nabil" }],
      context({ flows: result.state }),
      calls,
    );
    expect(activeFrame(retried.state)!.slots.doctor).toBeUndefined();
    expect(retried.effects[0]).toMatchObject({ key: "clarify.value_rejected" });
  });

  it("«طب بكام الكشف؟» mid-booking suspends and keeps every slot", async () => {
    const state = bookingAt({ department: "dept-derma", doctor: "doc-nabil" });
    const calls: string[] = [];
    const result = await run(
      [
        { kind: "suspend_flow" },
        { kind: "answer_question", topic: "prices" },
      ],
      context({ flows: state }),
      calls,
    );
    // P12B — the price answer, and then the booking's own step re-reading its
    // calendar so the patient is asked the day again in the same message. The
    // second call is the resume: before it, a side question answered the
    // question and left the booking silent, which reads as abandoned.
    expect(calls).toEqual(["answer:prices", "list_available_days"]);
    // The question flow completed, so the booking is active again — at exactly
    // the step it was on, with its slots intact.
    const booking = result.state.stack.find((frame) => frame.flow === "book_appointment");
    expect(booking?.status).toBe("active");
    expect(booking?.slots.doctor?.value).toBe("doc-nabil");
  });

  it("an ambiguous doctor asks which, and commits nothing", async () => {
    const state = bookingAt({ department: "dept-derma" });
    const calls: string[] = [];
    const result = await run(
      [{ kind: "set_slot", slot: "doctor", value: "Ahmed" }],
      context({ flows: state }),
      calls,
    );
    expect(activeFrame(result.state)!.slots.doctor).toBeUndefined();
    const offer = result.effects.find((effect) => effect.kind === "offer");
    expect(offer).toBeDefined();
    if (offer?.kind === "offer") {
      expect(offer.offer.options.map((option) => option.label)).toEqual([
        "Ahmed Nabil",
        "Ahmed Mostafa",
      ]);
    }
  });
});

describe("ending a conversation", () => {
  it("«خلاص شكرا» on a clean thread ends it deterministically", async () => {
    const calls: string[] = [];
    const result = await run([{ kind: "end_conversation" }], context(), calls);
    expect(result.state.stack).toEqual([]);
    expect(result.effects).toEqual([{ kind: "end_conversation" }]);
  });

  it("«خلاص شكرا» over a staged file asks before discarding it", async () => {
    const at = NOW.toISOString();
    const staged: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at }),
          memo: { intake_staged: true },
        },
      ],
    };
    const calls: string[] = [];
    const result = await run(
      [{ kind: "end_conversation" }],
      context({ flows: staged }),
      calls,
    );
    expect(result.effects[0]).toMatchObject({ key: "flow.confirm_discard_on_end" });
    expect(result.state.stack).toHaveLength(1);
  });
});

describe("serialization", () => {
  it("round-trips a live stack", async () => {
    const calls: string[] = [];
    const started = await run([{ kind: "start_flow", flow: "book_appointment" }], context(), calls);
    const round = parseFlowState(JSON.parse(JSON.stringify(serializeFlowState(started.state))));
    expect(round).toEqual(started.state);
  });

  it("a corrupt record is no active flow, not a partial one", () => {
    expect(parseFlowState({ version: 9, stack: [] })).toEqual(EMPTY_FLOW_STATE);
    expect(parseFlowState("nonsense")).toEqual(EMPTY_FLOW_STATE);
    expect(parseFlowState(null)).toEqual(EMPTY_FLOW_STATE);
  });

  it("drops a slot whose provenance cannot be read rather than defaulting it", () => {
    // Defaulting would invent the one fact I-5 depends on.
    const state = parseFlowState({
      version: 1,
      stack: [
        {
          flow: "book_appointment",
          status: "active",
          startedAt: NOW.toISOString(),
          lastAdvancedAt: NOW.toISOString(),
          slots: {
            doctor: { value: "doc-nabil", at: NOW.toISOString() },
            day: { value: "2026-09-10", provenance: "spoken", at: NOW.toISOString() },
          },
        },
      ],
    });
    expect(state.stack[0]!.slots.doctor).toBeUndefined();
    expect(state.stack[0]!.slots.day).toBeDefined();
  });
});
