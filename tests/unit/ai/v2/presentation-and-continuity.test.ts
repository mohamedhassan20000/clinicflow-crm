/**
 * The presentation and flow-continuity pass, from behaviour.
 *
 * Two families of defect, both from one real Arabic manual-QA session:
 *
 *   1. **Presentation.** Every bounded choice the assistant offered was
 *      flattened into a comma-separated run — «Physical Therapy، Cardiology»,
 *      «Dr. Haneen Samir, Dr. Youssef Adel», «2026-09-07، 2026-09-08» — and a
 *      four-topic clinic answer arrived as one dense paragraph with the prices
 *      detached from the services they belonged to.
 *
 *   2. **Continuity.** The assistant offered days, the patient paused a few
 *      minutes and asked «ايه الايام المتاحة بعد يوم 11». It answered «اتفضل،
 *      أقدر أساعدك في إيه؟», and on the repeat demanded identity verification.
 *      Nothing had expired — the booking's idle limit is thirty minutes and the
 *      frame was still active — so this is asserted as what it is: a refinement
 *      of the open step, which must stay in the booking and must not reach a
 *      patient-records topic.
 *
 * Nothing here asserts a screenshot. Every test states a property — one option
 * per line, a number selects from the live offer only, a pause is not a reset —
 * and the fixtures are ordinary clinic data rather than the QA session's own
 * strings.
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
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import {
  doctorDisplayName,
  formatOfferedDay,
  formatOfferedTime,
  offerIndexFromSpoken,
} from "@/lib/ai/v2/present";
import { parseDateLowerBound } from "@/lib/ai/v2/normalize";

// The clinic's own rows. Departments stored in English, which is the ordinary
// configuration for an Arabic-speaking clinic with an English admin UI and the
// configuration the QA session was run against.
const DEPARTMENTS = [
  { value: "dept-derma", label: "Dermatology", source: "clinic_directory" as const },
  { value: "dept-cardio", label: "Cardiology", source: "clinic_directory" as const },
  { value: "dept-physio", label: "Physical Therapy", source: "clinic_directory" as const },
];
const HANEEN = { id: "doc-haneen", name: "Haneen Samir" };
const YOUSSEF = { id: "doc-youssef", name: "Youssef Adel" };

const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();

/** Five consecutive clinic days, as `readAvailableDays` returns them. */
const DAYS = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
const LATER_DAYS = ["2026-09-12", "2026-09-13", "2026-09-14"];

function dayCandidates(dates: readonly string[], locale: "ar" | "en" = "ar") {
  return dates.map((date) => ({
    value: date,
    label: formatOfferedDay(date, locale),
    source: "clinic_directory" as const,
  }));
}

function timeCandidates(times: readonly string[], locale: "ar" | "en" = "ar") {
  return times.map((time) => ({
    value: time,
    label: formatOfferedTime(time, locale, "12h"),
    source: "clinic_directory" as const,
  }));
}

function doctorCandidates(locale: "ar" | "en" = "ar") {
  return [HANEEN, YOUSSEF].map((doctor) => ({
    value: doctor.id,
    label: doctorDisplayName(doctor, locale),
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
    patientId: "patient-1",
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

function offerIn(effects: readonly Effect[]) {
  const offer = effects.find((effect) => effect.kind === "offer");
  return offer && offer.kind === "offer" ? offer.offer : null;
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

/** The numbered lines of a rendered message, in order. */
function numberedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+-\s/.test(line));
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue(DEPARTMENTS);
  stubs.readDoctors.mockResolvedValue(doctorCandidates());
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
  stubs.readPublicPackages.mockResolvedValue([]);
  stubs.readServices.mockResolvedValue({ groups: [], currency: "TRY", total: 0 });
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.readClinicInsurance.mockResolvedValue([]);
  stubs.readClinicFaq.mockResolvedValue([]);
  stubs.readClinicInfo.mockResolvedValue({
    name: "Clinic",
    address: "Bağcılar Mahallesi, Atatürk Caddesi No:42, 34200 İstanbul",
    phone: "+90 212 555 0100",
  });
});

// ===========================================================================
// A / C — doctors: one per line, Arabic honorific, language-tolerant matching
// ===========================================================================

describe("doctor offers", () => {
  it("renders one doctor per line, numbered", async () => {
    const result = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-derma"),
        }),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const text = reply(result.effects);
    expect(numberedLines(text)).toEqual(["1- د. Haneen Samir", "2- د. Youssef Adel"]);
    // Not a comma-separated run, which is what it was.
    expect(text).not.toContain("د. Haneen Samir، د. Youssef Adel");
  });

  it("carries the Arabic honorific in Arabic and the English one in English", () => {
    expect(doctorDisplayName(YOUSSEF, "ar")).toBe("د. Youssef Adel");
    expect(doctorDisplayName(YOUSSEF, "en")).toBe("Dr. Youssef Adel");
    // A stored name that already has a title in either script keeps the one it
    // has, rather than acquiring a second.
    expect(doctorDisplayName({ name: "Dr. Sara Ali" }, "ar")).toBe("Dr. Sara Ali");
    expect(doctorDisplayName({ name: "د. سارة علي" }, "en")).toBe("د. سارة علي");
  });

  it("prefers a trusted Arabic display name in Arabic when the clinic has one", () => {
    // The bilingual seam. No column carries this today, so nothing populates
    // `nameAr` in production — but the presentation layer is already the only
    // place that decides, so the day it does, every offer localizes at once.
    const bilingual = { name: "Youssef Adel", nameAr: "يوسف عادل" };
    expect(doctorDisplayName(bilingual, "ar")).toBe("د. يوسف عادل");
    expect(doctorDisplayName(bilingual, "en")).toBe("Dr. Youssef Adel");
  });

  it("resolves the same doctor from Arabic and Latin references", () => {
    const roster = [HANEEN, YOUSSEF];
    for (const spoken of [
      "يوسف",
      "دكتور يوسف",
      "د. يوسف",
      "يوسف عادل",
      "Dr Youssef",
      "Dr. Youssef",
      "Youssef",
      "Youssef Adel",
    ]) {
      const resolved = resolveNamedEntity(spoken, roster);
      expect(resolved.status, spoken).toBe("resolved");
      expect(
        resolved.status === "resolved" ? resolved.entity.id : null,
        spoken,
      ).toBe(YOUSSEF.id);
    }
    for (const spoken of ["حنين", "دكتورة حنين", "حنين سمير", "Haneen Samir"]) {
      const resolved = resolveNamedEntity(spoken, roster);
      expect(resolved.status, spoken).toBe("resolved");
      expect(
        resolved.status === "resolved" ? resolved.entity.id : null,
        spoken,
      ).toBe(HANEEN.id);
    }
  });

  it("selects a doctor by the number of the line the patient was shown", async () => {
    const opened = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-derma"),
        }),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "doctor", value: "2" }],
      context({
        flows: opened.state,
        turn: { text: "2", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.doctor?.value).toBe(YOUSSEF.id);
    expect(activeFrame(picked.state)?.slots.doctor?.label).toBe("د. Youssef Adel");
    // Nothing was scored against the roster — the offer answered itself.
    expect(stubs.resolveDoctorSpoken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// B — departments: numbered, and selectable by number or by name
// ===========================================================================

describe("department offers", () => {
  it("is numbered, one per line", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "ليا" }],
      context({
        flows: bookingFrame({}),
        turn: { text: "ليا", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(numberedLines(reply(result.effects))).toEqual([
      "1- Dermatology",
      "2- Cardiology",
      "3- Physical Therapy",
    ]);
  });

  it("resolves a numeric answer against the open department offer", async () => {
    const opened = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "ليا" }],
      context({
        flows: bookingFrame({}),
        turn: { text: "ليا", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "department", value: "3" }],
      context({
        flows: opened.state,
        turn: { text: "3", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.department?.value).toBe("dept-physio");
    expect(stubs.resolveDepartmentNamed).not.toHaveBeenCalled();
  });

  it("still resolves a department the patient names in words", async () => {
    stubs.resolveDepartmentNamed.mockResolvedValue({
      kind: "resolved",
      value: "dept-derma",
      label: "Dermatology",
    });
    const picked = await turn(
      [{ kind: "set_slot", slot: "department", value: "الجلدية" }],
      context({
        flows: bookingFrame({ beneficiary: slotValue("self") }),
        turn: { text: "الجلدية", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.department?.value).toBe("dept-derma");
  });

  it("refuses a number that names no line of the current offer", async () => {
    const opened = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "ليا" }],
      context({
        flows: bookingFrame({}),
        turn: { text: "ليا", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "department", value: "9" }],
      context({
        flows: opened.state,
        turn: { text: "9", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.department).toBeUndefined();
  });

  it("cannot resolve a number against an offer that is no longer open", async () => {
    // The frame has been silent past `book_appointment`'s idle limit, so
    // `parkStaleFrames` has withdrawn its offer. A number then selects nothing.
    const stale = bookingFrame(
      { beneficiary: slotValue("self") },
      {
        lastAdvancedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
        offer: {
          id: "dept_00000001",
          slot: "department",
          options: DEPARTMENTS.map((entry, index) => ({
            id: `opt_0000000${index}`,
            value: entry.value,
            label: entry.label,
            source: "clinic_directory" as const,
          })),
          primaryOptionId: null,
          flow: "book_appointment" as const,
          kind: "slot_value" as const,
          at: AT,
        },
      },
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "department", value: "3" }],
      context({
        flows: stale,
        turn: { text: "3", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)).toBeNull();
    expect(picked.trace).toContain("slot_without_flow");
  });
});

// ===========================================================================
// D / E — days and times
// ===========================================================================

describe("day and time offers", () => {
  const withDoctor = () =>
    bookingFrame({
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-youssef", "د. Youssef Adel"),
    });

  it("shows the Arabic weekday beside the date, one day per line", async () => {
    const result = await turn(
      [],
      context({
        flows: withDoctor(),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(numberedLines(reply(result.effects))).toEqual([
      "1- الاثنين — 07-09-2026",
      "2- الثلاثاء — 08-09-2026",
      "3- الأربعاء — 09-09-2026",
      "4- الخميس — 10-09-2026",
      "5- الجمعة — 11-09-2026",
    ]);
  });

  it("shows English weekdays in an English conversation", () => {
    expect(formatOfferedDay("2026-09-08", "en")).toBe("Tuesday — 08-09-2026");
    expect(formatOfferedDay("2026-09-08", "ar")).toBe("الثلاثاء — 08-09-2026");
  });

  it("resolves a day from its number, its weekday, or its date", async () => {
    const offered = await turn(
      [],
      context({
        flows: withDoctor(),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    for (const spoken of ["2", "الثلاثاء", "يوم الثلاثاء", "8 سبتمبر", "08-09-2026", "2026-09-08"]) {
      const picked = await turn(
        [{ kind: "set_slot", slot: "day", value: spoken }],
        context({
          flows: offered.state,
          turn: { text: spoken, receivedAt: AT, locale: "ar", attachments: [] },
        }),
      );
      expect(activeFrame(picked.state)?.slots.day?.value, spoken).toBe("2026-09-08");
    }
  });

  it("never reads a weekday as a date outside the offer", async () => {
    // No Saturday in the offered window, so «السبت» resolves to nothing rather
    // than to some future Saturday the doctor does not work.
    const offered = await turn(
      [],
      context({
        flows: withDoctor(),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "day", value: "السبت" }],
      context({
        flows: offered.state,
        turn: { text: "السبت", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.day).toBeUndefined();
  });

  it("lists times one per line in the clinic's configured clock", async () => {
    const result = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-derma"),
          doctor: slotValue("doc-youssef", "د. Youssef Adel"),
          day: slotValue("2026-09-08"),
        }),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(numberedLines(reply(result.effects))).toEqual([
      "1- 9:00 صباحًا",
      "2- 9:15 صباحًا",
      "3- 9:30 صباحًا",
    ]);
  });

  it("resolves a time by number, by the displayed time, and from Arabic words", async () => {
    const base = bookingFrame({
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-youssef", "د. Youssef Adel"),
      day: slotValue("2026-09-08"),
    });
    stubs.readAvailableSlots.mockResolvedValue({
      ok: true,
      times: timeCandidates(["09:00", "12:15", "16:30"]),
    });
    const offered = await turn(
      [],
      context({
        flows: base,
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const cases: [string, string][] = [
      ["2", "12:15"],
      ["12:15 مساءً", "12:15"],
      ["12 وربع", "12:15"],
    ];
    for (const [spoken, expected] of cases) {
      const picked = await turn(
        [{ kind: "set_slot", slot: "time", value: spoken }],
        context({
          flows: offered.state,
          turn: { text: spoken, receivedAt: AT, locale: "ar", attachments: [] },
        }),
      );
      expect(activeFrame(picked.state)?.slots.time?.value, spoken).toBe(expected);
    }
  });

  it("still refuses a time the calendar did not offer", async () => {
    const offered = await turn(
      [],
      context({
        flows: bookingFrame({
          beneficiary: slotValue("self"),
          department: slotValue("dept-derma"),
          doctor: slotValue("doc-youssef", "د. Youssef Adel"),
          day: slotValue("2026-09-08"),
        }),
        turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const picked = await turn(
      [{ kind: "set_slot", slot: "time", value: "23:45" }],
      context({
        flows: offered.state,
        turn: { text: "23:45", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(picked.state)?.slots.time).toBeUndefined();
  });
});

// ===========================================================================
// F — a compound clinic answer has sections
// ===========================================================================

describe("compound informational answers", () => {
  it("separates the topics, keeps the patient's order, and blocks the services", async () => {
    stubs.readServices.mockResolvedValue({
      currency: "TRY",
      total: 2,
      groups: [
        {
          departmentId: "dept-derma",
          departmentName: "الجلدية",
          services: [
            { id: "s1", name: "Acne Treatment Session", price: 2500 },
            { id: "s2", name: "Chemical Peeling", price: 2000 },
          ],
        },
      ],
    });
    const result = await turn(
      [
        { kind: "answer_question", topic: "address" },
        { kind: "answer_question", topic: "phone" },
        { kind: "answer_question", topic: "departments" },
        { kind: "answer_question", topic: "services" },
      ],
      context({
        turn: {
          text: "عايز اعرف العنوان ورقم الهاتف والاقسام الي في العيادة والخدمات الي بتقدموها",
          receivedAt: AT,
          locale: "ar",
          attachments: [],
        },
      }),
    );
    const text = reply(result.effects);

    // The order the patient asked in, not the order the stack happened to hold.
    expect(text.indexOf("عنوان العيادة")).toBeLessThan(text.indexOf("رقم التليفون"));
    expect(text.indexOf("رقم التليفون")).toBeLessThan(text.indexOf("الأقسام النشطة الموجودة في العيادة"));
    expect(text.indexOf("الأقسام النشطة الموجودة في العيادة")).toBeLessThan(text.indexOf("الخدمات والأسعار"));

    // A blank line between sections, so each answer is findable.
    expect(text).toMatch(/\n\n/);
    const sections = text.split("\n\n").filter(Boolean);
    expect(sections.length).toBeGreaterThanOrEqual(4);

    // The departments are a numbered list rather than a comma run.
    expect(numberedLines(text)).toEqual([
      "1- Dermatology",
      "2- Cardiology",
      "3- Physical Therapy",
    ]);

    // Each service keeps its own price on the same line, under the heading of
    // the department it belongs to, and no service is flattened into the
    // paragraph beside another.
    expect(text).toContain("الجلدية:");
    expect(text).toContain("- Acne Treatment Session — 2500 TRY");
    expect(text).toContain("- Chemical Peeling — 2000 TRY");
    expect(text).not.toContain("Acne Treatment Session، Chemical Peeling");

    // Grounded exactly: the prices are the clinic's own numbers, and nothing
    // the clinic did not configure appears.
    expect(text).toContain("Bağcılar Mahallesi, Atatürk Caddesi No:42, 34200 İstanbul");
    expect(text).toContain("+90 212 555 0100");
    expect(text).not.toMatch(/\b(?:3000|1500)\b/);
  });

  it("renders no internal identifier or enum", async () => {
    const result = await turn(
      [
        { kind: "answer_question", topic: "departments" },
        { kind: "answer_question", topic: "address" },
      ],
      context(),
    );
    const text = reply(result.effects);
    for (const leak of ["dept-derma", "dept-cardio", "clinic_directory", "slot_value", "book_appointment"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

// ===========================================================================
// G / H — a pause is not a reset, and a refinement stays in the flow
// ===========================================================================

describe("pausing and refining an open day request", () => {
  const paused = (minutes: number) =>
    bookingFrame(
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-derma"),
        doctor: slotValue("doc-youssef", "د. Youssef Adel"),
      },
      {
        lastAdvancedAt: new Date(NOW.getTime() - minutes * 60 * 1000).toISOString(),
        offer: {
          id: "day_00000001",
          slot: "day",
          options: dayCandidates(DAYS).map((day, index) => ({
            id: `opt_0000000${index}`,
            value: day.value,
            label: day.label,
            source: "clinic_directory" as const,
          })),
          primaryOptionId: null,
          flow: "book_appointment" as const,
          kind: "slot_value" as const,
          at: new Date(NOW.getTime() - minutes * 60 * 1000).toISOString(),
        },
      },
    );

  it("keeps the active frame across a several-minute silence", async () => {
    const result = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      context({
        flows: paused(8),
        turn: { text: "؟", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const frame = activeFrame(result.state);
    expect(frame?.flow).toBe("book_appointment");
    expect(frame?.slots.department?.value).toBe("dept-derma");
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
    // And the message is the step's own question again, not a generic opener.
    const text = reply(result.effects);
    expect(text).not.toBe("اتفضل، أقدر أساعدك في إيه؟");
    expect(text).toContain("الأيام المتاحة");
  });

  it("reads «ايه الايام المتاحة بعد يوم 11» as a bound on the same step", async () => {
    stubs.readAvailableDays.mockImplementation(
      async (input: { after?: string | null }) =>
        input.after
          ? {
              ok: true,
              days: dayCandidates(LATER_DAYS),
              windowStart: LATER_DAYS[0],
              windowEnd: LATER_DAYS[2],
            }
          : {
              ok: true,
              days: dayCandidates(DAYS),
              windowStart: DAYS[0],
              windowEnd: DAYS[4],
            },
    );
    const result = await turn(
      // What the model actually emitted in the failing session. The
      // deterministic reconciliation overrules it.
      [{ kind: "answer_question", topic: "my_appointments" }],
      context({
        flows: paused(8),
        turn: {
          text: "ايه الايام المتاحة بعد يوم 11",
          receivedAt: AT,
          locale: "ar",
          attachments: [],
        },
      }),
    );

    // Still the same booking, with everything it had already settled.
    const frame = activeFrame(result.state);
    expect(frame?.flow).toBe("book_appointment");
    expect(frame?.slots.department?.value).toBe("dept-derma");
    expect(frame?.slots.doctor?.value).toBe("doc-youssef");
    expect(frame?.slots.date_lower_bound?.value).toBe("2026-09-11");
    // One frame, not two.
    expect(result.state.stack).toHaveLength(1);

    // The bound reached the calendar read, and the later days came back.
    expect(stubs.readAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ after: "2026-09-11" }),
    );
    const text = reply(result.effects);
    expect(text).toContain("12-09-2026");
    expect(text).not.toContain("07-09-2026");

    // And no identity challenge, because nothing about this turn discloses a
    // record — which is the exact wrong answer the session received.
    expect(text).not.toContain("نتأكد من هويتك");
    expect(result.trace).not.toContain("step_identity_required");
    expect(stubs.readMyAppointments).not.toHaveBeenCalled();
  });

  it("reads the other ordinary refinements the same way", () => {
    const today = "2026-09-05";
    expect(parseDateLowerBound("ايه الايام المتاحة بعد يوم 11", today)?.date).toBe("2026-09-11");
    expect(parseDateLowerBound("في بعد يوم 15؟", today)?.date).toBe("2026-09-15");
    expect(parseDateLowerBound("طب الاسبوع الجاي", today)?.date).toBe("2026-09-11");
    expect(parseDateLowerBound("anything after 2026-09-20", today)?.date).toBe("2026-09-20");
    // A bound whose day-of-month has passed resolves forward, never backward.
    expect(parseDateLowerBound("بعد يوم 2", today)?.date).toBe("2026-10-02");
  });

  it("does not mistake an ordinary day answer for a refinement", () => {
    const today = "2026-09-05";
    for (const spoken of ["الثلاثاء", "8 سبتمبر", "2", "08-09-2026", "يوم 10"]) {
      expect(parseDateLowerBound(spoken, today), spoken).toBeNull();
    }
  });

  it("leaves a genuinely new episode with no stale intent", async () => {
    // The frame is past its idle limit and carries no offer: `parkStaleFrames`
    // has parked it, so nothing about it is active, and a fresh opener starts
    // nothing. This is the previously-fixed boundary behaviour, asserted here
    // so the continuity work above cannot quietly undo it.
    const abandoned = bookingFrame(
      { beneficiary: slotValue("self"), department: slotValue("dept-derma") },
      { lastAdvancedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString() },
    );
    const result = await turn(
      [{ kind: "small_talk", talk: "greeting" }],
      context({
        flows: abandoned,
        turn: { text: "السلام عليكم", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    expect(activeFrame(result.state)).toBeNull();
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(reply(result.effects)).toContain("أهلًا");
  });

  it("refines nothing once a day has actually been chosen", () => {
    // A committed day makes this a correction, which has its own cascade. The
    // reconciliation deliberately does not fire, so the time is still dropped
    // with the day it depended on.
    expect(offerIndexFromSpoken("بعد يوم 11")).toBeNull();
  });
});

// ===========================================================================
// I / J — the presentation rule is general, and the language holds
// ===========================================================================

describe("presentation policy", () => {
  it("keeps a yes/no question as prose rather than a list", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context({
        turn: { text: "عايز احجز", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const text = reply(result.effects);
    expect(numberedLines(text)).toEqual([]);
    expect(text).toContain("ليك إنت ولا لحد تاني");
    // And the canonical tokens are still nowhere near the patient.
    expect(text).not.toContain("self");
    expect(text).not.toContain("other");
    expect(offerIn(result.effects)?.options.map((option) => option.value)).toEqual([
      "self",
      "other",
    ]);
  });

  it("renders an English conversation in English throughout", async () => {
    const english = context({
      turn: { text: "book me in", receivedAt: AT, locale: "en", attachments: [] },
      clinic: {
        name: "Clinic",
        timeZone: "Africa/Cairo",
        locale: "en",
        country: "EG",
        timeFormat: "12h",
      },
      flows: bookingFrame({
        beneficiary: slotValue("self"),
        department: slotValue("dept-derma"),
      }),
    });
    stubs.readDoctors.mockResolvedValue(doctorCandidates("en"));
    const result = await turn([], english);
    const text = reply(result.effects, "en");
    expect(numberedLines(text)).toEqual(["1- Dr. Haneen Samir", "2- Dr. Youssef Adel"]);
    expect(text).toContain("Available doctors");
    expect(text).not.toContain("الدكاترة");
  });

  it("stays Arabic even though the clinic's own rows are stored in English", async () => {
    const result = await turn(
      [{ kind: "set_slot", slot: "beneficiary", value: "ليا" }],
      context({
        flows: bookingFrame({}),
        turn: { text: "ليا", receivedAt: AT, locale: "ar", attachments: [] },
      }),
    );
    const text = reply(result.effects);
    expect(text).toContain("الأقسام النشطة الموجودة في العيادة");
    expect(text).toContain("تحب أنهي قسم؟");
    // The department names themselves are the clinic's trusted rows, untranslated.
    expect(text).toContain("Dermatology");
    expect(text).not.toContain("Our departments");
  });

  it("reads a bare number as a position and nothing else", () => {
    expect(offerIndexFromSpoken("2")).toBe(2);
    expect(offerIndexFromSpoken("٣")).toBe(3);
    expect(offerIndexFromSpoken("رقم 1")).toBe(1);
    // Word ordinals stay with the roster resolver, because «تاني» is also the
    // ordinary word for *another* and reading it as "option 2" would select a
    // doctor from a rejection.
    expect(offerIndexFromSpoken("التاني")).toBeNull();
    expect(offerIndexFromSpoken("دكتور تاني")).toBeNull();
    expect(offerIndexFromSpoken("8 سبتمبر")).toBeNull();
  });
});
