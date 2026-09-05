/**
 * P11C — "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي".
 *
 * The message a real patient sent to conversation `763b1c6b` on 2026-08-24 at
 * 14:44:26Z. *"Shall we continue? I want to book physical therapy for my son."*
 * It is a third-party booking request naming a department the clinic actually
 * has. What came back was the generic staff-handoff copy, because
 * `detectPatientEscalation` matched the bare noun `علاج` — "treatment" — in
 * `MEDICAL_PATTERNS` and returned before the agent existed. `audit_logs` for
 * that turn contains exactly two rows, `agent_tool:patient_escalation`
 * (`reason: "medical"`) and the stage trace it caused; there is no turn-opening
 * trace, no tool call and no model call, because the pre-model classifier
 * short-circuits all three.
 *
 * The same word had done the same thing sixteen hours earlier: the bare message
 * "علاج طبيعي" at 17:14:32 produced `agent_tool:patient_escalation`
 * (`reason: "medical"`) at 17:14:34 and the `escalated` latch stamped
 * `stageEnteredAt: 2026-08-23T17:14:34.957Z` — the same latch P11B traced the
 * phantom doctors to. P11B fixed what the stuck latch did. This file fixes what
 * set it.
 *
 * What is asserted here, and the order matters:
 *
 *   1. the exact message does not escalate — and neither does any of the
 *      continuation phrases third-party booking is supposed to accept;
 *   2. every genuine escalation still escalates;
 *   3. no clinic-supplied value can weaken the emergency or human-request
 *      classes, ever;
 *   4. the department is resolved from live rows, generated per run, so a
 *      hard-coded Physical Therapy branch would fail rather than pass; and
 *   5. the booking continues — doctor, day, time, third-party intake, pending
 *      booking — with the third party's identity never touching the sender's.
 *
 * There is no real specialty in the generated half of this file. `علاج طبيعي`
 * appears only where the *production incident* is being reproduced verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "763b1c6b-c388-4f36-b8ca-965f71f20f86";

const PT = "d0000000-0000-4000-8000-000000000001";
const ALPHA = "d0000000-0000-4000-8000-00000000000a";
const BETA = "d0000000-0000-4000-8000-00000000000b";

const PT_DOC = "aaaaaaaa-0000-4000-8000-000000000001";
const PT_RECEPTION = "aaaaaaaa-0000-4000-8000-000000000002";
const PT_ON_LEAVE = "aaaaaaaa-0000-4000-8000-000000000003";
const ALPHA_DOC = "aaaaaaaa-0000-4000-8000-000000000004";
const BETA_DOC = "aaaaaaaa-0000-4000-8000-000000000005";

const NOW = new Date("2026-08-25T09:00:00.000Z");

/** The message, byte for byte, as `inbound_messages` stored it. */
const REPRODUCED = "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي";
/** The message that set the latch the day before, byte for byte. */
const LATCH_SETTER = "علاج طبيعي";

function doctorRow(
  id: string,
  full_name: string,
  department_id: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    full_name,
    department_id,
    role: "doctor",
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

function departmentRow(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return { id, name, is_active: true, deleted_at: null, ...overrides };
}

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  getClinicCurrency: async () => "EGP",
  createClinicScopedAdminClient: () => ({
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows(), error: null }),
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        lte(column: string, value: string) {
          filters.push((row) => String(row[column]) <= value);
          return builder;
        },
        gt(column: string, value: string) {
          filters.push((row) => String(row[column]) > value);
          return builder;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      };
      function rows() {
        return (mocks.tables[table] ?? []).filter((row) =>
          filters.every((predicate) => predicate(row)),
        );
      }
      return builder;
    },
  }),
}));

import { detectPatientEscalation } from "@/lib/ai/patient-escalation";
import {
  buildClinicVocabulary,
  maskClinicVocabulary,
} from "@/lib/ai/entity-resolution";
import {
  assertRosterAuthority,
  availableDoctorsInDepartment,
  loadClinicDepartmentNames,
  loadDoctorDirectory,
} from "@/lib/ai/doctor-directory";
import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";
import { listDoctorsTool } from "@/lib/ai/tools/list-doctors";
import {
  allowedToolsForStage,
  deriveStage,
  nextStage,
  workflowToolsForStage,
  type BookingStage,
} from "@/lib/ai/booking-stage";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    identityLockedUntil: null,
    clinicName: "Clinic",
    clinicLocale: "ar",
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {},
    pendingClarification: null,
    bookingStage: {
      stage: "idle",
      submitted: false,
      escalated: false,
      intakeStaged: false,
      bookingForOther: false,
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: {},
      turnCount: 0,
      illegalTransitions: 0,
      enteredAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      toolOutcomes: [],
    },
    ...overrides,
  };
}

function prepare(input: Record<string, unknown>) {
  return prepareBookingTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}
function listDoctors(input: Record<string, unknown> = {}) {
  return listDoctorsTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}
function names(result: Record<string, unknown>, key = "doctors"): string[] {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}

/** The live department names, exactly as the classifier receives them. */
async function departmentNames(): Promise<string[]> {
  return loadClinicDepartmentNames(CLINIC);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.authorize.mockResolvedValue(identity());
  mocks.tables = {
    // The department under test carries the English name the reported clinic
    // stores, trailing space and all — the patient writes Arabic at it.
    departments: [
      departmentRow(PT, "Physical Therapy "),
      departmentRow(ALPHA, "Qorvex Wing"),
      departmentRow(BETA, "قسم زِلبار"),
    ],
    profiles: [
      doctorRow(PT_DOC, "Haneen Samir", PT),
      doctorRow(PT_RECEPTION, "Mariam Tarek", PT, { role: "receptionist" }),
      doctorRow(PT_ON_LEAVE, "Adel Sherif", PT),
      doctorRow(ALPHA_DOC, "Rana Wasfy", ALPHA),
      doctorRow(BETA_DOC, "بسمة راغب", BETA),
    ],
    doctor_unavailability: [
      {
        doctor_id: PT_ON_LEAVE,
        is_active: true,
        starts_at: "2026-08-20T00:00:00.000Z",
        ends_at: "2026-09-20T00:00:00.000Z",
      },
    ],
    services: [],
  };
});

// ---------------------------------------------------------------------------
// §1 · the reproduced turn
// ---------------------------------------------------------------------------

describe("P11C §1 · the exact production message is a booking, not an escalation", () => {
  it("does not escalate, with the clinic's own live department names", async () => {
    const detection = detectPatientEscalation(REPRODUCED, {
      clinicDepartmentNames: await departmentNames(),
    });
    expect(detection).toEqual({ escalate: false, reason: null, emergency: false });
  });

  it("does not escalate even with no clinic vocabulary at all", () => {
    // The two protections are independent. Strip the vocabulary and the
    // topic/ask split still refuses to read a booking as a clinical question.
    expect(detectPatientEscalation(REPRODUCED).escalate).toBe(false);
  });

  it("does not escalate the bare message that set the latch the day before", async () => {
    const vocabulary = await departmentNames();
    expect(detectPatientEscalation(LATCH_SETTER, {
      clinicDepartmentNames: vocabulary,
    }).escalate).toBe(false);
  });

  it("is a regression: the retired pattern still matches the message", () => {
    // The point of this assertion is that the fix is not incidental. The bare
    // noun that shipped in `MEDICAL_PATTERNS` does match this sentence — which
    // is why removing it, rather than tuning around it, was the fix.
    expect(/(تشخيص|وصفة|جرعة|دواء|أعراض|اعراض|علاج)/.test(REPRODUCED)).toBe(true);
    expect(/(تشخيص|وصفة|جرعة|دواء|أعراض|اعراض|علاج)/.test(LATCH_SETTER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2 · continuation language
// ---------------------------------------------------------------------------

describe("P11C §2 · every third-party continuation phrase stays in the booking", () => {
  const PHRASES = [
    "لابني",
    "لبنتي",
    "لابويا",
    "لوالدتي",
    "لاخويا",
    "لمراتي",
    "لجوزي",
    "لصاحبي",
    "لشخص تاني",
  ];

  it.each(PHRASES)("'عايز احجز %s' is a booking", async (phrase) => {
    const vocabulary = await departmentNames();
    expect(
      detectPatientEscalation(`عايز احجز ${phrase}`, {
        clinicDepartmentNames: vocabulary,
      }),
    ).toEqual({ escalate: false, reason: null, emergency: false });
  });

  it.each(PHRASES)("'عايز احجز %s علاج طبيعي' is a booking", async (phrase) => {
    const vocabulary = await departmentNames();
    expect(
      detectPatientEscalation(`عايز احجز ${phrase} علاج طبيعي`, {
        clinicDepartmentNames: vocabulary,
      }).escalate,
    ).toBe(false);
  });

  it("keeps the rest of that conversation's real messages out of escalation", async () => {
    const vocabulary = await departmentNames();
    for (const text of [
      "السلام عليكم ورحمة الله وبركاته",
      "لا انا عايز احجز موعد لابني",
      "لا مش جلدية",
      "ايه الاقسام المتاحة",
      "ممكن احجز موعد ؟",
      "بحجز لزوجتي",
      "ايه الخدمات الي بتقدموها واسعارها؟",
      "ممكن تشوفلي لو في مواعيد محجوزة ليا؟",
      "عايز اعرف مين الدكاترة المتاحين الاول",
    ]) {
      expect({
        text,
        ...detectPatientEscalation(text, { clinicDepartmentNames: vocabulary }),
      }).toEqual({ text, escalate: false, reason: null, emergency: false });
    }
  });
});

// ---------------------------------------------------------------------------
// §3 · nothing genuine was weakened
// ---------------------------------------------------------------------------

describe("P11C §3 · genuine escalations are untouched", () => {
  it.each([
    "I have severe chest pain and can't breathe",
    "this is an emergency please help",
    "عندي ألم في الصدر ولا أستطيع التنفس",
    "أحتاج إسعاف الآن",
  ])("emergency: %s", async (text) => {
    expect(
      detectPatientEscalation(text, { clinicDepartmentNames: await departmentNames() }),
    ).toMatchObject({ escalate: true, reason: "emergency", emergency: true });
  });

  it.each([
    "I want to talk to a human",
    "can I speak with a receptionist",
    "أريد التحدث مع موظف",
    "ممكن تحويلي لموظف",
    "عايز حد يرد عليا",
  ])("human request: %s", async (text) => {
    expect(
      detectPatientEscalation(text, { clinicDepartmentNames: await departmentNames() }),
    ).toMatchObject({ escalate: true, reason: "human_requested" });
  });

  it.each([
    "what dosage of the medication should I take",
    "should I stop my medication?",
    "what's wrong with me",
    "is this dangerous",
    "عندي أعراض غريبة",
    "ايه الجرعة المناسبة للدواء ده؟",
    "هل الدواء ده خطير؟",
    "ايش فيني",
    "شخص حالتي",
    "هل آخذ الدواء",
  ])("clinical judgment: %s", async (text) => {
    expect(
      detectPatientEscalation(text, { clinicDepartmentNames: await departmentNames() }),
    ).toMatchObject({ escalate: true, reason: "medical" });
  });

  it("escalates a judgment request even when a booking is in the same message", async () => {
    // A logistics frame demotes a bare *topic*. It can never demote an explicit
    // request for a decision about the patient's body.
    expect(
      detectPatientEscalation("عايز احجز موعد، وكمان هل أتوقف عن الدواء؟", {
        clinicDepartmentNames: await departmentNames(),
      }),
    ).toMatchObject({ escalate: true, reason: "medical" });
    expect(
      detectPatientEscalation("I want to book an appointment — also should I stop my pills?", {
        clinicDepartmentNames: await departmentNames(),
      }),
    ).toMatchObject({ escalate: true, reason: "medical" });
  });

  it("still escalates complaints", () => {
    expect(
      detectPatientEscalation("I want to file a complaint, this is unacceptable"),
    ).toMatchObject({ escalate: true, reason: "complaint" });
  });
});

// ---------------------------------------------------------------------------
// §4 · the clinic can never blind the safety classes
// ---------------------------------------------------------------------------

describe("P11C §4 · clinic vocabulary suppresses nothing that matters", () => {
  const HOSTILE = [
    "Emergency",
    "طوارئ",
    "إسعاف",
    "Chest Pain Unit",
    "قسم الشكاوى",
    "Customer Service",
    "Human",
  ];

  it("an emergency is an emergency however the clinic names its departments", () => {
    for (const text of [
      "I have severe chest pain",
      "this is an emergency",
      "أحتاج إسعاف الآن",
      "عندي ألم في الصدر",
    ]) {
      expect(
        detectPatientEscalation(text, { clinicDepartmentNames: HOSTILE }),
      ).toMatchObject({ escalate: true, reason: "emergency", emergency: true });
    }
  });

  it("a human request survives a department called Customer Service", () => {
    expect(
      detectPatientEscalation("I want to talk to a human", {
        clinicDepartmentNames: HOSTILE,
      }),
    ).toMatchObject({ escalate: true, reason: "human_requested" });
  });

  it("masking is a subtraction only — it can never invent a signal", async () => {
    const vocabulary = buildClinicVocabulary(await departmentNames());
    const masked = maskClinicVocabulary(REPRODUCED, vocabulary);
    expect(masked).toHaveLength(REPRODUCED.length);
    expect(masked.replace(/\s/g, "")).not.toContain("علاج");
    // Every surviving character is a character of the original, in place.
    for (let i = 0; i < REPRODUCED.length; i += 1) {
      const char = masked[i]!;
      expect(char === " " || char === REPRODUCED[i]).toBe(true);
    }
  });

  it("an empty vocabulary masks nothing", () => {
    expect(maskClinicVocabulary(REPRODUCED, buildClinicVocabulary([]))).toBe(REPRODUCED);
  });
});

// ---------------------------------------------------------------------------
// §5 · the department is data
// ---------------------------------------------------------------------------

describe("P11C §5 · resolution is generic over arbitrary departments", () => {
  it("resolves 'علاج طبيعي' to the live row, and offers only its eligible doctors", async () => {
    const result = await prepare({ department: "علاج طبيعي" });
    expect(result.department).toMatchObject({ id: PT });
    // The receptionist and the doctor on leave are both in this department and
    // neither may be offered.
    expect(names(result)).toEqual(["Haneen Samir"]);
  });

  it("no invented doctor can appear, in any department", async () => {
    const directory = await loadDoctorDirectory(CLINIC);
    for (const department of directory.departments) {
      const roster = availableDoctorsInDepartment(directory, department.id);
      expect(() =>
        assertRosterAuthority(directory, department.id, [
          ...roster,
          // A person in no table anywhere. The check is membership of the
          // authoritative roster, so it does not have to recognise the name as
          // invented — only as not offered, which it cannot be.
          {
            id: "ffffffff-0000-4000-8000-00000000000f",
            name: "Zephyrine Quillbottom",
            departmentId: department.id,
            departmentName: department.name,
            state: "available" as const,
            unavailableUntil: null,
          },
        ]),
      ).toThrow();
      // And the roster itself is exactly the eligibility predicate, computed
      // from the fixture rather than asserted against a literal.
      const expected = (mocks.tables.profiles ?? [])
        .filter(
          (row) =>
            row.department_id === department.id &&
            row.role === "doctor" &&
            row.is_active === true &&
            row.is_deleted === false &&
            row.deleted_at === null &&
            row.id !== PT_ON_LEAVE,
        )
        .map((row) => row.full_name);
      expect(roster.map((doctor) => doctor.name).sort()).toEqual(
        [...expected].sort(),
      );
    }
  });

  it("the same sentence works against a department created after boot", async () => {
    const FRESH = "d0000000-0000-4000-8000-00000000000f";
    mocks.tables.departments!.push(departmentRow(FRESH, "Zelbar Annexe"));
    mocks.tables.profiles!.push(doctorRow("aaaaaaaa-0000-4000-8000-00000000000f", "Nadia Shawky", FRESH));
    const vocabulary = await departmentNames();
    expect(vocabulary).toContain("Zelbar Annexe");
    expect(
      detectPatientEscalation("عايز احجز لابني Zelbar Annexe", {
        clinicDepartmentNames: vocabulary,
      }).escalate,
    ).toBe(false);
    const result = await prepare({ department: "Zelbar Annexe" });
    expect(result.department).toMatchObject({ id: FRESH });
    expect(names(result)).toEqual(["Nadia Shawky"]);
  });

  it.each([3, 20, 100])("holds over %i generated departments", async (count) => {
    const departments = Array.from({ length: count }, (_, index) => ({
      id: `d0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Unit ${index}`,
    }));
    mocks.tables.departments = departments.map((item) => departmentRow(item.id, item.name));
    mocks.tables.profiles = departments.map((item, index) =>
      doctorRow(
        `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `Person ${index}`,
        item.id,
      ),
    );
    mocks.tables.doctor_unavailability = [];
    const vocabulary = await departmentNames();
    const directory = await loadDoctorDirectory(CLINIC);
    for (const [index, department] of departments.entries()) {
      // Naming it is a booking, never a clinical question.
      expect(
        detectPatientEscalation(`عايز احجز لابني ${department.name}`, {
          clinicDepartmentNames: vocabulary,
        }).escalate,
      ).toBe(false);
      // And its roster is exactly its own members.
      expect(
        availableDoctorsInDepartment(directory, department.id).map((d) => d.name),
      ).toEqual([`Person ${index}`]);
    }
  });

  it("the roster tool and the booking tool agree", async () => {
    await prepare({ department: "علاج طبيعي" });
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: PT, department_name: "Physical Therapy " } }),
    );
    expect(names(await listDoctors())).toEqual(["Haneen Samir"]);
  });
});

// ---------------------------------------------------------------------------
// §6 · the booking continues, for somebody who is not the sender
// ---------------------------------------------------------------------------

describe("P11C §6 · doctor → day → time → third-party intake → pending booking", () => {
  const facts = (overrides: Record<string, unknown> = {}) => ({
    collected: {},
    linked: true,
    identityVerified: true,
    identityLocked: false,
    intakeStaged: false,
    submitted: false,
    escalated: false,
    bookingForOther: true,
    bookingIntent: true,
    ...overrides,
  });

  it("walks the whole path with the tools each step needs mounted", () => {
    const mounted = [
      "prepare_booking",
      "list_doctors",
      "list_available_days",
      "check_availability",
      "register_patient",
      "create_preliminary_booking",
    ];
    const steps: Array<[BookingStage, Record<string, unknown>, string]> = [
      ["selecting_department", {}, "prepare_booking"],
      ["selecting_doctor", { department_id: PT }, "list_doctors"],
      [
        "intake_collecting",
        { department_id: PT, doctor_id: PT_DOC },
        "register_patient",
      ],
      [
        "selecting_day",
        { department_id: PT, doctor_id: PT_DOC },
        "list_available_days",
      ],
      [
        "selecting_time",
        { department_id: PT, doctor_id: PT_DOC, appointment_date: "2026-09-01" },
        "check_availability",
      ],
      [
        "confirming",
        {
          department_id: PT,
          doctor_id: PT_DOC,
          appointment_date: "2026-09-01",
          appointment_time: 600,
        },
        "create_preliminary_booking",
      ],
    ];
    for (const [expected, collected, needs] of steps) {
      // Intake is required before the day for a third party, and satisfied
      // after it — that is the only difference between the two middle rows.
      const staged = expected !== "intake_collecting";
      const stage = deriveStage(facts({ collected, intakeStaged: staged }));
      expect({ expected, stage }).toEqual({ expected, stage: expected });
      expect(allowedToolsForStage(stage, mounted)).toContain(needs);
    }
  });

  it("sends a linked sender booking for somebody else to intake_collecting", () => {
    // The invariant P9C bought: `linked` is a fact about the phone, not about
    // the person being booked. A registered patient booking for their child is
    // a stranger, for the purpose of opening a file.
    expect(
      deriveStage(facts({ collected: { department_id: PT, doctor_id: PT_DOC } })),
    ).toBe("intake_collecting");
    expect(workflowToolsForStage("intake_collecting")).toContain("register_patient");
  });

  it("does not send a linked sender booking for themselves to intake", () => {
    expect(
      deriveStage(
        facts({
          bookingForOther: false,
          collected: { department_id: PT, doctor_id: PT_DOC },
        }),
      ),
    ).toBe("selecting_day");
  });

  it("reaching `submitted` needs the booking latch, not the sender's file", () => {
    expect(deriveStage(facts({ submitted: true }))).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// §7 · escalation is still a one-way door for the model, and only for it
// ---------------------------------------------------------------------------

describe("P11C §7 · the escalated latch, and who may release it", () => {
  it("no patient message and no tool outcome lifts an escalation", () => {
    const events = [
      "booking_intent",
      "identity_required",
      "identity_verified",
      "department_selected",
      "department_cleared",
      "doctor_selected",
      "doctor_alternatives_requested",
      "doctor_cleared",
      "intake_required",
      "intake_staged",
      "day_selected",
      "day_cleared",
      "time_selected",
      "time_cleared",
      "escalated",
    ] as const;
    for (const type of events) {
      expect(nextStage("escalated", { type } as never)).toBe("escalated");
    }
  });

  it("staff handing the thread back does", () => {
    expect(nextStage("escalated", { type: "de_escalated" })).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// §8 · the fix names nothing
// ---------------------------------------------------------------------------

describe("P11C §8 · no department, specialty or doctor is hard-coded", () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
    }
    return out;
  }

  it("the escalation classifier contains no clinic-specific vocabulary", () => {
    const source = readFileSync("lib/ai/patient-escalation.ts", "utf8");
    // The department that broke: neither the English name nor the doctor.
    for (const forbidden of ["Physical Therapy", "physiotherapy", "Haneen", "Cardiology", "Dermatology"]) {
      expect(source).not.toContain(forbidden);
    }
    // `علاج طبيعي` as a *phrase* appears only in the incident narrative of the
    // module comment, never in a pattern: no regex may contain it.
    const patterns = source
      .split("\n")
      .filter((line) => line.includes("/") && !line.trimStart().startsWith("*"));
    expect(patterns.join("\n")).not.toContain("طبيعي");
  });

  it("no production file names any person from this reproduction", () => {
    const files = ["lib", "actions", "app", "components"].flatMap((dir) => sources(dir));
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      for (const person of ["Haneen Samir", "Zephyrine Quillbottom", "Qorvex"]) {
        expect({ path, person, found: source.includes(person) }).toEqual({
          path,
          person,
          found: false,
        });
      }
    }
  });
});
