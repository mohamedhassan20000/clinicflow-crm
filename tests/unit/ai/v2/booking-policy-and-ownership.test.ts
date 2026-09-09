/**
 * The consolidated QA pass: booking policy, availability truth, data ownership
 * and the shape of what the patient reads.
 *
 * Every describe below is one defect from the manual Arabic session, stated as
 * a property rather than as a transcript:
 *
 *   * **Lead time.** Today and tomorrow are not sellable online. A patient who
 *     asks for tomorrow is told so and given the clinic's number, rather than
 *     being told their Arabic was unclear.
 *   * **Refinement.** «بعد يوم 11» and «بعد الجمعة» move the search window
 *     forward, in the same booking, without touching the beneficiary, the
 *     department or the doctor.
 *   * **Availability.** The assistant claims a conflict only when the write
 *     genuinely reported one. A pending request of the patient's own is not a
 *     conflict, and reporting it as one is what built the QA loop: the
 *     re-offer listed the same free slot, the patient picked it, and the turn
 *     repeated.
 *   * **Ownership.** A booking for somebody else asks for *their* phone
 *     number, offers an optional blood group, and never lets the sender's
 *     WhatsApp number become the patient's.
 *   * **Presentation.** One field per line in the summary, one option per line
 *     in every list, services grouped under their department with the price on
 *     the same line, and no separator rules anywhere.
 *   * **Continuity.** A few minutes of silence is not a reset.
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
  readClinicInsurance: vi.fn(),
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
import { composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import {
  EMPTY_FLOW_STATE,
  activeFrame,
  newFrame,
  type FlowState,
  type Slot,
} from "@/lib/ai/v2/flow-state";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import {
  doctorDisplayName,
  formatOfferedDay,
  formatOfferedTime,
  localizedName,
  renderServiceGroups,
  renderSummary,
} from "@/lib/ai/v2/present";
import {
  parseDateLowerBound,
  relativeDayFromSpoken,
} from "@/lib/ai/v2/normalize";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import { toDoctorOption } from "@/lib/ai/doctor-directory";

const CLINIC_PHONE = "+90 212 555 0100";

// Thursday 2026-09-05, 09:00 UTC. Cairo is UTC+3 in September, so the clinic's
// today is the 5th and the first bookable day is the 7th.
const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();
const TODAY = "2026-09-05";
const TOMORROW = "2026-09-06";
const FIRST_BOOKABLE = "2026-09-07";

const DEPARTMENTS = [
  { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const },
  { value: "dept-cardio", label: "القلب", source: "clinic_directory" as const },
  { value: "dept-physio", label: "العلاج الطبيعي", source: "clinic_directory" as const },
];
const HANEEN = { id: "doc-haneen", name: "Haneen Samir", nameAr: "حنين سمير" };
const YOUSSEF = { id: "doc-youssef", name: "Youssef Adel", nameAr: "يوسف عادل" };

/** Mon 7 Sep to Fri 11 Sep — the window the QA session was shown. */
const DAYS = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
const LATER = ["2026-09-14", "2026-09-15", "2026-09-16"];

const CATALOG = {
  currency: "TRY",
  total: 7,
  groups: [
    {
      departmentId: "dept-derma",
      departmentName: "الجلدية",
      services: [
        { id: "s1", name: "علاج حب الشباب", price: 2500 },
        { id: "s2", name: "التقشير الكيميائي", price: 2000 },
        { id: "s3", name: "إزالة الشعر بالليزر", price: 3800 },
      ],
    },
    {
      departmentId: "dept-cardio",
      departmentName: "القلب",
      services: [
        { id: "s4", name: "استشارة قلب", price: 1500 },
        { id: "s5", name: "رسم قلب ECG", price: 900 },
      ],
    },
    {
      departmentId: "dept-physio",
      departmentName: "العلاج الطبيعي",
      services: [
        { id: "s6", name: "تقييم علاج طبيعي", price: 1000 },
        { id: "s7", name: "جلسة إعادة تأهيل", price: 1600 },
      ],
    },
  ],
};

function dayCandidates(dates: readonly string[]) {
  return dates.map((date) => ({
    value: date,
    label: formatOfferedDay(date, "ar"),
    source: "clinic_directory" as const,
  }));
}

/** The same days, as options on a live offer — which carry a server-minted id. */
function dayOptions(dates: readonly string[]) {
  return dayCandidates(dates).map((day, index) => ({
    ...day,
    id: `opt_${index + 1}`,
  }));
}

function timeCandidates(times: readonly string[]) {
  return times.map((time) => ({
    value: time,
    label: formatOfferedTime(time, "ar", "12h"),
    source: "clinic_directory" as const,
  }));
}

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
      canonicalName: async () => "أنس طلال",
    },
    history: { search: async () => [] },
    identity: "linked",
    patientId: "patient-sender",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "12h",
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

function said(text: string, overrides: Partial<TurnContext> = {}): TurnContext {
  return context({
    turn: { text, receivedAt: AT, locale: "ar", attachments: [] },
    ...overrides,
  });
}

function slotValue(value: string, label?: string): Slot {
  return { value, ...(label ? { label } : {}), provenance: "spoken", at: AT };
}

function bookingFrame(
  slots: Record<string, Slot>,
  extra: Partial<ReturnType<typeof newFrame>> = {},
): FlowState {
  return {
    version: 1,
    stack: [{ ...newFrame({ flow: "book_appointment", at: AT }), slots, ...extra }],
  };
}

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

function keys(effects: readonly Effect[]) {
  return composeDeterministic({ effects, locale: "ar" }).keys;
}

/** A frame that is fully built and waiting for the summary to be confirmed. */
const confirmedFrame = (extra: Record<string, Slot> = {}) =>
  bookingFrame(
    {
      beneficiary: slotValue("self"),
      department: slotValue("dept-physio", "العلاج الطبيعي"),
      doctor: slotValue("doc-youssef", "د. يوسف عادل"),
      day: slotValue("2026-09-09", "الأربعاء — 09-09-2026"),
      time: slotValue("10:30", "10:30 صباحًا"),
      ...extra,
    },
    { memo: { confirmed: true, package_declined: true } },
  );

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue(DEPARTMENTS);
  stubs.readDoctors.mockResolvedValue(
    [HANEEN, YOUSSEF].map((doctor) => ({
      value: doctor.id,
      label: doctorDisplayName(doctor, "ar"),
      source: "clinic_directory" as const,
    })),
  );
  stubs.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    days: dayCandidates(DAYS),
    windowStart: DAYS[0],
    windowEnd: DAYS[4],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: timeCandidates(["09:00", "09:15", "09:30"]),
  });
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readPublicPackages.mockResolvedValue({ groups: [], all: [], currency: null, total: 0 });
  stubs.readServices.mockResolvedValue(CATALOG);
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.readClinicInsurance.mockResolvedValue([]);
  stubs.readClinicFaq.mockResolvedValue([]);
  stubs.readClinicInfo.mockResolvedValue({
    name: "Clinic",
    address: "Bağcılar Mahallesi, Atatürk Caddesi No:42, 34200 İstanbul",
    phone: CLINIC_PHONE,
  });
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
});

// ===========================================================================
// A — the lead-time rule, as the patient experiences it
// ===========================================================================

describe("booking policy: today and tomorrow are not sold online", () => {
  const dayStep = () =>
    bookingFrame({
      beneficiary: slotValue("self"),
      department: slotValue("dept-physio"),
      doctor: slotValue("doc-youssef"),
    });

  it("offers no day earlier than the day after tomorrow", async () => {
    const result = await turn([], context({ flows: dayStep() }));
    const offer = result.effects.find((effect) => effect.kind === "offer");
    const values =
      offer && offer.kind === "offer" ? offer.offer.options.map((o) => String(o.value)) : [];
    expect(values.length).toBeGreaterThan(0);
    expect(values).not.toContain(TODAY);
    expect(values).not.toContain(TOMORROW);
    expect(values.every((value) => value >= FIRST_BOOKABLE)).toBe(true);
  });

  it("asks the calendar for a window that starts at the floor", async () => {
    await turn([], context({ flows: dayStep() }));
    // The read itself is bound to the rule (see the lead-time wiring tests);
    // what this pins is that the step does not pass a start of its own that
    // could undercut it.
    expect(stubs.readAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: "doc-youssef", after: null }),
    );
  });

  it("answers «عايز بكرة» with the policy and the clinic's real number", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "عايز موعد بكرة" }],
      said("عايز موعد بكرة", { flows: dayStep() }),
    );
    expect(keys(result.effects)).toContain("booking.lead_time");
    const text = reply(result.effects);
    expect(text).toContain(CLINIC_PHONE);
    // Not a clarification. The words were understood perfectly well.
    expect(keys(result.effects)).not.toContain("clarify.value_not_recognised");
    // And nothing was committed.
    expect(activeFrame(result.state)?.slots.day).toBeUndefined();
  });

  it("gives the same answer to a directly typed too-soon date", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "06-09-2026" }],
      said("06-09-2026", { flows: dayStep() }),
    );
    expect(keys(result.effects)).toContain("booking.lead_time");
    expect(activeFrame(result.state)?.slots.day).toBeUndefined();
  });

  it("falls back to the clinic team when no phone number is configured", async () => {
    stubs.readClinicInfo.mockResolvedValue({ name: "Clinic", address: null, phone: null });
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "بكرة" }],
      said("بكرة", { flows: dayStep() }),
    );
    // A number is never invented to fill the template.
    expect(keys(result.effects)).toContain("booking.lead_time_no_phone");
    expect(reply(result.effects)).not.toMatch(/\+?\d{3}/);
  });

  it("does not treat an ordinary day answer as a policy question", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "day", value: "الاربع" }],
      said("الاربع", { flows: dayStep() }),
    );
    expect(keys(result.effects)).not.toContain("booking.lead_time");
    expect(activeFrame(result.state)?.slots.day?.value).toBe("2026-09-09");
  });

  it("re-checks the rule at the write and moves the day, not the time", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "lead_time" });
    const result = await turn([], context({ flows: confirmedFrame() }));
    expect(keys(result.effects)).toContain("booking.lead_time");
    const frame = activeFrame(result.state);
    // Offering a different *time* on a day that is too soon cannot help, so
    // the day goes with it and the consent goes with both.
    expect(frame?.slots.day).toBeUndefined();
    expect(frame?.slots.time).toBeUndefined();
    expect(frame?.memo.confirmed).toBeUndefined();
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
  });

  it("reads the relative-day lexicon in both languages, compound first", () => {
    expect(relativeDayFromSpoken("عايز موعد بكرة")).toBe("tomorrow");
    expect(relativeDayFromSpoken("بكره")).toBe("tomorrow");
    expect(relativeDayFromSpoken("غدًا")).toBe("tomorrow");
    expect(relativeDayFromSpoken("tomorrow please")).toBe("tomorrow");
    expect(relativeDayFromSpoken("بعد بكرة")).toBe("day_after_tomorrow");
    expect(relativeDayFromSpoken("النهاردة")).toBe("today");
    expect(relativeDayFromSpoken("الاثنين")).toBeNull();
  });
});

// ===========================================================================
// B — a refinement moves the window
// ===========================================================================

describe("date refinement: «بعد يوم 11» searches after the eleventh", () => {
  const offeredDays = () =>
    bookingFrame(
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-physio", "العلاج الطبيعي"),
        doctor: slotValue("doc-youssef", "د. يوسف عادل"),
      },
      {
        offer: {
          id: "offer_abcd1234",
          flow: "book_appointment" as const,
          kind: "slot_value" as const,
          slot: "day" as const,
          options: dayOptions(DAYS),
          primaryOptionId: null,
          at: AT,
        },
      },
    );

  it("parses a lower bound from a day number, a weekday and a week", () => {
    expect(parseDateLowerBound("بعد يوم 11", TODAY)).toEqual({
      date: "2026-09-11",
      explicit: true,
    });
    expect(parseDateLowerBound("بعد 11", TODAY)).toEqual({
      date: "2026-09-11",
      explicit: true,
    });
    // The Friday of the week the patient is looking at.
    expect(parseDateLowerBound("بعد الجمعة", TODAY)).toEqual({
      date: "2026-09-11",
      explicit: true,
    });
    expect(parseDateLowerBound("الأسبوع اللي بعده", TODAY)?.explicit).toBe(true);
    expect(parseDateLowerBound("بعد الأسبوع ده", TODAY)?.explicit).toBe(true);
    // No marker, no bound: an ordinary day answer is not a refinement.
    expect(parseDateLowerBound("يوم 11", TODAY)).toBeNull();
    expect(parseDateLowerBound("الجمعة", TODAY)).toBeNull();
  });

  it("re-queries strictly after the bound instead of repeating the week", async () => {
    stubs.readAvailableDays.mockResolvedValueOnce({
      ok: true,
      days: dayCandidates(LATER),
      windowStart: LATER[0],
      windowEnd: LATER[2],
    });
    const result = await turn([], said("ايه الايام المتاحة بعد يوم 11", {
      flows: offeredDays(),
    }));
    expect(stubs.readAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ after: "2026-09-11" }),
    );
    const offer = result.effects.find((effect) => effect.kind === "offer");
    const values =
      offer && offer.kind === "offer" ? offer.offer.options.map((o) => String(o.value)) : [];
    expect(values).toEqual(LATER);
    // None of the days the patient just ruled out comes back.
    for (const day of DAYS) expect(values).not.toContain(day);
  });

  it("moves past the Friday when the patient names the weekday", async () => {
    await turn([], said("ايه الايام بعد يوم الجمعة", { flows: offeredDays() }));
    expect(stubs.readAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ after: "2026-09-11" }),
    );
  });

  it("keeps the beneficiary, the department, the doctor and the frame", async () => {
    const result = await turn([], said("بعد يوم 11", { flows: offeredDays() }));
    const frame = activeFrame(result.state);
    expect(frame?.flow).toBe("book_appointment");
    expect(frame?.slots.beneficiary?.value).toBe("self");
    expect(frame?.slots.department?.value).toBe("dept-physio");
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
    expect(frame?.slots.date_lower_bound?.value).toBe("2026-09-11");
    // Not a new booking, and not an identity challenge.
    expect(result.state.stack).toHaveLength(1);
    expect(keys(result.effects)).not.toContain("identity.required");
  });
});

// ===========================================================================
// C — the assistant claims a conflict only when there is one
// ===========================================================================

describe("availability: a conflict is reported only when the write reports one", () => {
  it("reaches the confirmation and the write on a genuinely free slot", async () => {
    const result = await turn([], context({ flows: confirmedFrame() }));
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
    expect(keys(result.effects)).toContain("booking.created");
  });

  it("does not conflict with the conversation's own pending request", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "already_pending" });
    const result = await turn([], context({ flows: confirmedFrame() }));
    // The idempotent answer: the request is already in. Not "that slot was
    // taken", which is false, and which sent the patient back to a list still
    // containing the very slot they had chosen.
    expect(keys(result.effects)).toContain("booking.already_requested");
    expect(keys(result.effects)).not.toContain("booking.slot_gone");
    expect(reply(result.effects)).not.toContain("اتحجز");
  });

  it("cannot loop: a repeated confirmation neither re-offers nor re-writes", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "already_pending" });
    const first = await turn([], context({ flows: confirmedFrame() }));
    const second = await turn(
      [],
      context({ flows: first.state, turn: { text: "اه", receivedAt: AT, locale: "ar", attachments: [] } }),
    );
    // The flow completed, so nothing offers the same time back a second time.
    expect(
      second.effects.some(
        (effect) => effect.kind === "offer" && effect.key === "booking.choose_time",
      ),
    ).toBe(false);
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
  });

  it("says it once and offers fresh times when the slot is genuinely taken", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "slot_taken" });
    stubs.readAvailableSlots.mockResolvedValue({
      ok: true,
      times: timeCandidates(["11:00", "11:30"]),
    });
    const result = await turn([], context({ flows: confirmedFrame() }));
    expect(keys(result.effects)).toContain("booking.slot_gone");
    const frame = activeFrame(result.state);
    // The day and the doctor survive; the time and the consent do not.
    expect(frame?.slots.day?.value).toBe("2026-09-09");
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
    expect(frame?.slots.time).toBeUndefined();
    expect(frame?.memo.confirmed).toBeUndefined();
    // And the times offered are the fresh ones, not the rejected one.
    const text = reply(result.effects);
    expect(text).toContain("11:00");
    expect(text).not.toContain("10:30");
  });

  it("never offers the refused time back, even while the calendar still shows it", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "slot_taken" });
    // The calendar still lists 10:30: a pending request somebody else holds is
    // invisible to `computeAvailability` while the write refuses on it. Without
    // the negative constraint this is an infinite loop.
    stubs.readAvailableSlots.mockResolvedValue({
      ok: true,
      times: timeCandidates(["10:30", "11:00"]),
    });
    const result = await turn([], context({ flows: confirmedFrame() }));
    expect(activeFrame(result.state)?.rejected.time).toContain("10:30");
    const text = reply(result.effects);
    expect(text).toContain("11:00");
    expect(text).not.toContain("10:30");
  });

  it("hands over rather than blaming the calendar when the write simply failed", async () => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "failed" });
    const result = await turn([], context({ flows: confirmedFrame() }));
    expect(result.effects.some((effect) => effect.kind === "handoff")).toBe(true);
    expect(keys(result.effects)).not.toContain("booking.slot_gone");
  });
});

// ===========================================================================
// D — third-party data ownership
// ===========================================================================

describe("third-party booking: the patient's details are the patient's", () => {
  const midIntake = (slots: Record<string, Slot> = {}) =>
    bookingFrame({
      beneficiary: slotValue("other"),
      department: slotValue("dept-physio", "العلاج الطبيعي"),
      doctor: slotValue("doc-youssef", "د. يوسف عادل"),
      day: slotValue("2026-09-09", "الأربعاء — 09-09-2026"),
      time: slotValue("10:30", "10:30 صباحًا"),
      ...slots,
    });

  const identified = {
    full_name: slotValue("أحمد محمد علي"),
    full_name_latin: slotValue("Ahmed Mohamed Ali"),
    national_id: slotValue("29001012345678"),
    date_of_birth: slotValue("1990-03-15"),
    email: slotValue("ahmed@example.com"),
  };

  it("asks for the patient's own phone number after the required fields", async () => {
    const result = await turn([], context({ flows: midIntake(identified) }));
    const ask = result.effects.find((effect) => effect.kind === "ask");
    expect(ask && ask.kind === "ask" ? ask.slot : null).toBe("phone");
    expect(reply(result.effects)).toContain("رقم تليفون المريض");
    // Nothing was staged with a phone nobody gave.
    expect(stubs.stageIntake).not.toHaveBeenCalled();
  });

  it("offers blood type as optional, and accepts a skip", async () => {
    const withPhone = midIntake({ ...identified, phone: slotValue("+201002003040") });
    const asked = await turn([], context({ flows: withPhone }));
    const ask = asked.effects.find((effect) => effect.kind === "ask");
    expect(ask && ask.kind === "ask" ? ask.slot : null).toBe("blood_type");
    const text = reply(asked.effects);
    expect(text).toContain("اختيارية");

    for (const spoken of ["مش عارف", "تخطي", "skip", "مش فاكر"]) {
      const skipped = await turn(
        [{ kind: "set_slot", slot: "blood_type", value: spoken }],
        context({ flows: withPhone }),
      );
      // Recorded as unknown and the flow moves on — never re-asked, never
      // blocking the booking.
      expect(activeFrame(skipped.state)?.slots.blood_type?.value, spoken).toBe("unknown");
    }
  });

  it("records a blood group the patient does give", async () => {
    const withPhone = midIntake({ ...identified, phone: slotValue("+201002003040") });
    const answered = await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "O+" }],
      context({ flows: withPhone }),
    );
    expect(activeFrame(answered.state)?.slots.blood_type?.value).toBe("O+");
  });

  it("stages the patient's own number, and never the sender's", async () => {
    const complete = midIntake({
      ...identified,
      phone: slotValue("+201002003040"),
      blood_type: slotValue("O+"),
    });
    await turn([], context({ flows: complete }));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        forThirdParty: true,
        // The confirmed Latin spelling is canonical and the Arabic the patient
        // typed travels beside it (P10), now on the booking path too.
        fullName: "Ahmed Mohamed Ali",
        fullNameOriginal: "أحمد محمد علي",
        phone: "+201002003040",
        bloodType: "O+",
      }),
    );
  });

  it("drops an unknown blood group at the write rather than storing a placeholder", async () => {
    const complete = midIntake({
      ...identified,
      phone: slotValue("+201002003040"),
      blood_type: slotValue("unknown"),
    });
    await turn([], context({ flows: complete }));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ bloodType: null, phone: "+201002003040" }),
    );
  });

  it("keeps the sender's identity separate from the patient's", async () => {
    const complete = midIntake({
      ...identified,
      phone: slotValue("+201002003040"),
      blood_type: slotValue("unknown"),
    });
    const result = await turn([], context({ flows: complete }));
    // The staging call names the third party, and the summary that follows
    // names them too — not «أنس طلال», the linked sender.
    const staged = stubs.stageIntake.mock.calls[0]?.[0] as {
      fullName: string;
      fullNameOriginal: string | null;
    };
    expect(staged.fullName).toBe("Ahmed Mohamed Ali");
    expect(staged.fullNameOriginal).toBe("أحمد محمد علي");
    expect(activeFrame(result.state)?.slots.beneficiary?.value).toBe("other");
  });

  it("names the beneficiary in the summary, not the sender", async () => {
    const ready = bookingFrame(
      {
        beneficiary: slotValue("other"),
        department: slotValue("dept-physio", "العلاج الطبيعي"),
        doctor: slotValue("doc-youssef", "د. يوسف عادل"),
        day: slotValue("2026-09-09", "الأربعاء — 09-09-2026"),
        time: slotValue("10:30", "10:30 صباحًا"),
        full_name: slotValue("أحمد محمد علي"),
        full_name_latin: slotValue("Ahmed Mohamed Ali"),
      },
      { memo: { intake_staged: true, package_declined: true } },
    );
    const result = await turn([], context({ flows: ready }));
    const text = reply(result.effects);
    expect(text).toContain("المريض: أحمد محمد علي");
    expect(text).not.toContain("أنس طلال");
  });

  it("leaves a self-booking's summary naming the patient on file", async () => {
    const ready = bookingFrame(
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-physio", "العلاج الطبيعي"),
        doctor: slotValue("doc-youssef", "د. يوسف عادل"),
        day: slotValue("2026-09-09", "الأربعاء — 09-09-2026"),
        time: slotValue("10:30", "10:30 صباحًا"),
      },
      { memo: { package_declined: true } },
    );
    const result = await turn([], context({ flows: ready }));
    expect(reply(result.effects)).toContain("المريض: أنس طلال");
  });
});

// ===========================================================================
// E — the confirmation, and every other thing the patient reads
// ===========================================================================

describe("presentation", () => {
  const ready = () =>
    bookingFrame(
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-physio", "العلاج الطبيعي"),
        doctor: slotValue("doc-youssef", "د. يوسف عادل"),
        day: slotValue("2026-09-09", "الأربعاء — 09-09-2026"),
        time: slotValue("10:30", "10:30 صباحًا"),
      },
      { memo: { package_declined: true } },
    );

  it("puts one field on each line and asks «تحب تأكد الطلب؟»", async () => {
    const result = await turn([], context({ flows: ready() }));
    const text = reply(result.effects);
    expect(text).toContain("راجع تفاصيل طلب الحجز:");
    expect(text).toContain("المريض: أنس طلال");
    expect(text).toContain("القسم: العلاج الطبيعي");
    expect(text).toContain("الدكتور: د. يوسف عادل");
    expect(text).toContain("اليوم: الأربعاء — 09-09-2026");
    expect(text).toContain("الوقت: 10:30 صباحًا");
    expect(text).toContain("تحب تأكد الطلب؟");
    expect(text).not.toContain("أأكد الطلب؟");
    // Each field on its own line, never crammed together.
    expect(text).not.toMatch(/القسم:.*الدكتور:/);
  });

  it("draws no separator rules and repeats no field", async () => {
    const result = await turn([], context({ flows: ready() }));
    const text = reply(result.effects);
    expect(text).not.toMatch(/-{3,}|={3,}|\*{3,}|_{3,}/);
    expect(text.split("\n").filter((line) => line.startsWith("الدكتور:"))).toHaveLength(1);
  });

  it("shows no internal id or canonical enum", async () => {
    const result = await turn([], context({ flows: ready() }));
    const text = reply(result.effects);
    for (const leak of ["dept-physio", "doc-youssef", "2026-09-09T", "self", "other"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("omits a field the booking has no value for rather than labelling a blank", () => {
    const rendered = renderSummary(
      { patient: "أحمد محمد علي", doctor: "د. يوسف عادل", service: null, price: "  " },
      "ar",
    );
    expect(rendered).toBe("المريض: أحمد محمد علي\nالدكتور: د. يوسف عادل");
  });

  it("carries the service and its price when the booking selected one", () => {
    const rendered = renderSummary(
      {
        patient: "أحمد محمد علي",
        department: "العلاج الطبيعي",
        doctor: "د. يوسف عادل",
        day: "الأربعاء — 09-09-2026",
        time: "10:30 صباحًا",
        service: "جلسة إعادة تأهيل",
        price: "1600 TRY",
      },
      "ar",
    );
    expect(rendered.split("\n")).toEqual([
      "المريض: أحمد محمد علي",
      "القسم: العلاج الطبيعي",
      "الدكتور: د. يوسف عادل",
      "اليوم: الأربعاء — 09-09-2026",
      "الوقت: 10:30 صباحًا",
      "الخدمة: جلسة إعادة تأهيل",
      "السعر: 1600 TRY",
    ]);
  });

  it("numbers departments, doctors, days and times one per line", async () => {
    const numbered = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+-\s/.test(line));

    const departments = await turn(
      [],
      context({ flows: bookingFrame({ beneficiary: slotValue("self") }) }),
    );
    expect(numbered(reply(departments.effects))).toEqual([
      "1- الجلدية",
      "2- القلب",
      "3- العلاج الطبيعي",
    ]);

    const doctors = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-physio"),
        }),
      }),
    );
    expect(numbered(reply(doctors.effects))).toEqual([
      "1- د. حنين سمير",
      "2- د. يوسف عادل",
    ]);

    const days = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-physio"),
          doctor: slotValue("doc-youssef"),
        }),
      }),
    );
    expect(numbered(reply(days.effects))).toEqual([
      "1- الاثنين — 07-09-2026",
      "2- الثلاثاء — 08-09-2026",
      "3- الأربعاء — 09-09-2026",
      "4- الخميس — 10-09-2026",
      "5- الجمعة — 11-09-2026",
    ]);

    const times = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-physio"),
          doctor: slotValue("doc-youssef"),
          day: slotValue("2026-09-09"),
        }),
      }),
    );
    expect(numbered(reply(times.effects))).toEqual([
      "1- 9:00 صباحًا",
      "2- 9:15 صباحًا",
      "3- 9:30 صباحًا",
    ]);
  });

  it("groups services under their department, price on the service's own line", async () => {
    const result = await turn(
      [{ kind: "answer_question", topic: "services" }],
      context(),
    );
    const text = reply(result.effects);
    expect(text).toContain("الجلدية:\n- علاج حب الشباب — 2500 TRY");
    expect(text).toContain("القلب:\n- استشارة قلب — 1500 TRY");
    // A blank line between departments, and nothing comma-separated.
    expect(text).toContain("3800 TRY\n\nالقلب:");
    expect(text).not.toContain("علاج حب الشباب، التقشير الكيميائي");
    expect(text).not.toMatch(/-{3,}|={3,}|\*{3,}/);
  });

  it("shows one department in the same shape when the question is scoped", () => {
    const rendered = renderServiceGroups([CATALOG.groups[1]!], "TRY");
    expect(rendered).toBe(
      ["القلب:", "- استشارة قلب — 1500 TRY", "- رسم قلب ECG — 900 TRY"].join("\n"),
    );
  });

  it("lists a service with no configured price without inventing one", () => {
    const rendered = renderServiceGroups(
      [{ departmentName: "القلب", services: [{ name: "استشارة", price: null }] }],
      "TRY",
    );
    expect(rendered).toBe("القلب:\n- استشارة");
  });

  it("sections a compound question and keeps the patient's order", async () => {
    const result = await turn(
      [
        { kind: "answer_question", topic: "address" },
        { kind: "answer_question", topic: "phone" },
        { kind: "answer_question", topic: "departments" },
        { kind: "answer_question", topic: "services" },
      ],
      said("عايز اعرف العنوان ورقم الهاتف والاقسام والخدمات"),
    );
    const text = reply(result.effects);
    expect(text.indexOf("عنوان العيادة")).toBeLessThan(text.indexOf("رقم التليفون"));
    expect(text.indexOf("رقم التليفون")).toBeLessThan(text.indexOf("الأقسام"));
    expect(text.indexOf("الأقسام")).toBeLessThan(text.indexOf("الخدمات والأسعار"));
    expect(text).toMatch(/\n\n/);
    expect(text).not.toMatch(/-{3,}|={3,}|\*{3,}/);
  });

  it("offers one natural next step after an answer, and none during a question", async () => {
    const answered = await turn(
      [{ kind: "answer_question", topic: "departments" }],
      said("ايه الاقسام عندكم؟"),
    );
    expect(reply(answered.effects)).toContain("تحب أعرفك خدمات قسم معين");

    // A booking question owns its turn: no invitation is stapled underneath it.
    const asking = await turn(
      [],
      context({ flows: bookingFrame({ beneficiary: slotValue("self") }) }),
    );
    expect(reply(asking.effects)).not.toContain("تحب أساعدك في حجز موعد؟");
  });
});

// ===========================================================================
// F — bilingual, clinic-authored names
// ===========================================================================

describe("bilingual display names", () => {
  it("prefers the clinic's Arabic name in Arabic and its English name in English", () => {
    const department = { name: "Dermatology", nameAr: "الجلدية", nameEn: "Dermatology" };
    expect(localizedName(department, "ar")).toBe("الجلدية");
    expect(localizedName(department, "en")).toBe("Dermatology");
    expect(doctorDisplayName(YOUSSEF, "ar")).toBe("د. يوسف عادل");
    expect(doctorDisplayName(YOUSSEF, "en")).toBe("Dr. Youssef Adel");
  });

  it("falls back to the canonical stored text, never to a rendering of its own", () => {
    const department = { name: "Physical Therapy", nameAr: null, nameEn: null };
    // The honest answer in an Arabic conversation is the name the clinic
    // stored. A transliterated or translated one would be a name nobody typed.
    expect(localizedName(department, "ar")).toBe("Physical Therapy");
    expect(localizedName(department, "en")).toBe("Physical Therapy");
    expect(localizedName({ name: "القلب", nameAr: "  ", nameEn: null }, "en")).toBe("القلب");
  });

  it("resolves one entity from either language's trusted label", () => {
    // The department the clinic stores as "Dermatology" and displays as
    // «الجلدية» is one row, reachable by both — and reachable by both in *both*
    // conversation languages, because which name became the visible label is a
    // presentation decision and matching is not.
    const departments = [
      { id: "dept-derma", name: "الجلدية", aliases: ["Dermatology", "الجلدية"] },
      { id: "dept-cardio", name: "القلب", aliases: ["Cardiology", "القلب"] },
    ];
    for (const spoken of ["الجلدية", "Dermatology", "dermatology", "جلدية"]) {
      const resolved = resolveNamedEntity(spoken, departments);
      expect(resolved.status, spoken).toBe("resolved");
      expect(resolved.status === "resolved" ? resolved.entity.id : null, spoken).toBe(
        "dept-derma",
      );
    }

    // The same for a doctor, from the directory's own projection.
    const roster = [HANEEN, YOUSSEF].map((doctor) =>
      toDoctorOption({
        ...doctor,
        departmentId: "dept-physio",
        departmentName: "العلاج الطبيعي",
        state: "available" as const,
        unavailableUntil: null,
      }),
    );
    for (const spoken of [
      "يوسف عادل",
      "د. يوسف",
      "دكتور يوسف",
      "Youssef Adel",
      "Dr Youssef",
    ]) {
      const resolved = resolveNamedEntity(spoken, roster);
      expect(resolved.status, spoken).toBe("resolved");
      expect(resolved.status === "resolved" ? resolved.entity.id : null, spoken).toBe(
        YOUSSEF.id,
      );
    }
  });

  it("keeps an alias out of everything the patient reads", async () => {
    const result = await turn(
      [],
      context({ flows: bookingFrame({ beneficiary: slotValue("self") }) }),
    );
    const text = reply(result.effects);
    // The English names are matchable and invisible: one label per option.
    expect(text).toContain("1- الجلدية");
    expect(text).not.toContain("Dermatology");
  });

  it("adds the honorific as language and never doubles one already stored", () => {
    expect(doctorDisplayName({ name: "Sara Ali" }, "ar")).toBe("د. Sara Ali");
    expect(doctorDisplayName({ name: "Dr. Sara Ali" }, "ar")).toBe("Dr. Sara Ali");
    expect(doctorDisplayName({ name: "د. سارة علي" }, "en")).toBe("د. سارة علي");
  });
});

// ===========================================================================
// G — continuity
// ===========================================================================

describe("continuity: a pause is not a reset", () => {
  it("continues the same booking after several minutes of silence", async () => {
    const startedAt = new Date(NOW.getTime() - 7 * 60 * 1000).toISOString();
    const paused: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: startedAt }),
          slots: {
            beneficiary: { value: "self", provenance: "spoken", at: startedAt },
            department: { value: "dept-physio", provenance: "spoken", at: startedAt },
            doctor: { value: "doc-youssef", provenance: "spoken", at: startedAt },
          },
          offer: {
            id: "offer_abcd1234",
            flow: "book_appointment" as const,
            kind: "slot_value" as const,
            slot: "day" as const,
            options: dayOptions(DAYS),
            primaryOptionId: null,
            at: startedAt,
          },
        },
      ],
    };
    const result = await turn([], said("بعد يوم 11", { flows: paused }));
    const frame = activeFrame(result.state);
    expect(frame?.flow).toBe("book_appointment");
    expect(frame?.status).toBe("active");
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
    expect(result.trace).not.toContain("parked_stale_frames");
    // And it does not reach for a patient-records topic, which is what
    // produced the identity challenge in the QA session.
    expect(keys(result.effects)).not.toContain("identity.required");
  });
});
