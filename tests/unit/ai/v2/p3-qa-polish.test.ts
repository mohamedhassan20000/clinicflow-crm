/**
 * The third manual-QA polish pass, as deterministic contracts.
 *
 * Every block names the behaviour a live WhatsApp session produced and asserts
 * the property that makes it impossible — never the sentence that happened to
 * come out. The tool layer is stubbed at the module boundary, so the flow
 * definitions, the engine, the preconditions, the normalizers and the composer
 * are all the real ones.
 *
 * The transcript these are drawn from, in order:
 *
 * ```
 *   patient:   ممكن تساعدني في ايه؟          -> greeted back, no answer      (A)
 *   patient:   لا عايز بعد التاريخ دا         -> «ما قدرتش أحدد اللي تقصده»   (C)
 *   patient:   الساعة 9وربع                  -> the same 20 times, re-shown  (E)
 *   patient:   2.4.2003                      -> two candidates              (I)
 *   patient:   1                             -> the same two candidates     (J)
 * ```
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
import { composeDeterministic } from "@/lib/ai/v2/composer";
import {
  normalizeSpokenDate,
  normalizeSpokenTime,
  parseDateLowerBound,
} from "@/lib/ai/v2/normalize";
import { detectPatientEscalation } from "@/lib/ai/patient-escalation";
import { renderPackageDetail } from "@/lib/ai/v2/present";
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

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
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

/** A booking frame far enough along that the day list is the open question. */
function bookingAt(slots: Record<string, Slot> = {}, extra: Record<string, unknown> = {}): FlowState {
  return {
    version: 1,
    stack: [
      {
        ...newFrame({ flow: "book_appointment", at: AT }),
        slots: {
          beneficiary: slotValue("other"),
          department: slotValue("dept-derma"),
          doctor: slotValue("doc-nabil"),
          ...slots,
        },
        ...extra,
      },
    ],
  };
}

function ctx(text: string, flows: FlowState = EMPTY_FLOW_STATE, locale: "ar" | "en" = "ar") {
  return context({
    flows,
    turn: { text, receivedAt: AT, locale, attachments: [] },
  });
}

// ---------------------------------------------------------------------------
// A/B — "what can you help me with?"
// ---------------------------------------------------------------------------

describe("A/B: the capability question is answered, and starts nothing", () => {
  const ARABIC = [
    "تقدر تساعدني في ايه؟",
    "ممكن تساعدني بإيه؟",
    "بتعمل ايه؟",
    "ايه اللي اقدر اسأل عنه؟",
    "ايه الحاجات الي ممكن تساعدني فيها؟",
  ];
  const ENGLISH = ["what can you help me with?", "what can I ask you?", "how can you help?"];

  it.each(ARABIC)("answers %s with the real capability list", async (text) => {
    // The command the model emitted is deliberately the *wrong* one — the
    // greeting the live session actually produced — so the assertion is that
    // the deterministic reading outranks it.
    const result = await turn([{ kind: "small_talk", talk: "greeting" }], ctx(text));
    const composed = composeDeterministic({ effects: result.effects, locale: "ar" });
    expect(composed.keys).toContain("info.capabilities");
    expect(composed.text).toContain("حجز موعد");
    expect(composed.text).toContain("الباكيدجات");
    expect(composed.text).toContain("شركات التأمين");
  });

  it.each(ENGLISH)("answers %s in English", async (text) => {
    const result = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      ctx(text, EMPTY_FLOW_STATE, "en"),
    );
    const composed = composeDeterministic({ effects: result.effects, locale: "en" });
    expect(composed.keys).toContain("info.capabilities");
    expect(composed.text).toContain("Booking an appointment");
  });

  it("does not start a booking, even though booking is on the list", async () => {
    const result = await turn(
      [
        { kind: "start_flow", flow: "book_appointment" },
        { kind: "small_talk", talk: "greeting" },
      ],
      ctx("تقدر تساعدني في ايه؟"),
    );
    expect(result.state.stack.some((frame) => frame.flow === "book_appointment")).toBe(false);
    expect(result.trace).toContain("capability_question_reconciled");
  });

  it("does not hand the thread to a person", async () => {
    const result = await turn(
      [{ kind: "request_handoff", reason: "patient_requested_human" }],
      ctx("ممكن تساعدني بإيه؟"),
    );
    expect(result.effects.some((effect) => effect.kind === "handoff")).toBe(false);
  });

  it("leaves an ordinary help request alone", async () => {
    // The discriminator is the question word. «ممكن تساعدني في حجز موعد» names
    // what it wants and must still start a booking.
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      ctx("ممكن تساعدني في حجز موعد"),
    );
    expect(result.trace).not.toContain("capability_question_reconciled");
    expect(result.state.stack.some((frame) => frame.flow === "book_appointment")).toBe(true);
  });

  it("answers it mid-booking without losing the booking", async () => {
    const state = bookingAt({ day: slotValue("2026-09-10") });
    const result = await turn([{ kind: "small_talk", talk: "greeting" }], ctx("بتعمل ايه؟", state));
    const composed = composeDeterministic({ effects: result.effects, locale: "ar" });
    expect(composed.keys).toContain("info.capabilities");
    // The booking frame survives and its own step asks its question again.
    const booking = result.state.stack.find((frame) => frame.flow === "book_appointment");
    expect(booking?.slots.day?.value).toBe("2026-09-10");
  });
});

// ---------------------------------------------------------------------------
// C/D — «بعد التاريخ ده» against the list on the screen
// ---------------------------------------------------------------------------

describe("C/D: 'after these dates' is bounded by the live offer, or by nothing", () => {
  const OFFERED = [
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-21",
  ];

  it.each([
    "لا عايز بعد التاريخ دا",
    "بعد التاريخ ده",
    "عايز بعد دول",
    "اللي بعدهم",
    "وريني اللي بعد كده",
    "مواعيد بعد التواريخ دي",
    "after these dates",
    "show me later dates",
  ])("reads %s as a bound at the latest displayed date", (text) => {
    expect(parseDateLowerBound(text, "2026-09-06", { offeredDates: OFFERED })).toEqual({
      date: "2026-09-21",
      explicit: true,
    });
  });

  it("resolves to nothing when no date offer is open", () => {
    // D — a withdrawn, answered or parked offer contributes no dates, so the
    // phrase bounds nothing rather than bounding something from the transcript.
    expect(parseDateLowerBound("بعد التاريخ ده", "2026-09-06", {})).toBeNull();
    expect(
      parseDateLowerBound("بعد التاريخ ده", "2026-09-06", { offeredDates: [] }),
    ).toBeNull();
  });

  it("never reads a bare «بعد» as a bound", () => {
    expect(parseDateLowerBound("بعد", "2026-09-06", { offeredDates: OFFERED })).toBeNull();
  });

  it("re-reads availability after the last displayed day", async () => {
    stubs.readAvailableDays.mockResolvedValueOnce({
      ok: true,
      windowStart: "2026-09-15",
      windowEnd: "2026-09-21",
      days: OFFERED.map((value) => ({ value, label: value, source: "clinic_directory" })),
    });
    const opened = await turn([], ctx("", bookingAt()));
    const offer = activeFrame(opened.state)?.offer;
    expect(offer?.slot).toBe("day");

    stubs.readAvailableDays.mockResolvedValue({
      ok: true,
      windowStart: "2026-09-22",
      windowEnd: "2026-09-28",
      days: [{ value: "2026-09-22", label: "2026-09-22", source: "clinic_directory" }],
    });
    const refined = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      ctx("لا عايز بعد التاريخ دا", opened.state),
    );
    expect(refined.trace).toContain("day_refinement_reconciled");
    const frame = activeFrame(refined.state);
    expect(frame?.slots.date_lower_bound?.value).toBe("2026-09-21");
    // The bound reached the authoritative read rather than the wording.
    expect(stubs.readAvailableDays).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "2026-09-21" }),
    );
    expect(frame?.offer?.options.map((option) => option.value)).toEqual(["2026-09-22"]);
  });

  it("does not fire when the day is already chosen", async () => {
    // A committed day makes this a correction, which has its own cascade.
    const state = bookingAt({ day: slotValue("2026-09-10") });
    const result = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      ctx("بعد التاريخ ده", state),
    );
    expect(result.trace).not.toContain("day_refinement_reconciled");
  });
});

// ---------------------------------------------------------------------------
// E — a number, and a spoken time, against the open list
// ---------------------------------------------------------------------------

describe("E: a live time offer resolves a number and a spoken time", () => {
  const TIMES = [
    "09:00", "09:15", "09:30", "09:45", "10:00",
  ].map((value) => ({ value, label: value, source: "clinic_directory" as const }));

  beforeEach(() => {
    stubs.readAvailableSlots.mockResolvedValue({ ok: true, times: TIMES });
  });

  async function openTimeOffer() {
    const state = bookingAt({ day: slotValue("2026-09-10") });
    const opened = await turn([], ctx("", state));
    expect(activeFrame(opened.state)?.offer?.slot).toBe("time");
    return opened.state;
  }

  it("resolves «3» to the third line of the time list, and not to a day", async () => {
    const flows = await openTimeOffer();
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "3" }],
      ctx("3", flows),
    );
    expect(activeFrame(result.state)?.slots.time?.value).toBe("09:30");
    expect(activeFrame(result.state)?.slots.day?.value).toBe("2026-09-10");
  });

  it("resolves a number the model sent as a bare acceptance", async () => {
    // The live defect: a twenty-option list with no primary, an `affirm_offer`,
    // and the same list re-shown. The words said which line every time.
    const flows = await openTimeOffer();
    const offer = activeFrame(flows)!.offer!;
    const result = await turn([{ kind: "affirm_offer", offerId: offer.id }], ctx("2", flows));
    expect(result.trace).toContain("offer_selection_reconciled");
    expect(activeFrame(result.state)?.slots.time?.value).toBe("09:15");
  });

  it("resolves «الساعة 9وربع» sent as a bare acceptance", async () => {
    const flows = await openTimeOffer();
    const offer = activeFrame(flows)!.offer!;
    const result = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      ctx("الساعة 9وربع", flows),
    );
    expect(activeFrame(result.state)?.slots.time?.value).toBe("09:15");
  });

  it("still asks which one for a bare yes against a list", async () => {
    // Nothing is widened: «اه» against a plain list means nothing, and asking
    // is the right answer to it.
    const flows = await openTimeOffer();
    const offer = activeFrame(flows)!.offer!;
    const result = await turn([{ kind: "affirm_offer", offerId: offer.id }], ctx("اه", flows));
    expect(result.trace).toContain("affirm_needs_choice");
    expect(activeFrame(result.state)?.slots.time).toBeUndefined();
  });

  it("selects nothing against a withdrawn offer", async () => {
    const flows = await openTimeOffer();
    const frame = activeFrame(flows)!;
    const withdrawn: FlowState = {
      version: 1,
      stack: [{ ...frame, offer: null }],
    };
    const result = await turn(
      [{ kind: "set_slot", slot: "time", value: "3" }],
      ctx("3", withdrawn),
    );
    // No index to resolve, so "3" is matched against real availability and
    // matches nothing — never the third line of a list nobody is looking at.
    expect(activeFrame(result.state)?.slots.time).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F/G — Arabic clock arithmetic
// ---------------------------------------------------------------------------

describe("F/G: Arabic times, in fractions and in Arabic-Indic digits", () => {
  const cases: readonly [string, readonly string[]][] = [
    ["تسعة", ["09:00", "21:00"]],
    ["تسعة وربع", ["09:15", "21:15"]],
    ["تسعة ونص", ["09:30", "21:30"]],
    ["عشرة إلا ربع", ["09:45", "21:45"]],
    ["الساعة تسعة وربع", ["09:15", "21:15"]],
    ["الساعة 9 ونص", ["09:30", "21:30"]],
    ["9 وربع", ["09:15", "21:15"]],
    ["٩ ونص", ["09:30", "21:30"]],
    ["الساعة واحدة وربع", ["01:15", "13:15"]],
    ["9 وربع صباحا", ["09:15"]],
    ["الساعة ٩ وربع مساءً", ["21:15"]],
    ["١٢:١٥", ["12:15", "00:15"]],
  ];

  it.each(cases)("reads %s", (spoken, expected) => {
    expect(normalizeSpokenTime(spoken)).toEqual({ kind: "times", times: expected });
  });

  it("keeps the afternoon reading of «واحدة إلا ربع»", () => {
    // Borrowing the hour before the meridiem was applied turned one o'clock
    // into midnight and lost 12:45 — the reading a clinic actually books.
    expect(normalizeSpokenTime("واحدة إلا ربع")).toEqual({
      kind: "times",
      times: ["00:45", "12:45"],
    });
  });

  it("reads nothing out of a message with no time in it", () => {
    expect(normalizeSpokenTime("تمام شكرا")).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// H/I/J — dates of birth
// ---------------------------------------------------------------------------

describe("H/I: every date format the clinic's patients write", () => {
  const cases: readonly [string, string][] = [
    ["2.4.2003", "2003-04-02"],
    ["02.04.2003", "2003-04-02"],
    ["2-4-2003", "2003-04-02"],
    ["02-04-2003", "2003-04-02"],
    ["2/4/2003", "2003-04-02"],
    ["02/04/2003", "2003-04-02"],
    ["2 April 2003", "2003-04-02"],
    ["April 2 2003", "2003-04-02"],
    ["2 Apr 2003", "2003-04-02"],
    ["2 أبريل 2003", "2003-04-02"],
    ["2 ابريل 2003", "2003-04-02"],
    ["٢ أبريل ٢٠٠٣", "2003-04-02"],
    ["٢/٤/٢٠٠٣", "2003-04-02"],
    ["2003-04-02", "2003-04-02"],
  ];

  it.each(cases)("normalizes %s to exactly one date", (spoken, expected) => {
    expect(normalizeSpokenDate(spoken, { order: "day_first" })).toEqual({
      kind: "dates",
      dates: [expected],
    });
  });

  it("falls back to month-first only when day-first is not a real date", () => {
    expect(normalizeSpokenDate("12/25/1990", { order: "day_first" })).toEqual({
      kind: "dates",
      dates: ["1990-12-25"],
    });
  });

  it("still returns both readings for offer matching", () => {
    // Unchanged, and deliberately: matching a spoken date against the seven
    // days a calendar offered is a filter and wants every reading.
    expect(normalizeSpokenDate("04/03/1990")).toEqual({
      kind: "dates",
      dates: ["1990-03-04", "1990-04-03"],
    });
  });

  it("still refuses a two-digit year and a date that does not exist", () => {
    expect(normalizeSpokenDate("15/03/90", { order: "day_first" })).toEqual({ kind: "none" });
    expect(normalizeSpokenDate("31/02/1990", { order: "day_first" })).toEqual({ kind: "none" });
  });
});

describe("J: a date of birth is accepted once and never asked for again", () => {
  const intakeReady = () =>
    bookingAt({
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      full_name: slotValue("علي الزناتي"),
      full_name_latin: slotValue("Ali Alzanaty"),
      national_id: slotValue("707030001655"),
    });

  it("commits 2.4.2003 without a second question and advances", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "date_of_birth", value: "2.4.2003" }],
      ctx("2.4.2003", intakeReady()),
    );
    expect(activeFrame(result.state)?.slots.date_of_birth?.value).toBe("2003-04-02");
    expect(
      result.effects.some(
        (effect) => effect.kind === "offer" && effect.offer.slot === "date_of_birth",
      ),
    ).toBe(false);
    expect(askedSlot(result.effects)).toBe("email");
  });

  it("does not ask for it again on the next turn", async () => {
    const born = await turn(
      [{ kind: "set_slot", slot: "date_of_birth", value: "2-4-2003" }],
      ctx("2-4-2003", intakeReady()),
    );
    const mailed = await turn(
      [{ kind: "set_slot", slot: "email", value: "ali@example.com" }],
      ctx("ali@example.com", born.state),
    );
    expect(askedSlot(mailed.effects)).not.toBe("date_of_birth");
    expect(activeFrame(mailed.state)?.slots.date_of_birth?.value).toBe("2003-04-02");
  });

  it("refuses a date of birth in the future", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "date_of_birth", value: "2.4.2030" }],
      ctx("2.4.2030", intakeReady()),
    );
    expect(activeFrame(result.state)?.slots.date_of_birth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// K/L/M/N — the bilingual name
// ---------------------------------------------------------------------------

describe("K/L/M: the Arabic name is kept, and the English one is confirmed", () => {
  const beforeName = () =>
    bookingAt({ day: slotValue("2026-09-10"), time: slotValue("12:15") });

  it("keeps the Arabic name and asks about the English spelling next", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", beforeName()),
    );
    expect(activeFrame(named.state)?.slots.full_name?.value).toBe("علي الزهراني");
    const offer = named.effects.find((effect) => effect.kind === "offer");
    expect(offer && offer.kind === "offer" ? offer.offer.slot : null).toBe("full_name_latin");
    // L — proposed, never filed. Nothing is committed by showing it.
    expect(activeFrame(named.state)?.slots.full_name_latin).toBeUndefined();
    const text = composeDeterministic({ effects: named.effects, locale: "ar" }).text;
    expect(text).toContain("علي الزهراني");
  });

  it("accepts the proposal on a bare yes", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", beforeName()),
    );
    const offer = activeFrame(named.state)!.offer!;
    const accepted = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      ctx("اه", named.state),
    );
    expect(activeFrame(accepted.state)?.slots.full_name_latin?.value).toBe(
      offer.options[0]!.value,
    );
    expect(askedSlot(accepted.effects)).toBe("national_id");
  });

  it("takes a corrected spelling out of «لا خليه Ali Al Zahrani» and advances", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", beforeName()),
    );
    const corrected = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "لا خليه Ali Al Zahrani" }],
      ctx("لا خليه Ali Al Zahrani", named.state),
    );
    // M — the Latin part alone. «لا خليه» must never reach an English name
    // column on a medical file.
    expect(activeFrame(corrected.state)?.slots.full_name_latin?.value).toBe("Ali Al Zahrani");
    expect(askedSlot(corrected.effects)).toBe("national_id");
  });

  it("takes a bare English spelling as the answer to the open question", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", beforeName()),
    );
    const corrected = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "Ali Al Zahrani" }],
      ctx("Ali Al Zahrani", named.state),
    );
    expect(activeFrame(corrected.state)?.slots.full_name_latin?.value).toBe("Ali Al Zahrani");
  });

  it("files a name the patient wrote in English without asking", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "Ali Alzahrani" }],
      ctx("Ali Alzahrani", beforeName()),
    );
    expect(activeFrame(named.state)?.slots.full_name_latin?.value).toBe("Ali Alzahrani");
    expect(askedSlot(named.effects)).toBe("national_id");
  });

  it("re-asks rather than filing a refusal as a name", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", beforeName()),
    );
    const refused = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "مش عارف" }],
      ctx("مش عارف", named.state),
    );
    expect(activeFrame(refused.state)?.slots.full_name_latin).toBeUndefined();
  });

  it("carries both names to the staging call, canonical unchanged", async () => {
    const ready = bookingAt({
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      full_name: slotValue("علي الزهراني"),
      full_name_latin: slotValue("Ali Al Zahrani"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("2003-04-02"),
      email: slotValue("ali@example.com"),
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });
    await turn([], ctx("", ready));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: "Ali Al Zahrani",
        fullNameOriginal: "علي الزهراني",
        fullNameAr: "علي الزهراني",
        fullNameEn: "Ali Al Zahrani",
      }),
    );
  });

  it("files no Arabic display name for a patient who wrote English", async () => {
    const ready = bookingAt({
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      full_name: slotValue("Ali Alzahrani"),
      full_name_latin: slotValue("Ali Alzahrani"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("2003-04-02"),
      email: slotValue("ali@example.com"),
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });
    await turn([], ctx("", ready));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ fullNameAr: null, fullNameEn: "Ali Alzahrani" }),
    );
  });
});

describe("N: a bilingual name is not identity", () => {
  it("still proves a file by exact national id and canonical name", async () => {
    const ready = bookingAt({
      day: slotValue("2026-09-10"),
      time: slotValue("12:15"),
      full_name: slotValue("علي الزهراني"),
      full_name_latin: slotValue("Ali Al Zahrani"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("2003-04-02"),
      email: slotValue("ali@example.com"),
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });
    await turn([], ctx("", ready));
    // Discovery is the id plus the canonical name, and the two display names
    // are not arguments to it. Nothing about them can match or fail to match.
    expect(stubs.resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        nationalId: "707030001655",
        fullName: "علي الزهراني",
      }),
    );
    const call = stubs.resolveIdentity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.fullNameAr).toBeUndefined();
    expect(call.fullNameEn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V/W — human handoff, unchanged in both directions
// ---------------------------------------------------------------------------

describe("V/W: escalation still fires for a person, and never for a beneficiary", () => {
  it.each([
    "عايز أكلم موظف",
    "عايز اتكلم مع شخص",
    "وصلني بحد",
    "محتاج أكلم حد من العيادة",
    "I want to speak to a human",
  ])("hands off on %s", (text) => {
    const detected = detectPatientEscalation(text, {
      clinicDepartmentNames: ["الجلدية", "العلاج الطبيعي"],
    });
    expect(detected.escalate).toBe(true);
    expect(detected.reason).toBe("human_requested");
  });

  it.each([
    "عايز أحجز لحد تاني",
    "لشخص تاني",
    "عايز أعمل ملف لشخص تاني",
    "عايز اسجل بيانات شخص تاني",
    "ممكن لحد تاني",
  ])("does not hand off on %s", (text) => {
    const detected = detectPatientEscalation(text, {
      clinicDepartmentNames: ["الجلدية", "العلاج الطبيعي"],
    });
    expect(detected.escalate).toBe(false);
  });

  it("does not hand off on the capability question", () => {
    for (const text of ["تقدر تساعدني في ايه؟", "what can you help me with?"]) {
      expect(detectPatientEscalation(text).escalate).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The services a package contains, in the patient's answer
// ---------------------------------------------------------------------------

describe("a package states its own stored lines and totals, and nothing else", () => {
  const base = {
    name: "باكيدج التأهيل",
    departmentName: "العلاج الطبيعي",
    totalSessions: 10,
    pricePerSession: 90,
    totalPrice: 900,
    notes: null as string | null,
  };
  const rehab = {
    serviceName: "جلسة إعادة تأهيل",
    sessions: 5,
    pricePerSession: 1300,
    subtotal: 6500,
  };
  const sports = {
    serviceName: "علاج الإصابات الرياضية",
    sessions: 3,
    pricePerSession: 1800,
    subtotal: 5400,
  };

  it("renders a multi-service package as one line per service, then the total", () => {
    const text = renderPackageDetail(
      { ...base, items: [rehab, sports] },
      "TRY",
      "ar",
    );
    expect(text).toContain("باكيدج التأهيل:");
    expect(text).toContain("- جلسة إعادة تأهيل — 5 جلسات — 1300 TRY للجلسة");
    expect(text).toContain("- علاج الإصابات الرياضية — 3 جلسات — 1800 TRY للجلسة");
    // 5 × 1300 + 3 × 1800 = 11900, summed from the lines the patient just read.
    expect(text).toContain("إجمالي الباكيدج: 11900 TRY");
  });

  it("keeps the clinic's own line order", () => {
    const text = renderPackageDetail({ ...base, items: [sports, rehab] }, "TRY", "ar");
    expect(text.indexOf("علاج الإصابات الرياضية")).toBeLessThan(
      text.indexOf("جلسة إعادة تأهيل"),
    );
  });

  it("totals from the lines, never from the header's stored total", () => {
    // The header says 900. The lines say 11900. A patient who has just read
    // per-line prices must be given the total of those prices.
    const text = renderPackageDetail(
      { ...base, totalPrice: 900, items: [rehab, sports] },
      "TRY",
      "ar",
    );
    expect(text).toContain("11900");
    expect(text).not.toContain("السعر: 900 TRY");
  });

  it("renders a single-service package as exactly one line", () => {
    const text = renderPackageDetail({ ...base, items: [rehab] }, "TRY", "ar");
    expect(text.match(/^- /gm) ?? []).toHaveLength(1);
    expect(text).toContain("- جلسة إعادة تأهيل — 5 جلسات — 1300 TRY للجلسة");
    expect(text).toContain("إجمالي الباكيدج: 6500 TRY");
  });

  it("says «جلسة» rather than «جلسات» for a single session", () => {
    const text = renderPackageDetail(
      { ...base, items: [{ ...rehab, sessions: 1, subtotal: 1300 }] },
      "TRY",
      "ar",
    );
    expect(text).toContain("1 جلسة");
    expect(text).not.toContain("1 جلسات");
  });

  it("never states a discount or a saving", () => {
    const text = renderPackageDetail(
      { ...base, items: [rehab, sports] },
      "TRY",
      "ar",
    );
    expect(text).not.toMatch(/وفر|خصم|discount|save/i);
  });

  it("renders a legacy department-only package exactly as before", () => {
    const noItemsKey = renderPackageDetail(base, "TRY", "ar");
    const emptyItems = renderPackageDetail({ ...base, items: [] }, "TRY", "ar");
    expect(emptyItems).toBe(noItemsKey);
    expect(noItemsKey).toContain("عدد الجلسات: 10");
    expect(noItemsKey).toContain("السعر: 900 TRY");
    expect(noItemsKey).toContain("سعر الجلسة: 90 TRY");
    // No lines, and therefore no line-derived total to state.
    expect(noItemsKey).not.toContain("إجمالي الباكيدج");
    expect(noItemsKey).not.toMatch(/^- /m);
  });

  it("drops a line with an unusable session count rather than quoting it", () => {
    const text = renderPackageDetail(
      { ...base, items: [rehab, { ...sports, sessions: 0, subtotal: 0 }] },
      "TRY",
      "ar",
    );
    expect(text).not.toContain("علاج الإصابات الرياضية");
    expect(text).toContain("إجمالي الباكيدج: 6500 TRY");
  });

  it("renders the English shape with the same numbers", () => {
    const text = renderPackageDetail(
      { ...base, items: [rehab, sports] },
      "TRY",
      "en",
    );
    expect(text).toContain("5 sessions");
    expect(text).toContain("1300 TRY per session");
    expect(text).toContain("Package total: 11900 TRY");
  });

  it("omits the currency when the clinic has none configured", () => {
    const text = renderPackageDetail({ ...base, items: [rehab] }, null, "ar");
    expect(text).toContain("1300 للجلسة");
    expect(text).toContain("إجمالي الباكيدج: 6500");
  });
});
