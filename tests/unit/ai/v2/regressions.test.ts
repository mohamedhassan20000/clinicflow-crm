/**
 * One test per defect found in the V2 read-only review, each pinned to the
 * behaviour that was actually wrong rather than to the shape of the fix.
 *
 * The numbering is the review's. Where a finding was invisible to the existing
 * suite, the reason is noted — usually because every booking fixture happened
 * to pre-fill the state the bug depended on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readKnownDepartments: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readRescheduleTarget: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));
vi.mock("@/lib/ai/v2/tools", () => stubs);

import type { Command } from "@/lib/ai/v2/commands";
import {
  EMPTY_FLOW_STATE,
  activeFrame,
  newFrame,
  type FlowState,
  type Slot,
} from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import {
  composeDeterministic,
  COMPOSER_COPY,
  SILENT_COPY_KEYS,
} from "@/lib/ai/v2/composer";
import type { FlowDefinition } from "@/lib/ai/v2/flow-definition";
import type { TurnContext } from "@/lib/ai/v2/context";
import { escalationReasonForHandoff } from "@/lib/ai/v2/runtime";
import { resolveConversationLifecycle } from "@/lib/ai/conversation-lifecycle";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

const DERMA = { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const };
const CARDIO = { value: "dept-cardio", label: "القلب", source: "clinic_directory" as const };
const NABIL = { value: "doc-nabil", label: "Ahmed Nabil", source: "clinic_directory" as const };

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
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
    identity: "verified",
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "24h",
    },
    style: { language: "ar", arabicStyle: "egyptian", tone: "friendly", styleInstruction: null },
    now: NOW,
    ...overrides,
  };
}

function slotValue(value: string): Slot {
  return { value, provenance: "spoken", at: AT };
}

function frameWith(
  flow: Parameters<typeof newFrame>[0]["flow"],
  slots: Record<string, Slot> = {},
  extra: Partial<ReturnType<typeof newFrame>> = {},
): FlowState {
  return { version: 1, stack: [{ ...newFrame({ flow, at: AT }), slots, ...extra }] };
}

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

/** A booking with everything the patient has to choose already chosen. */
const READY_TO_CONFIRM = {
  beneficiary: slotValue("self"),
  department: slotValue("dept-derma"),
  doctor: slotValue("doc-nabil"),
  day: slotValue("2026-09-10"),
  time: slotValue("10:00"),
};

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([DERMA, CARDIO]);
  stubs.readDoctors.mockResolvedValue([NABIL]);
  stubs.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-05",
    windowEnd: "2026-09-11",
    days: [{ value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" }],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [{ value: "10:00", label: "10:00", source: "clinic_directory" }],
  });
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readPublicPackages.mockResolvedValue([]);
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.readRescheduleTarget.mockResolvedValue({
    ok: true,
    doctorId: "doc-nabil",
    doctorName: "Ahmed Nabil",
    serviceId: null,
    durationMinutes: 30,
  });
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
  stubs.commitCancellation.mockResolvedValue({ ok: true });
  stubs.commitReschedule.mockResolvedValue({ ok: true });
});

// ===========================================================================
// 1 — the package step dead-ended the booking
// ===========================================================================

describe("finding 1: a patient who owns no package can still finish booking", () => {
  /**
   * `package_offer` declared `fills: "package"` and exited with `inform`, which
   * marks only `fills: null` steps done. `nextStep` therefore returned it
   * forever: the turn spun to the silent-step bound and answered with the
   * generic clarification, and `commitBooking` was never reached.
   *
   * Invisible to the old suite because every booking fixture pre-filled a
   * `package` slot, which is the one thing that made the step terminate.
   */
  it("reaches the summary rather than looping on the package step", async () => {
    const result = await turn([], context({ flows: frameWith("book_appointment", READY_TO_CONFIRM) }));

    const offers = result.effects.filter((effect) => effect.kind === "offer");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ key: "booking.review" });
    // The bug's signature: the same step reported over and over in one turn.
    expect(result.trace.filter((entry) => entry.includes("package_offer"))).toHaveLength(1);
    expect(reply(result.effects)).toContain("تحب تأكد الطلب؟");
  });

  it("commits the booking on confirmation, with no package", async () => {
    const state = frameWith("book_appointment", READY_TO_CONFIRM, {
      memo: { confirmed: true },
    });
    await turn([], context({ flows: state }));

    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: null, doctorId: "doc-nabil" }),
    );
  });

  it("does not invent a package slot to get past the step", async () => {
    const result = await turn([], context({ flows: frameWith("book_appointment", READY_TO_CONFIRM) }));
    // "No package" must not be recorded as though one had been selected.
    expect(activeFrame(result.state)?.slots.package).toBeUndefined();
  });

  it("asks the package question once and never again after a decline", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة · 4", source: "patient_packages" },
    ]);
    const offered = await turn([], context({ flows: frameWith("book_appointment", READY_TO_CONFIRM) }));
    const offer = offered.effects.find((effect) => effect.kind === "offer");
    expect(offer).toMatchObject({ key: "booking.package_offer" });

    const declined = await turn(
      [{ kind: "reject_offer", offerId: (offer as Extract<Effect, { kind: "offer" }>).offer.id }],
      context({ flows: offered.state }),
    );
    expect(activeFrame(declined.state)?.memo.package_declined).toBe(true);
    // The very next thing is the summary, not the same question again.
    expect(
      declined.effects.some(
        (effect) => effect.kind === "offer" && effect.key === "booking.package_offer",
      ),
    ).toBe(false);
    expect(
      declined.effects.some((effect) => effect.kind === "offer" && effect.key === "booking.review"),
    ).toBe(true);
  });

  it("still consumes a session when the patient accepted one", async () => {
    const state = frameWith("book_appointment", READY_TO_CONFIRM, {
      memo: { confirmed: true, package_accepted: true, package_id: "pkg-1" },
    });
    await turn([], context({ flows: state }));
    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: "pkg-1" }),
    );
  });
});

// ===========================================================================
// 2 — verified identity was a booking prerequisite
// ===========================================================================

describe("finding 2: a linked patient can book without verifying identity", () => {
  /**
   * `package_offer` sat between `time` and `confirm` with `identity: "verified"`
   * while `confirm` needed only `linked`, so the precondition gate stopped every
   * linked-but-unverified patient — the ordinary WhatsApp thread — with
   * "we need to verify your identity", on a turn about neither identity nor
   * packages.
   */
  it("does not demand verification to reach the summary", async () => {
    const result = await turn(
      [],
      context({ flows: frameWith("book_appointment", READY_TO_CONFIRM), identity: "linked" }),
    );

    expect(result.trace).not.toContain("step_identity_required");
    expect(reply(result.effects)).not.toContain("نتأكد من هويتك");
    expect(
      result.effects.some((effect) => effect.kind === "offer" && effect.key === "booking.review"),
    ).toBe(true);
  });

  it("keeps package ownership itself at `verified`", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة · 4", source: "patient_packages" },
    ]);
    await turn(
      [],
      context({ flows: frameWith("book_appointment", READY_TO_CONFIRM), identity: "linked" }),
    );
    // The disclosure did not happen: a linked patient is never told what they own.
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
  });

  it("still offers the package to a verified patient", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة · 4", source: "patient_packages" },
    ]);
    const result = await turn(
      [],
      context({ flows: frameWith("book_appointment", READY_TO_CONFIRM), identity: "verified" }),
    );
    expect(stubs.readPatientPackages).toHaveBeenCalled();
    expect(
      result.effects.some(
        (effect) => effect.kind === "offer" && effect.key === "booking.package_offer",
      ),
    ).toBe(true);
  });

  it("still refuses to write a booking for an anonymous sender", async () => {
    // The preconditions that matter — `intake`'s and `confirm`'s — are
    // untouched. An anonymous sender is routed into intake and collects a file
    // before anything is written, which is the pre-existing behaviour.
    const result = await turn(
      [],
      context({ flows: frameWith("book_appointment", READY_TO_CONFIRM), identity: "anonymous" }),
    );
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(result.trace).toContain("step_intake_ask");
  });

  // P12B — a staged file is a patient, and the write path has always known it.
  //
  // This asserted the opposite until manual QA showed what it cost: a stranger
  // typed out their whole file, the intake staged it, and `confirm`'s
  // `identity: "linked"` precondition then answered them with «لازم نتأكد من
  // هويتك الأول. فريق العيادة هيساعدك في ده» — an identity challenge about a
  // topic nobody had raised, and the end of the conversation. Staging cannot
  // produce a linkage: only `approve_ai_patient_intake` sets
  // `conversations.patient_id`, and that is a staff action on another day.
  //
  // The precondition was narrower than the write it guarded.
  // `createPatientPendingBooking` takes the linked branch only for a linked,
  // non-third-party sender and otherwise writes a *provisional* AI appointment
  // request — the same pending-review artefact the staged file is. So the gate
  // moved into `confirm`'s own `run` and became a stronger statement of the
  // property that actually matters: every booking must have a patient behind
  // it, by linkage, by discovery, or by a staging on this frame.
  it("writes the booking once a file has been staged on this frame", async () => {
    const staged = frameWith("book_appointment", READY_TO_CONFIRM, {
      memo: { "done:intake": true, intake_staged: true, confirmed: true },
    });
    const result = await turn([], context({ flows: staged, identity: "anonymous" }));
    expect(stubs.commitBooking).toHaveBeenCalled();
    expect(result.trace).not.toContain("step_identity_required");
  });

  it("refuses the write when nothing on the frame names a patient", async () => {
    // The other side of the same gate, and the one that carries I-4: a
    // confirmed booking whose intake step neither staged nor matched a file has
    // nobody to belong to, so it hands over rather than filing the appointment
    // against the sender.
    const orphaned = frameWith("book_appointment", READY_TO_CONFIRM, {
      memo: { "done:intake": true, confirmed: true },
    });
    const result = await turn([], context({ flows: orphaned, identity: "anonymous" }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(
      result.effects.some((effect) => effect.kind === "handoff"),
    ).toBe(true);
  });
});

// ===========================================================================
// 3 / 4 — handoff and end-of-conversation reached the patient as a greeting
// ===========================================================================

describe("finding 3: a request for a person is answered as one", () => {
  it("renders handoff copy instead of the clarification fallback", async () => {
    const result = await turn(
      [{ kind: "request_handoff", reason: "patient_requested_human" }],
      context(),
    );
    const text = reply(result.effects);
    expect(text).not.toBe(COMPOSER_COPY["clarify.open"]!.ar);
    expect(text).toContain("فريق العيادة");
  });

  it("gives every handoff reason its own line, in both languages", async () => {
    for (const reason of [
      "patient_requested_human",
      "clinical_question",
      "complaint",
      "payment_dispute",
      "unsupported_request",
    ] as const) {
      const result = await turn([{ kind: "request_handoff", reason }], context());
      for (const locale of ["ar", "en"] as const) {
        const text = reply(result.effects, locale);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(COMPOSER_COPY["clarify.open"]![locale]);
      }
    }
  });

  it("maps engine reasons onto the escalation vocabulary", () => {
    expect(escalationReasonForHandoff("patient_requested_human")).toBe("human_requested");
    expect(escalationReasonForHandoff("clinical_question")).toBe("medical");
    expect(escalationReasonForHandoff("complaint")).toBe("complaint");
    expect(escalationReasonForHandoff("payment_dispute")).toBe("complaint");
    expect(escalationReasonForHandoff("unsupported_request")).toBe("low_confidence");
    // Total: anything unenumerated is a fault, not an ordinary uncertain turn.
    expect(escalationReasonForHandoff("flow_stuck")).toBe("agent_error");
    expect(escalationReasonForHandoff("something_new")).toBe("agent_error");
  });
});

describe("finding 4: a step that gives up says why", () => {
  it("keeps the step's own copy key on the handoff", async () => {
    stubs.readDepartments.mockResolvedValue([]);
    const result = await turn(
      [],
      context({ flows: frameWith("book_appointment", { beneficiary: slotValue("self") }) }),
    );

    const handoff = result.effects.find((effect) => effect.kind === "handoff");
    expect(handoff).toMatchObject({ key: "booking.no_departments" });
    expect(reply(result.effects)).toBe(COMPOSER_COPY["booking.no_departments"]!.ar);
  });
});

describe("finding 3/4: end_conversation says goodbye", () => {
  it("does not fall through to the clarification", async () => {
    const result = await turn([{ kind: "end_conversation" }], context());
    expect(reply(result.effects)).toBe(COMPOSER_COPY["conversation.ended"]!.ar);
  });

  it("closes the thread through the lifecycle when the engine ended it", () => {
    const decision = resolveConversationLifecycle({
      locale: "ar",
      latestPatientText: "خلاص شكرا",
      lastAssistantText: null,
      replyText: "تحت أمرك",
      // Everything else says "keep going" — the engine's verdict outranks it.
      outstanding: true,
      goalCompleted: false,
      informationAnswered: false,
      endRequested: true,
    });
    expect(decision.kind).toBe("close");
  });

  it("leaves the legacy path unchanged when nothing ended it", () => {
    const decision = resolveConversationLifecycle({
      locale: "ar",
      latestPatientText: "تمام",
      lastAssistantText: null,
      replyText: "تحت أمرك",
      outstanding: true,
      goalCompleted: false,
      informationAnswered: false,
    });
    expect(decision.kind).toBe("continue");
  });
});

// ===========================================================================
// 5 — "departments you are known in" meant "every department"
// ===========================================================================

describe("finding 5: known departments are the patient's own", () => {
  it("orders the treating department first without claiming the rest", async () => {
    // The durable loader is the firewall's L4; the booking step reads it to
    // order the list. Previously it returned every department in the clinic.
    stubs.readTreatingDoctors.mockResolvedValue([NABIL]);
    const result = await turn(
      [],
      context({
        flows: frameWith("book_appointment", { beneficiary: slotValue("self") }),
        durable: {
          treatingDoctors: async () => [
            { value: "doc-nabil", label: "Ahmed Nabil", source: "patient_history" },
          ],
          knownDepartments: async () => [
            { value: "dept-cardio", label: "القلب", source: "patient_history" },
          ],
          activePackages: async () => [],
          issuedDocuments: async () => [],
          appointments: async () => [],
          canonicalName: async () => null,
        },
      }),
    );
    const offer = result.effects.find((effect) => effect.kind === "offer");
    const options = (offer as Extract<Effect, { kind: "offer" }>).offer.options;
    expect(options.map((option) => option.value)).toEqual(["dept-cardio", "dept-derma"]);
  });

  it("says previously_seen only when something actually was", async () => {
    const result = await turn(
      [],
      context({ flows: frameWith("book_appointment", { beneficiary: slotValue("self") }) }),
    );
    const offer = result.effects.find((effect) => effect.kind === "offer");
    expect((offer as Extract<Effect, { kind: "offer" }>).facts).toMatchObject({
      previously_seen: false,
    });
  });
});

// ===========================================================================
// 6 — reschedule accepted ungrounded dates
// ===========================================================================

describe("finding 6: reschedule dates are server-authorized", () => {
  const RESCHEDULING = frameWith("reschedule_appointment", {
    appointment: slotValue("appt-1"),
  });

  it("offers days read from the clinic calendar", async () => {
    const result = await turn([], context({ flows: RESCHEDULING, identity: "linked" }));
    expect(stubs.readAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: "doc-nabil" }),
    );
    const offer = result.effects.find((effect) => effect.kind === "offer");
    expect(offer).toMatchObject({ key: "reschedule.choose_day" });
  });

  it("refuses a day the server never offered", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "بكرة" }],
      context({ flows: RESCHEDULING, identity: "linked" }),
    );
    // The bug: "بكرة" was committed verbatim and passed to the RPC as a date.
    expect(activeFrame(result.state)?.slots.day).toBeUndefined();
    expect(result.trace).toContain("slot_unresolved");
  });

  it("commits a day the server did offer", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "2026-09-10" }],
      context({ flows: RESCHEDULING, identity: "linked" }),
    );
    expect(activeFrame(result.state)?.slots.day?.value).toBe("2026-09-10");
  });

  it("sends the clinic's calendar day and time to the write, not a bare clock time", async () => {
    const ready = frameWith(
      "reschedule_appointment",
      { appointment: slotValue("appt-1"), day: slotValue("2026-09-10"), time: slotValue("10:00") },
      { memo: { confirmed: true } },
    );
    await turn([], context({ flows: ready, identity: "linked" }));
    expect(stubs.commitReschedule).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-09-10", time: "10:00" }),
    );
  });

  it("resolves the appointment into its doctor before reading any calendar", async () => {
    await turn([], context({ flows: RESCHEDULING, identity: "linked" }));
    expect(stubs.readRescheduleTarget).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: "appt-1" }),
    );
  });

  it("re-resolves the doctor when the patient changes which appointment to move", async () => {
    // The staleness class a cached target would have created: `choose`
    // invalidates day and time, but the correction cascade clears slots and not
    // memo entries, so a cached doctor would have survived into the wrong diary.
    stubs.readMyAppointments.mockResolvedValue([
      { appointment_id: "appt-2", scheduled_at: "2026-09-20T09:00:00.000Z" },
    ]);
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "appointment", value: "appt-2" }],
      context({ flows: RESCHEDULING, identity: "linked" }),
    );
    const asked = stubs.readRescheduleTarget.mock.calls.map(
      (call) => (call[0] as { appointmentId: string }).appointmentId,
    );
    expect(asked).not.toContain("appt-1");
    expect(corrected.state.stack).toHaveLength(1);
  });

  it("hands over when the appointment cannot be resolved at all", async () => {
    stubs.readRescheduleTarget.mockResolvedValue({ ok: false });
    const result = await turn([], context({ flows: RESCHEDULING, identity: "linked" }));
    const handoff = result.effects.find((effect) => effect.kind === "handoff");
    expect(handoff).toMatchObject({ key: "reschedule.unavailable" });
  });
});

// ===========================================================================
// the loop guard that makes finding 1's whole class loud
// ===========================================================================

describe("a flow that cannot make progress hands over instead of looping", () => {
  it("refuses to run the same step twice in one turn", async () => {
    // A deliberately broken definition: a step that neither fills nor records.
    const broken: FlowDefinition = {
      name: "package_inquiry",
      onAbandon: "discard",
      public: true,
      steps: [
        {
          id: "never_finishes",
          fills: "service",
          pre: { slots: [], identity: "none" },
          run: async () => ({ kind: "inform", say: "info.unavailable" }),
        },
      ],
    };
    const result = await runEngine({
      context: context({ flows: frameWith("package_inquiry") }),
      commands: [],
      registry: { ...FLOW_REGISTRY, package_inquiry: broken },
    });

    expect(result.trace).toContain("step_never_finishes_stuck");
    const handoff = result.effects.find((effect) => effect.kind === "handoff");
    expect(handoff).toMatchObject({ reason: "flow_stuck" });
    // The step's own sentence is kept, and the handover is appended to it.
    expect(reply(result.effects)).toContain(COMPOSER_COPY["flow.stuck"]!.ar);
  });

  it("hands over rather than going quiet when silent steps run too deep", async () => {
    // The other shape of the same failure: a chain of *distinct* steps that
    // never reaches a question. It used to end the turn with no effects worth
    // rendering, which fell through to the generic clarification.
    const chain: FlowDefinition = {
      name: "package_inquiry",
      onAbandon: "discard",
      public: true,
      steps: Array.from({ length: 12 }, (_unused, index) => ({
        id: `silent_${index}`,
        fills: null,
        pre: { slots: [], identity: "none" as const },
        run: async () => ({ kind: "inform" as const, say: "booking.package_none" }),
      })),
    };
    const result = await runEngine({
      context: context({ flows: frameWith("package_inquiry") }),
      commands: [],
      registry: { ...FLOW_REGISTRY, package_inquiry: chain },
    });

    expect(result.trace).toContain("advance_depth_exhausted");
    expect(reply(result.effects)).toBe(COMPOSER_COPY["flow.stuck"]!.ar);
    expect(reply(result.effects)).not.toBe(COMPOSER_COPY["clarify.open"]!.ar);
  });
});

// ===========================================================================
// the loop hazard, as a structural property of every flow definition
// ===========================================================================

describe("no slot-filling step can report and re-advance", () => {
  /**
   * The shape of finding 1, stated once for the whole registry.
   *
   * `nextStep` finishes a `fills` step only when its slot holds a value, and
   * `inform` re-advances without filling one — so any step combining the two
   * is selected again immediately, forever. Three booking steps and both
   * reschedule calendar steps had it; they say "there is nothing available,
   * shall we try something else?", which is a question, and `ask` is how a
   * step asks one and ends the turn.
   */
  it("holds for every step in the registry", () => {
    const offenders: string[] = [];
    for (const flow of Object.values(FLOW_REGISTRY)) {
      for (const step of flow.steps) {
        if (!step.fills) continue;
        const source = step.run.toString();
        if (/kind:\s*"inform"/.test(source)) offenders.push(`${flow.name}.${step.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("no free-text slot selects a record", () => {
  /**
   * Finding 6, generalised. A slot whose value picks a doctor, a day, a time or
   * an appointment must be grounded against server-authorized values; only
   * genuinely free-text fields (a name, an email) may commit what the patient
   * typed.
   */
  it("every record-selecting slot declares a resolver", () => {
    const grounded = new Set(["doctor", "day", "time", "department", "appointment", "package"]);
    const ungrounded: string[] = [];
    for (const flow of Object.values(FLOW_REGISTRY)) {
      for (const step of flow.steps) {
        if (step.fills && grounded.has(step.fills) && !step.resolveValue) {
          ungrounded.push(`${flow.name}.${step.id}`);
        }
      }
    }
    expect(ungrounded).toEqual([]);
  });
});

// ===========================================================================
// copy completeness — every key the engine can emit must render
// ===========================================================================

describe("composer copy is total", () => {
  it("has both languages for every key", () => {
    for (const [key, copy] of Object.entries(COMPOSER_COPY)) {
      expect(copy.ar, `${key} ar`).toBeTruthy();
      expect(copy.en, `${key} en`).toBeTruthy();
    }
  });

  it("renders every key a flow definition can emit", () => {
    // Scraped from the definitions rather than listed by hand, so a new step
    // with a new key fails here instead of reaching a patient as a missing-copy
    // warning and a silently dropped sentence.
    const silent = new Set([
      "booking.package_accepted",
      "booking.package_skipped",
      "booking.package_none",
      "booking.package_not_offered",
      "booking.intake_not_needed",
      "identity.already_checked",
      "reschedule.target_ready",
    ]);
    const emitted = new Set<string>();
    for (const flow of Object.values(FLOW_REGISTRY)) {
      // Every flow can fall through to `${flow}.completed` when it runs out of
      // steps — the path that produced a warning for every flow in the registry.
      emitted.add(`${flow.name}.completed`);
      for (const step of flow.steps) {
        for (const match of step.run.toString().matchAll(/say:\s*"([^"]+)"/g)) {
          emitted.add(match[1]!);
        }
      }
    }
    expect(emitted.size).toBeGreaterThan(20);
    const missing = [...emitted].filter(
      (key) => !COMPOSER_COPY[key] && !silent.has(key) && !SILENT_COPY_KEYS.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("has the engine's own keys, and keeps the silent ones silent", () => {
    for (const key of ["flow.stuck", "conversation.ended", "handoff.default"]) {
      expect(COMPOSER_COPY[key], key).toBeTruthy();
    }
    for (const key of SILENT_COPY_KEYS) {
      // A silent key must stay absent from COPY, or it would start speaking.
      expect(COMPOSER_COPY[key], key).toBeUndefined();
    }
  });
});
