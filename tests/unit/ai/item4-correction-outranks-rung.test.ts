/**
 * Item #4 — the newest explicit correction outranks the rung in front of it.
 *
 * ## The two defects
 *
 * **Ordering.** `commitLatestOfferedSelection` runs at the very top of the turn
 * and reads any short declarative message as an answer to the offer on screen.
 * A correction is short and declarative, so the number *inside* it was consumed
 * before anything asked whether it was a correction at all: "لا أنا عايز يوم
 * 12", sent while the patient was holding the 10th, had its `12` matched
 * against the offered slots and became 12:00 on the 10th. The day they asked
 * for never happened, and the review came back showing the day they had just
 * rejected.
 *
 * **Reach.** `applyBookingAmendment` — the one path that re-reads the doctor's
 * real schedule before moving a draft — was gated on `step === "confirm"`. A
 * correction arriving at the day or time rung reached nothing at all.
 *
 * The rule these tests pin: a message the server can prove is a correction is
 * never consumed as an answer to the previous prompt, and it is resolved
 * against real availability at whatever rung it arrives on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";

/** The draft under discussion, and the day "يوم 12" resolves to from 8 Sept. */
const TENTH = "2026-09-10";
const TWELFTH = "2026-09-12";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  setState: vi.fn(),
  audit: vi.fn(),
  slots: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.setState,
  resolvePatientAiContext: vi.fn(),
}));
vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableSlots: mocks.slots,
}));

import { EMPTY_BOOKING_STAGE_STATE, type BookingStageState } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";

const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };
const NOW = new Date("2026-09-08T09:00:00.000Z");

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    bookingIdentityConfirmedAt: null,
    identityLockedUntil: null,
    patientDisplayName: null,
    patientNationalIdSuffix: null,
    clinicName: "Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      doctor_name: "Ahmed Nabil",
      appointment_date: TENTH,
      full_name: "Anas Talal Ali",
      national_id: "29001011234567",
    },
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      stage: "selecting_time" as const,
      beneficiary: "self" as const,
      intakeStaged: true,
      offeredDays: [TENTH],
      // The 10th has a 12:00 on it. That is what made the misread possible.
      offeredSlots: [`${TENTH}T10:00`, `${TENTH}T12:00`],
    } satisfies BookingStageState,
    communicationStyle: {
      locale: "ar" as const,
      arabicDialect: "egyptian" as const,
      tone: "friendly" as const,
      styleInstruction: null,
    },
    ...overrides,
  };
}

function available(date: string, slots: string[]) {
  return {
    ok: true as const,
    doctorId: DOCTOR,
    doctorName: "Ahmed Nabil",
    date,
    availableSlots: slots,
    availabilityReason: "available",
    workingHours: [],
  };
}

/** Every collected patch the turn wrote, in write order. */
function writes(): Record<string, unknown>[] {
  return mocks.setState.mock.calls
    .map(([input]) => (input as { collected?: Record<string, unknown> }).collected)
    .filter((patch): patch is Record<string, unknown> => Boolean(patch));
}

/** The patches merged, i.e. the state the next turn would read. */
function collected(): Record<string, unknown> {
  return Object.assign({}, ...writes());
}

/**
 * Every stage outcome the turn recorded.
 *
 * The merged collected state is not enough to catch this defect: the turn
 * wrongly committed 12:00 on the 10th and *then* moved the day, so the final
 * merge looked correct while an intermediate write had already put the booking
 * on a slot the patient never asked for. In production that intermediate write
 * is the whole bug — when the corrected day's schedule cannot be read the
 * amendment bails out and the wrong commit is what survives.
 */
function outcomes(): string[] {
  return mocks.setState.mock.calls
    .map(([input]) => (input as { stage?: { lastToolOutcome?: { outcome?: string } } }).stage)
    .map((stage) => stage?.lastToolOutcome?.outcome)
    .filter((outcome): outcome is string => typeof outcome === "string");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue(identity());
  mocks.slots.mockResolvedValue(available(TWELFTH, ["09:00", "13:00"]));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A — the reported ordering bug
// ---------------------------------------------------------------------------

describe("a day correction is never read as a time on the old day", () => {
  it("does not turn «لا أنا عايز يوم 12» into 12:00 on the 10th", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    // Not one write, at any point in the turn, may put the booking on the hour
    // that happens to share the corrected day's number.
    expect(writes().some((patch) => patch.appointment_time === 12 * 60)).toBe(false);
    expect(outcomes()).not.toContain("time_selected");
  });

  it("does not commit anything on the old day when the corrected day cannot be read", async () => {
    // The production failure. The schedule read fails, the amendment bails out
    // — and whatever the pre-commit had already written is what the patient is
    // left holding. It must have written nothing.
    mocks.slots.mockRejectedValue(new Error("schedule unavailable"));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    expect(writes().some((patch) => patch.appointment_time === 12 * 60)).toBe(false);
    expect(outcomes()).not.toContain("time_selected");
  });

  it("resolves the day the patient actually named, against real availability", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    // The doctor's own schedule for the 12th is read before anything moves.
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: TWELFTH }),
    );
    expect(collected().appointment_date).toBe(TWELFTH);
  });

  it("keeps the doctor, the department and the intake across the correction", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    const written = collected();
    expect(written.doctor_id).toBeUndefined();
    expect(written.department_id).toBeUndefined();
    expect(written.full_name).toBeUndefined();
  });

  it("reads «لا قصدي يوم 12» the same way", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا قصدي يوم 12",
      conversationEscalated: false,
    });
    expect(collected().appointment_date).toBe(TWELFTH);
  });

  it("reads «غيرت رأيي، عايز يوم 12» the same way", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "غيرت رأيي، عايز يوم 12",
      conversationEscalated: false,
    });
    expect(collected().appointment_date).toBe(TWELFTH);
  });

  it("reads «No, I meant day 12» the same way", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "No, I meant day 12",
      conversationEscalated: false,
    });
    expect(collected().appointment_date).toBe(TWELFTH);
  });
});

// ---------------------------------------------------------------------------
// B — the correction reaches the schedule at a non-confirm rung
// ---------------------------------------------------------------------------

describe("a correction is resolved at whatever rung it arrives on", () => {
  it("commits the only free time on the corrected day", async () => {
    mocks.slots.mockResolvedValue(available(TWELFTH, ["13:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    const written = collected();
    expect(written.appointment_date).toBe(TWELFTH);
    expect(written.appointment_time).toBe(13 * 60);
  });

  it("clears the old time rather than carrying it onto the new day", async () => {
    // Two free times on the 12th: the patient must choose, and the time they
    // held on the 10th must not survive the move.
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    expect(collected().appointment_time).toBe("");
  });

  it("says so plainly when the corrected day has nothing free, and moves nothing", async () => {
    mocks.slots.mockResolvedValue(available(TWELFTH, []));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أنا عايز يوم 12",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment?.kind).toBe("unavailable");
    expect(collected().appointment_date).not.toBe(TWELFTH);
  });
});

// ---------------------------------------------------------------------------
// C — what is deliberately NOT a correction
// ---------------------------------------------------------------------------

describe("ordinary answers are untouched", () => {
  it("still commits a bare offered time", async () => {
    mocks.slots.mockResolvedValue(available(TENTH, ["10:00", "12:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "12",
      conversationEscalated: false,
    });
    expect(outcomes()).toContain("time_selected");
    expect(collected().appointment_time).toBe(12 * 60);
    expect(collected().appointment_date).not.toBe(TWELFTH);
  });

  it("still commits an explicit offered clock time", async () => {
    mocks.slots.mockResolvedValue(available(TENTH, ["10:00", "12:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الساعة 12",
      conversationEscalated: false,
    });
    expect(outcomes()).toContain("time_selected");
    expect(collected().appointment_time).toBe(12 * 60);
  });

  it("still commits the earlier offered time", async () => {
    mocks.slots.mockResolvedValue(available(TENTH, ["10:00", "12:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الساعة 10",
      conversationEscalated: false,
    });
    expect(outcomes()).toContain("time_selected");
    expect(collected().appointment_time).toBe(10 * 60);
  });

  it("does not treat a plain confirmation as a correction", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "اه تمام موافق",
      conversationEscalated: false,
    });
    expect(outcomes()).not.toContain("time_selected");
  });
});

// ---------------------------------------------------------------------------
// D — the rest of the invalidation table
//
// Department and doctor changes are certified by
// `p11f-booking-forward-progress.test.ts` ("an explicit department change is
// allowed and clears what it invalidates", "an explicit doctor change is
// allowed and keeps the department") and are deliberately not repeated here.
// What follows are the rows that had no test.
// ---------------------------------------------------------------------------

describe("an AM/PM correction moves the hour and nothing else", () => {
  /** A finished draft: 10:00 on the 10th, under review. */
  function reviewing() {
    return identity({
      collectedData: {
        department_id: DEPARTMENT,
        doctor_id: DOCTOR,
        doctor_name: "Ahmed Nabil",
        appointment_date: TENTH,
        appointment_time: 10 * 60,
        full_name: "Anas Talal Ali",
        national_id: "29001011234567",
      },
      bookingStage: {
        ...EMPTY_BOOKING_STAGE_STATE,
        stage: "confirming" as const,
        beneficiary: "self" as const,
        intakeStaged: true,
        offeredDays: [TENTH],
        offeredSlots: [`${TENTH}T10:00`],
      } satisfies BookingStageState,
    });
  }

  it("keeps the day and the doctor, and recomputes the hour against the schedule", async () => {
    mocks.authorize.mockResolvedValue(reviewing());
    mocks.slots.mockResolvedValue(available(TENTH, ["10:00", "22:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا قصدي 10 بالليل",
      conversationEscalated: false,
    });
    // The same day, read again for the same doctor.
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: TENTH }),
    );
    const written = collected();
    expect(written.appointment_date).toBe(TENTH);
    expect(written.appointment_time).toBe(22 * 60);
    // Nothing upstream of the hour was rewritten.
    expect(written.doctor_id).toBeUndefined();
    expect(written.department_id).toBeUndefined();
    expect(written.full_name).toBeUndefined();
  });

  it("never offers an hour the doctor does not have free", async () => {
    mocks.authorize.mockResolvedValue(reviewing());
    mocks.slots.mockResolvedValue(available(TENTH, ["10:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا قصدي 10 بالليل",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment?.kind).toBe("unavailable");
    expect(collected().appointment_time).not.toBe(22 * 60);
  });
});

describe("a correction the amendment reader owns nothing of changes nothing", () => {
  it("leaves the booking alone for a name correction", async () => {
    // A name is not a day and not an hour. The amendment reader must decline
    // it rather than reach for the schedule — the intake path owns names.
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا قصدي اسمي أنس طلال",
      conversationEscalated: false,
    });
    expect(mocks.slots).not.toHaveBeenCalled();
    expect(writes().some((patch) => "appointment_date" in patch)).toBe(false);
  });

  it("leaves the booking alone for a phone correction", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا قصدي رقمي 01000000001",
      conversationEscalated: false,
    });
    expect(writes().some((patch) => "appointment_date" in patch)).toBe(false);
  });
});
