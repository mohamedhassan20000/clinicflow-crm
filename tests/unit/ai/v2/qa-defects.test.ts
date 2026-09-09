/**
 * The eight defects from the manual QA pass, as deterministic contracts.
 *
 * Each block below names the observed behaviour and asserts the property that
 * makes it impossible, not the sentence that happened to be produced. Where a
 * defect was a *missing side effect* — the third-party file, the pending
 * booking — the assertion is on the authoritative call and its arguments,
 * because a test on the wording would have passed for the whole time the bug
 * was live: the assistant's sentences were fine, and nothing was written.
 *
 * The tool layer is stubbed at the module boundary, so the flow definitions,
 * the engine, the preconditions and the composer are all the real ones.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
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
import { composeDeterministic, introducesNumbers } from "@/lib/ai/v2/composer";
import { interpreterView } from "@/lib/ai/v2/context";
import { renderInterpreterView } from "@/lib/ai/v2/interpreter";
import { normalizeSpokenDate, normalizeSpokenTime } from "@/lib/ai/v2/normalize";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

const PT = { value: "dept-pt", label: "Physical Therapy", source: "clinic_directory" as const };
const DERMA = { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const };
const NABIL = { value: "doc-nabil", label: "Ahmed Nabil", source: "clinic_directory" as const };

/** The real ClinicFlow physiotherapy catalog from the QA pass. */
const CATALOG = {
  groups: [
    {
      departmentId: "dept-pt",
      departmentName: "Physical Therapy",
      services: [
        { id: "s1", name: "Physical Therapy Assessment", price: 1000 },
        { id: "s2", name: "Posture Correction Program", price: 1400 },
        { id: "s3", name: "Rehabilitation Session", price: 1600 },
        { id: "s4", name: "Sports Injury Therapy", price: 2200 },
      ],
    },
  ],
  currency: "TRY",
  total: 4,
};

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
    identity: "linked",
    patientId: "patient-sender",
    clinic: {
      name: "Clinic",
      timeZone: "Europe/Istanbul",
      locale: "ar",
      country: "TR",
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

function reply(effects: readonly Effect[], locale: "ar" | "en" = "en") {
  return composeDeterministic({ effects, locale }).text;
}

function askedSlot(effects: readonly Effect[]): string | null {
  const ask = effects.find((effect) => effect.kind === "ask");
  return ask && ask.kind === "ask" ? ask.slot : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([PT, DERMA]);
  stubs.readDoctors.mockResolvedValue([NABIL]);
  stubs.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readServices.mockResolvedValue(CATALOG);
  stubs.readPublicPackages.mockResolvedValue([]);
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-05",
    windowEnd: "2026-09-11",
    days: [
      { value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" },
      { value: "2026-09-11", label: "2026-09-11", source: "clinic_directory" },
    ],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [
      { value: "12:15", label: "12:15", source: "clinic_directory" },
      { value: "14:00", label: "14:00", source: "clinic_directory" },
    ],
  });
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
});

// ---------------------------------------------------------------------------
// A — the authoritative service catalog (QA defect 1)
// ---------------------------------------------------------------------------

describe("A: service and price answers are the clinic's own rows", () => {
  it("answers a services question from the catalog, names and prices exactly", async () => {
    const result = await turn(
      [{ kind: "answer_question", topic: "services" }],
      context(),
    );
    expect(stubs.readServices).toHaveBeenCalledTimes(1);
    const text = reply(result.effects);
    for (const service of CATALOG.groups[0]!.services) {
      expect(text).toContain(service.name);
      expect(text).toContain(String(service.price));
    }
    // The invented entries from the QA transcript. Neither is in the catalog,
    // and nothing in the pipeline can produce a name the read did not return.
    expect(text).not.toContain("Physical Therapy Session");
    expect(text).not.toContain("Sports Injury Assessment");
    expect(text).not.toContain("1200");
  });

  it("a price question uses the same authoritative read", async () => {
    await turn([{ kind: "answer_question", topic: "prices" }], context());
    expect(stubs.readServices).toHaveBeenCalledTimes(1);
  });

  it("scopes to the department the patient named, and only that one", async () => {
    stubs.resolveDepartmentSpoken.mockResolvedValue([PT]);
    await turn(
      [{ kind: "answer_question", topic: "services", scope: "العلاج الطبيعي" }],
      context(),
    );
    expect(stubs.readServices).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: "dept-pt" }),
    );
  });

  it("says there is nothing configured rather than filling the gap", async () => {
    stubs.readServices.mockResolvedValue({ groups: [], currency: null, total: 0 });
    const result = await turn(
      [{ kind: "answer_question", topic: "services" }],
      context(),
    );
    expect(composeDeterministic({ effects: result.effects, locale: "en" }).keys).toContain(
      "info.services_none",
    );
    expect(reply(result.effects)).not.toMatch(/\d/);
  });

  it("re-queries the catalog when the patient challenges the answer", async () => {
    const first = await turn([{ kind: "answer_question", topic: "services" }], context());
    // The frame completed, so the follow-up is a fresh question — and a fresh
    // read. Nothing is answered from what was said last turn.
    const second = await turn(
      [{ kind: "answer_question", topic: "services" }],
      context({ flows: first.state }),
    );
    expect(stubs.readServices).toHaveBeenCalledTimes(2);
    expect(reply(second.effects)).toContain("Sports Injury Therapy");
  });

  it("the composer's polish may not introduce a number the server did not give", () => {
    const source = "Our services and prices: Physical Therapy Assessment — 1000 TRY.";
    expect(introducesNumbers(source, "التقييم بـ 1000 ليرة")).toBe(false);
    expect(introducesNumbers(source, "التقييم بـ ١٠٠٠ ليرة")).toBe(false);
    // The QA hallucination, as a string: a service and a price that were never
    // in the deterministic sentence.
    expect(
      introducesNumbers(source, "Assessment 1000 TRY and Sports Injury Assessment 1200 TRY"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B — Arabic time, and the clarification loop (QA defect 2)
// ---------------------------------------------------------------------------

describe("B: natural Arabic time answers a pending time question", () => {
  const readyForTime = () =>
    frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-pt"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
    });

  it("«12 وربع» commits the 12:15 the calendar offered", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "12 وربع" }],
      context({ flows: readyForTime() }),
    );
    expect(activeFrame(result.state)?.slots.time?.value).toBe("12:15");
  });

  it("«12:15» commits the same slot", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "12:15" }],
      context({ flows: readyForTime() }),
    );
    expect(activeFrame(result.state)?.slots.time?.value).toBe("12:15");
    expect(result.trace).toContain("set_slot");
  });

  it("progresses past the time question once it is answered", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "١٢ و ربع" }],
      context({ flows: readyForTime() }),
    );
    expect(activeFrame(result.state)?.slots.time?.value).toBe("12:15");
    // The turn moved on to the summary rather than asking about the time again.
    expect(result.trace.some((entry) => entry.startsWith("step_confirm"))).toBe(true);
  });

  it("never repeats the same generic clarification twice for one slot", async () => {
    const first = await turn(
      [{ kind: "set_slot", slot: "time", value: "أي وقت" }],
      context({ flows: readyForTime() }),
    );
    expect(first.trace).toContain("slot_unresolved");
    const second = await turn(
      [{ kind: "set_slot", slot: "time", value: "مش عارف" }],
      context({ flows: first.state }),
    );
    // The second unanswerable attempt shows the real choices instead of the
    // same unanswerable sentence.
    expect(second.trace).toContain("slot_unresolved_reask");
    expect(second.effects.some((effect) => effect.kind === "offer")).toBe(true);
    expect(reply(second.effects)).toContain("12:15");
  });

  it("a time no offered slot carries is still refused", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "٣ ونص" }],
      context({ flows: readyForTime() }),
    );
    expect(activeFrame(result.state)?.slots.time).toBeUndefined();
  });

  it("tells the interpreter which slot an open question is waiting on", async () => {
    const asked = await turn([], context({ flows: readyForTime() }));
    const view = interpreterView(
      context({ flows: asked.state, turn: { text: "12 وربع", receivedAt: AT, locale: "ar", attachments: [] } }),
    );
    // Offered times mint an offer, so the referent is the offer's slot.
    expect(view.activeFlow?.awaitingSlot).toBe("time");
    expect(renderInterpreterView(view)).toContain("time");
  });

  it("normalizes the shapes patients actually send", () => {
    expect(normalizeSpokenTime("12 وربع")).toEqual({ kind: "times", times: ["12:15", "00:15"] });
    expect(normalizeSpokenTime("12:15")).toEqual({ kind: "times", times: ["12:15", "00:15"] });
    expect(normalizeSpokenTime("١٢:١٥")).toEqual({ kind: "times", times: ["12:15", "00:15"] });
    expect(normalizeSpokenTime("الساعة ٣ العصر")).toEqual({ kind: "times", times: ["15:00"] });
    expect(normalizeSpokenTime("4 إلا ربع")).toEqual({ kind: "times", times: ["03:45", "15:45"] });
    expect(normalizeSpokenTime("14:30")).toEqual({ kind: "times", times: ["14:30"] });
    expect(normalizeSpokenTime("مش عارف")).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// C — booking ownership, established first (QA defect 3)
// ---------------------------------------------------------------------------

describe("C: who the appointment is for is settled before anything personal", () => {
  it("asks ownership as the first question of a booking", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context(),
    );
    expect(composeDeterministic({ effects: result.effects, locale: "en" }).keys).toContain(
      "booking.who_is_this_for",
    );
    // Nothing person-specific has been read yet.
    expect(stubs.readDepartments).not.toHaveBeenCalled();
    expect(stubs.readDoctors).not.toHaveBeenCalled();
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
  });

  it("does not assume the sender is the patient, even when linked and verified", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context({ identity: "verified" }),
    );
    expect(activeFrame(result.state)?.slots.beneficiary).toBeUndefined();
  });

  it("reads «لشخص تاني» as someone else and «ليا» as self", async () => {
    const other = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "لشخص تاني" }],
      context({ flows: frameWith("book_appointment") }),
    );
    expect(activeFrame(other.state)?.slots.beneficiary?.value).toBe("other");
    const self = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "ليا أنا" }],
      context({ flows: frameWith("book_appointment") }),
    );
    expect(activeFrame(self.state)?.slots.beneficiary?.value).toBe("self");
  });

  it("only offers the sender's own history once the booking is for them", async () => {
    const forOther = frameWith("book_appointment", {
      beneficiary: slotValue("other"),
      department: slotValue("dept-pt"),
    });
    await turn([], context({ flows: forOther, identity: "verified" }));
    expect(stubs.readTreatingDoctors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D & E — third-party data stays the third party's, and slots are kept
// (QA defects 4 and 5)
// ---------------------------------------------------------------------------

describe("D/E: third-party intake keeps its own slots", () => {
  const midIntake = (slots: Record<string, Slot> = {}) =>
    frameWith("book_appointment", {
      beneficiary: slotValue("other"),
      department: slotValue("dept-pt"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      ...slots,
    });

  it("asks for the other person's name, not the sender's", async () => {
    const result = await turn([], context({ flows: midIntake() }));
    expect(askedSlot(result.effects)).toBe("full_name");
    expect(reply(result.effects)).toContain("patient's full name");
  });

  it("keeps the name once given and never asks for it again", async () => {
    // The exact QA sequence: name, then id, then date of birth, then email.
    let state = midIntake();
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "جهاد محمد" }],
      context({ flows: state }),
    );
    expect(activeFrame(named.state)?.slots.full_name?.value).toBe("جهاد محمد");
    // The English spelling of the name just given is the next question, and it
    // arrives as a proposal to confirm rather than a blank — see
    // `latinNameOutcome`. Nothing is filed until the patient answers it.
    const latinOffer = named.effects.find((effect) => effect.kind === "offer");
    expect(
      latinOffer && latinOffer.kind === "offer" ? latinOffer.offer.slot : null,
    ).toBe("full_name_latin");
    expect(activeFrame(named.state)?.slots.full_name_latin).toBeUndefined();

    const spelled = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "Gehad Mohamed" }],
      context({ flows: named.state }),
    );
    expect(activeFrame(spelled.state)?.slots.full_name_latin?.value).toBe("Gehad Mohamed");
    expect(askedSlot(spelled.effects)).toBe("national_id");

    state = spelled.state;
    const identified = await turn(
      [{ kind: "set_slot", slot: "national_id", value: "٢٩٠٠١٠١٢٣٤٥٦٧" }],
      context({ flows: state }),
    );
    expect(activeFrame(identified.state)?.slots.national_id?.value).toBe("29001012345 67".replace(" ", ""));
    expect(activeFrame(identified.state)?.slots.full_name?.value).toBe("جهاد محمد");
    expect(askedSlot(identified.effects)).toBe("date_of_birth");

    const born = await turn(
      [{ kind: "set_slot", slot: "date_of_birth", value: "15/3/1990" }],
      context({ flows: identified.state }),
    );
    expect(activeFrame(born.state)?.slots.date_of_birth?.value).toBe("1990-03-15");
    expect(activeFrame(born.state)?.slots.full_name?.value).toBe("جهاد محمد");
    expect(askedSlot(born.effects)).toBe("email");

    const mailed = await turn(
      [{ kind: "set_slot", slot: "email", value: "gehad@example.com" }],
      context({ flows: born.state }),
    );
    // Every earlier answer survived to the staging call.
    expect(activeFrame(mailed.state)?.slots.full_name?.value).toBe("جهاد محمد");
    expect(askedSlot(mailed.effects)).not.toBe("full_name");
  });

  it("an intake answer is never dropped for belonging to no step", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "جهاد محمد" }],
      context({ flows: midIntake() }),
    );
    expect(result.trace).not.toContain("slot_not_in_flow");
    expect(result.trace).toContain("set_slot");
  });

  it("stages the third party's details, flagged as a third party", async () => {
    const state = midIntake({
      full_name: slotValue("جهاد محمد"),
      full_name_latin: slotValue("Gehad Mohamed"),
      national_id: slotValue("29001012345678"),
      date_of_birth: slotValue("1990-03-15"),
      email: slotValue("gehad@example.com"),
      // The patient's own number and their optional blood group. Both are
      // asked for now, and the staging refuses a third-party file without the
      // first — see `intakeFieldsFor`.
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });
    await turn([], context({ flows: state }));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        // The canonical name is the confirmed Latin spelling and the Arabic
        // the patient typed travels beside it — the existing P10 shape, now
        // reached by the booking flow too because the intake asks for the
        // English spelling (see `latinNameOutcome`).
        fullName: "Gehad Mohamed",
        fullNameOriginal: "جهاد محمد",
        nationalId: "29001012345678",
        dateOfBirth: "1990-03-15",
        email: "gehad@example.com",
        forThirdParty: true,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// F — Arabic dates (QA defect 6)
// ---------------------------------------------------------------------------

describe("F: dates of birth are normalized, and confirmed when undecidable", () => {
  it("normalizes an unambiguous Arabic date without a question", () => {
    expect(normalizeSpokenDate("١٥/٣/١٩٩٠")).toEqual({ kind: "dates", dates: ["1990-03-15"] });
    expect(normalizeSpokenDate("15 مارس 1990")).toEqual({ kind: "dates", dates: ["1990-03-15"] });
    expect(normalizeSpokenDate("1990-03-15")).toEqual({ kind: "dates", dates: ["1990-03-15"] });
  });

  it("returns both readings when the day/month order is undecidable", () => {
    expect(normalizeSpokenDate("04/03/1990")).toEqual({
      kind: "dates",
      dates: ["1990-03-04", "1990-04-03"],
    });
  });

  /**
   * Deliberately changed in the third QA polish pass, and this is the contract
   * that replaced the one above it.
   *
   * The original assertion was that an undecidable numeric order is *offered*
   * rather than picked, and the reasoning was sound in the abstract. In
   * practice `04/03/1990` and `2.4.2003` are not two things a patient might
   * have meant — they are one date written the way this clinic's patients
   * write dates, and the pair asked them to choose between their own
   * convention and a foreign one. Manual QA produced the loop that follows:
   * the same two lines four times, and no exit.
   *
   * So the *flow* reads a date of birth day-first (`DateReadingOptions`) and
   * commits once. `normalizeSpokenDate` still returns both readings by default,
   * because matching a spoken date against the seven days a calendar actually
   * offered is a filter and wants every reading — see the test above, which is
   * unchanged.
   */
  it("commits the day-first reading once, without a second question", async () => {
    const state = frameWith("register_patient", {
      full_name: slotValue("جهاد محمد"),
      full_name_latin: slotValue("Gehad Mohamed"),
      national_id: slotValue("29001012345678"),
    });
    const result = await turn(
      [{ kind: "set_slot", slot: "date_of_birth", value: "04/03/1990" }],
      context({ flows: state }),
    );
    expect(activeFrame(result.state)?.slots.date_of_birth?.value).toBe("1990-03-04");
    // Nothing is asked *about the date*. The flow moves on, and whatever the
    // next step asks is the next step's question.
    expect(
      result.effects.some(
        (effect) => effect.kind === "offer" && effect.offer.slot === "date_of_birth",
      ),
    ).toBe(false);
    expect(askedSlot(result.effects)).not.toBe("date_of_birth");
  });

  it("refuses a two-digit year rather than guessing a century", () => {
    expect(normalizeSpokenDate("15/03/90")).toEqual({ kind: "none" });
  });

  it("refuses a date that does not exist", () => {
    expect(normalizeSpokenDate("31/02/1990")).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// G — the third-party patient path (QA defect 7)
// ---------------------------------------------------------------------------

describe("G: an existing file is found, or a new one is staged — never the sender", () => {
  const complete = () =>
    frameWith("book_appointment", {
      beneficiary: slotValue("other"),
      department: slotValue("dept-pt"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      full_name: slotValue("جهاد محمد"),
      full_name_latin: slotValue("Gehad Mohamed"),
      national_id: slotValue("29001012345678"),
      date_of_birth: slotValue("1990-03-15"),
      email: slotValue("gehad@example.com"),
      // The patient's own number and their optional blood group — both now
      // part of a third-party intake. `tools.stageIntake` refuses a staging
      // without the first, so the sender's number can never become theirs.
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });

  it("tries exact identity discovery before creating anything", async () => {
    await turn([], context({ flows: complete() }));
    expect(stubs.resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ nationalId: "29001012345678", fullName: "جهاد محمد" }),
    );
  });

  it("uses a matched existing file and stages nothing", async () => {
    stubs.resolveIdentity.mockResolvedValue({
      kind: "matched",
      patientId: "patient-gehad",
      canonicalName: "Gehad Mohamed",
      departments: [{ id: "dept-pt", name: "Physical Therapy" }],
      treatingDoctorByDepartment: {},
    });
    const result = await turn([], context({ flows: complete() }));
    expect(stubs.stageIntake).not.toHaveBeenCalled();
    // Known, not staged: nothing is pending review because nothing was opened.
    expect(activeFrame(result.state)?.memo.booking_patient_known).toBe(true);
    expect(activeFrame(result.state)?.memo.intake_staged).toBeUndefined();
  });

  it("stages a new file for the other person when discovery finds nothing", async () => {
    const result = await turn([], context({ flows: complete() }));
    expect(stubs.stageIntake).toHaveBeenCalledTimes(1);
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        forThirdParty: true,
        fullName: "Gehad Mohamed",
        fullNameOriginal: "جهاد محمد",
      }),
    );
    // Pending review is what actually happened, and what the patient is told.
    expect(composeDeterministic({ effects: result.effects, locale: "en" }).keys).toContain(
      "intake.staged_other",
    );
  });

  it("never books against the sender when the file could not be staged", async () => {
    stubs.stageIntake.mockResolvedValue({ ok: false, reason: "failed" });
    const result = await turn([], context({ flows: complete() }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(result.effects.some((effect) => effect.kind === "handoff")).toBe(true);
  });

  it("refuses to write a third-party booking with no third party behind it", async () => {
    // The guard, exercised directly: a confirmed booking for somebody else with
    // no staged file and no matched one.
    const state = frameWith(
      "book_appointment",
      {
        beneficiary: slotValue("other"),
        department: slotValue("dept-pt"),
        doctor: slotValue("doc-nabil"),
        day: slotValue("2026-09-10"),
        time: slotValue("12:15"),
      },
      {
        memo: {
          confirmed: true,
          "done:package_offer": true,
          "done:intake": true,
        },
      },
    );
    const result = await turn([], context({ flows: state }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(result.effects.some((effect) => effect.kind === "handoff")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H & I — the pending booking is written, or not claimed (QA defect 8, I-3)
// ---------------------------------------------------------------------------

describe("H/I: success is only ever claimed after the write succeeded", () => {
  const confirmable = (memo: Record<string, string | number | boolean> = {}) =>
    frameWith(
      "book_appointment",
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-pt"),
        doctor: slotValue("doc-nabil"),
        day: slotValue("2026-09-10"),
        time: slotValue("12:15"),
      },
      { memo: { "done:package_offer": true, "done:intake": true, ...memo } },
    );

  it("shows a summary and writes nothing before it is affirmed", async () => {
    const result = await turn([], context({ flows: confirmable() }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(composeDeterministic({ effects: result.effects, locale: "en" }).keys).toContain(
      "booking.review",
    );
  });

  it("writes the booking with the clinic's calendar day and time", async () => {
    const result = await turn([], context({ flows: confirmable({ confirmed: true }) }));
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
    // Not a joined naive timestamp. The clinic runs in Europe/Istanbul and the
    // test host does not; joining these two into `2026-09-10T12:15:00` is read
    // in the *server's* zone, lands hours from the slot the patient chose, and
    // fails the availability re-check — which is precisely why the QA booking
    // was never persisted.
    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-09-10", time: "12:15" }),
    );
    expect(composeDeterministic({ effects: result.effects, locale: "en" }).keys).toContain(
      "booking.created",
    );
  });

  it("does not claim a booking when the write failed", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "slot_unavailable" });
    const result = await turn([], context({ flows: confirmable({ confirmed: true }) }));
    const keys = composeDeterministic({ effects: result.effects, locale: "en" }).keys;
    expect(keys).not.toContain("booking.created");
    expect(keys).toContain("booking.slot_gone");
    expect(reply(result.effects)).not.toMatch(/recorded|pending the clinic/i);
  });

  it("a failed write clears the consent it was given under, so nothing retries silently", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "slot_unavailable" });
    const result = await turn([], context({ flows: confirmable({ confirmed: true }) }));
    const frame = activeFrame(result.state);
    expect(frame?.memo.confirmed).toBeUndefined();
    expect(frame?.slots.time).toBeUndefined();
    // The flow is still alive and the patient is offered the times that remain,
    // so a retry is a fresh decision rather than a repeat of the last one.
    expect(frame?.status).toBe("active");
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
  });

  it("I-3: no copy key asserting a mutation is reachable without its effect", () => {
    // The composer renders what the engine hands it and nothing else. A
    // success sentence with no successful effect behind it has no path here.
    const text = composeDeterministic({
      effects: [{ kind: "ask", key: "clarify.open", slot: null }],
      locale: "en",
    }).text;
    expect(text).not.toMatch(/recorded|cancelled|moved/i);
  });
});
