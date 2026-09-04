import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11D — a doctor reply may never restart the department flow.
 *
 * Replays the exact production shape that produced the defect, with generated
 * records: a department is offered, its authoritative roster is offered, and
 * the patient answers with a bare first name. Before P11D the deterministic
 * fallback re-derived the department from *that message alone*, found none, and
 * answered with the department list — four turns in a row.
 *
 * The department and doctor names below are **test data**. Production code
 * knows none of them: every candidate comes from the directory the test
 * supplies, and swapping these strings for any others must not change a single
 * assertion about control flow.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPT_X = "d0000000-0000-4000-8000-0000000000aa";
const DEPT_Y = "d0000000-0000-4000-8000-0000000000bb";
const HANEEN = "e0000000-0000-4000-8000-0000000000c1";
const YOUSSEF = "e0000000-0000-4000-8000-0000000000c2";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  setState: vi.fn(),
  recordStage: vi.fn(),
  days: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.setState,
  resolvePatientAiContext: vi.fn(),
}));
vi.mock("@/lib/ai/booking-stage-store", () => ({ recordStageTurn: mocks.recordStage }));
vi.mock("@/lib/booking/patient", () => ({ getPatientAvailableDays: mocks.days }));

import { continuePatientBookingFromRoster } from "@/lib/ai/patient-roster-continuation";
import {
  resolveDepartmentChange,
  resolveOfferedDoctor,
} from "@/lib/ai/offered-doctor-resolution";
import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";

const DIRECTORY = {
  departments: [
    { id: DEPT_Y, name: "Dermatology" },
    { id: DEPT_X, name: "Physical Therapy" },
  ],
  doctors: [
    {
      id: HANEEN,
      name: "Haneen Samir",
      departmentId: DEPT_X,
      departmentName: "Physical Therapy",
      state: "available" as const,
      unavailableUntil: null,
    },
    {
      id: YOUSSEF,
      name: "Youssef Adel",
      departmentId: DEPT_X,
      departmentName: "Physical Therapy",
      state: "available" as const,
      unavailableUntil: null,
    },
    {
      id: "e0000000-0000-4000-8000-0000000000c3",
      name: "Nadia Fouad",
      departmentId: DEPT_Y,
      departmentName: "Dermatology",
      state: "available" as const,
      unavailableUntil: null,
    },
  ],
};

const OFFERED = [
  { id: HANEEN, name: "Haneen Samir" },
  { id: YOUSSEF, name: "Youssef Adel" },
];

function identity(overrides: {
  collected?: Record<string, string>;
  offeredDoctorIds?: readonly string[];
  bookingForOther?: boolean;
}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    identityLockedUntil: null,
    clinicName: "Test Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Europe/Istanbul",
    clinicCountry: "TR",
    participantAddress: "+900000000000",
    aiPaused: false,
    collectedData: overrides.collected ?? {},
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      offeredDoctorIds: overrides.offeredDoctorIds ?? [],
      bookingForOther: overrides.bookingForOther ?? false,
    },
    communicationStyle: {},
  } as never;
}

const base = { directory: DIRECTORY as never, locale: "ar" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.setState.mockResolvedValue({ error: null });
  mocks.recordStage.mockResolvedValue(null);
  mocks.days.mockResolvedValue({
    ok: true,
    availableDays: [{ date: "2026-08-26", slotCount: 4 }, { date: "2026-08-27", slotCount: 2 }],
  });
});

// ---------------------------------------------------------------------------
// The pure resolver
// ---------------------------------------------------------------------------

describe("P11D §4 · a doctor reply resolves against the offered roster", () => {
  const cases: Array<[string, string]> = [
    ["حنين", HANEEN],
    ["دكتورة حنين", HANEEN],
    ["Haneen", HANEEN],
    ["Haneen Samir", HANEEN],
    ["هنين", HANEEN],
    ["يوسف", YOUSSEF],
    ["Youssef", YOUSSEF],
    ["Yousef Adel", YOUSSEF],
    ["الأول", HANEEN],
    ["الاولى", HANEEN],
    ["رقم 1", HANEEN],
    ["التاني", YOUSSEF],
    ["الدكتور التاني", YOUSSEF],
    ["2", YOUSSEF],
  ];
  for (const [text, expected] of cases) {
    it(`resolves ${JSON.stringify(text)}`, () => {
      const result = resolveOfferedDoctor({ patientText: text, offered: OFFERED });
      expect(result.status).toBe("resolved");
      if (result.status === "resolved") expect(result.doctor.id).toBe(expected);
    });
  }

  it("does not clamp an ordinal past the end of the roster", () => {
    expect(resolveOfferedDoctor({ patientText: "رقم 5", offered: OFFERED }).status).toBe(
      "no_match",
    );
  });

  it("returns no_match rather than guessing on an unrelated word", () => {
    expect(
      resolveOfferedDoctor({ patientText: "بكرا الصبح", offered: OFFERED }).status,
    ).toBe("no_match");
  });

  it("never names a doctor who was not offered", () => {
    const result = resolveOfferedDoctor({ patientText: "نادية", offered: OFFERED });
    expect(result.status).toBe("no_match");
  });

  it("asks only among the offered when a name is genuinely shared", () => {
    const shared = [
      { id: "a", name: "Haneen Samir" },
      { id: "b", name: "Haneen Fouad" },
    ];
    const result = resolveOfferedDoctor({ patientText: "حنين", offered: shared });
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
  });
});

describe("P11D §5 · only an explicit department change goes backwards", () => {
  it("treats a bare doctor name as no department change", () => {
    expect(
      resolveDepartmentChange({
        patientText: "حنين",
        departments: DIRECTORY.departments,
        currentDepartmentId: DEPT_X,
      }),
    ).toBeNull();
  });

  it("treats naming the current department as no change", () => {
    expect(
      resolveDepartmentChange({
        patientText: "علاج طبيعي",
        departments: DIRECTORY.departments,
        currentDepartmentId: DEPT_X,
      }),
    ).toBeNull();
  });

  it("recognises a real change", () => {
    expect(
      resolveDepartmentChange({
        patientText: "لا عايز جلدية",
        departments: DIRECTORY.departments,
        currentDepartmentId: DEPT_X,
      })?.id,
    ).toBe(DEPT_Y);
  });
});

// ---------------------------------------------------------------------------
// The exact production turn
// ---------------------------------------------------------------------------

describe("P11D §12 · the reproduced turn", () => {
  it("persists the department and the offered roster when it offers one", async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({}),
      patientText: "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي",
    });

    expect(result.committed).toBe("department");
    expect(result.text).toContain("Haneen Samir");
    expect(result.text).toContain("Youssef Adel");

    // The offer is now state, not just a sentence.
    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({ department_id: DEPT_X }),
      }),
    );
    expect(mocks.recordStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        collectedOverride: expect.objectContaining({ department_id: DEPT_X }),
        offeredDoctorIds: [HANEEN, YOUSSEF],
      }),
    );
  });

  it('resolves "حنين" against that roster instead of restarting departments', async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({
        collected: { department_id: DEPT_X, department_name: "Physical Therapy" },
        offeredDoctorIds: [HANEEN, YOUSSEF],
      }),
      patientText: "حنين",
    });

    expect(result.outcome).toBe("doctor_selected");
    expect(result.committed).toBe("doctor");

    // The department survives, the doctor is persisted.
    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({
          department_id: DEPT_X,
          doctor_id: HANEEN,
        }),
      }),
    );

    // And the assistant moves on to her real days.
    expect(result.text).toContain("Haneen Samir");
    expect(result.text).toContain("٢٦ أغسطس ٢٠٢٦");
    expect(result.text).not.toContain("2026-08-26");

    // The regression itself: no department list, ever.
    expect(result.text).not.toContain("Dermatology");
    expect(result.text).not.toContain("الأقسام المتاحة");
  });

  it("re-offers the department roster when the reply matches no offered doctor", async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({
        collected: { department_id: DEPT_X },
        offeredDoctorIds: [HANEEN, YOUSSEF],
      }),
      patientText: "مش عارف",
    });
    expect(result.outcome).toBe("roster_offered");
    expect(result.text).toContain("Haneen Samir");
    expect(result.text).not.toContain("الأقسام المتاحة");
  });

  it("goes back to departments only on an explicit change", async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({
        collected: { department_id: DEPT_X },
        offeredDoctorIds: [HANEEN, YOUSSEF],
      }),
      patientText: "لا عايز جلدية",
    });
    expect(result.outcome).toBe("department_changed");
    expect(mocks.recordStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        collectedOverride: expect.objectContaining({ department_id: DEPT_Y, doctor_id: "" }),
      }),
    );
  });

  it("shows the department list only when nothing is settled and none is named", async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({}),
      patientText: "حنين",
    });
    expect(result.outcome).toBe("department_list");
    expect(result.committed).toBe("none");
  });
});

describe("P11D §6/§7 · the third-party latch is not disturbed", () => {
  it("never writes bookingForOther while resolving a doctor", async () => {
    await continuePatientBookingFromRoster({
      ...base,
      identity: identity({
        collected: { department_id: DEPT_X },
        offeredDoctorIds: [HANEEN, YOUSSEF],
        bookingForOther: true,
      }),
      patientText: "حنين",
    });
    for (const call of mocks.recordStage.mock.calls) {
      expect(call[1]).not.toHaveProperty("bookingForOther");
    }
  });

  it("keeps the booking target when the subject is a third party", async () => {
    const result = await continuePatientBookingFromRoster({
      ...base,
      identity: identity({
        collected: { department_id: DEPT_X },
        offeredDoctorIds: [HANEEN, YOUSSEF],
        bookingForOther: true,
      }),
      patientText: "حنين",
    });
    expect(result.committed).toBe("doctor");
    expect(result.outcome).toBe("doctor_selected");
  });
});

describe("P11D §13 · the directory is still the authority", () => {
  it("drops an offered doctor deactivated between turns", async () => {
    const directory = {
      ...DIRECTORY,
      doctors: DIRECTORY.doctors.map((doctor) =>
        doctor.id === HANEEN ? { ...doctor, state: "inactive" as const } : doctor,
      ),
    };
    const result = await continuePatientBookingFromRoster({
      directory: directory as never,
      locale: "ar",
      identity: identity({
        collected: { department_id: DEPT_X },
        offeredDoctorIds: [HANEEN, YOUSSEF],
      }),
      patientText: "حنين",
    });
    // She is no longer selectable, and the answer is the *current* roster —
    // not a restart, and not a booking with somebody the directory dropped.
    expect(result.outcome).toBe("roster_offered");
    expect(result.text).not.toContain("Haneen Samir");
    expect(result.text).toContain("Youssef Adel");
  });
});
