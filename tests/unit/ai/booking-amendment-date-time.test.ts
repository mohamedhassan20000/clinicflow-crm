/**
 * "خليه يوم 16 الساعة 10" — a date and a time, at the booking review.
 *
 * Manual QA found this answered with the whole day's slot list. The patient had
 * already named the day *and* the hour; listing everything throws both away.
 * These tests pin the deterministic behaviour: resolve the day, resolve the
 * hour, check that exact slot for the same doctor, and either return the review
 * with the new values or say plainly that it is not free.
 *
 * The AM/PM question is the one thing left to ask, and only when the doctor's
 * own schedule genuinely has both readings free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const OTHER_DOCTOR = "55555555-5555-4555-8555-555555555555";

/** The draft under review, and the day "يوم 16" resolves to from 8 September. */
const DATE = "2026-09-09";
const SIXTEENTH = "2026-09-16";

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
import { buildBookingMeridiemQuestionReply } from "@/lib/ai/patient-booking-confirmation";

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
    clinicName: "Generated Test Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      doctor_name: "Ahmed Nabil",
      appointment_date: DATE,
      appointment_time: 15 * 60 + 15,
      full_name: "Anas Talal Ali",
      national_id: "29001011234567",
    },
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      stage: "confirming" as const,
      beneficiary: "self" as const,
      intakeStaged: true,
      offeredSlots: [`${DATE}T15:15`],
      offeredDays: [DATE],
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

const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

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

function collectedWrites() {
  return mocks.setState.mock.calls
    .map(([input]) => (input as { collected?: Record<string, unknown> }).collected)
    .filter(Boolean) as Record<string, unknown>[];
}

function persistedStage(): Record<string, unknown> | null {
  const writes = mocks.setState.mock.calls
    .map(([input]) => (input as { stage?: Record<string, unknown> }).stage)
    .filter(Boolean) as Record<string, unknown>[];
  return writes.length > 0 ? writes[writes.length - 1]! : null;
}

/** A fixed 8 September 2026, so "يوم 16" has one answer. */
const NOW = new Date("2026-09-08T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(identity());
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("C1 — a date and an unambiguous time", () => {
  it("checks that exact slot and returns the review, with no slot list", async () => {
    mocks.slots.mockResolvedValue(
      available(SIXTEENTH, ["10:00", "11:00", "16:00", "17:00"]),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 4 مساء",
      conversationEscalated: false,
    });

    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: SIXTEENTH }),
    );
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: SIXTEENTH,
      time: "16:00",
    });
    // The defect this whole pass exists for: no day-long slot dump.
    expect(turn.bookingAmendment?.kind).not.toBe("choose_time");
    expect(collectedWrites()).toContainEqual({
      appointment_date: SIXTEENTH,
      appointment_time: 16 * 60,
    });
  });

  it("resolves 'يوم 16 الساعة 10 صباحًا' the same way", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00", "11:00", "22:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10 صباحًا",
      conversationEscalated: false,
    });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: SIXTEENTH,
      time: "10:00",
    });
  });
});

describe("C3 — availability removes the fake ambiguity", () => {
  it("resolves to the morning when only the morning is bookable", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00", "11:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toMatchObject({ date: SIXTEENTH, time: "10:00" });
  });

  it("resolves to the evening when only the evening is bookable", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["21:00", "22:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toMatchObject({ date: SIXTEENTH, time: "22:00" });
  });

  it("says the time is unavailable, and keeps the draft, when neither is bookable", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["11:00", "12:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({
      kind: "unavailable",
      value: { doctorName: "Ahmed Nabil", date: SIXTEENTH },
    });
    // The booking they were reviewing is exactly as it was.
    expect(collectedWrites()).toEqual([]);
  });
});

describe("C2 — a genuinely ambiguous clock time", () => {
  it("asks only the AM/PM question and touches nothing", async () => {
    mocks.slots.mockResolvedValue(
      available(SIXTEENTH, ["10:00", "11:00", "21:00", "22:00"]),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10",
      conversationEscalated: false,
    });

    expect(turn.bookingAmendment).toEqual({
      kind: "clarify_meridiem",
      value: { date: SIXTEENTH, times: ["10:00", "22:00"] },
    });
    // Not a slot dump, and not a silent choice.
    expect(collectedWrites()).toEqual([]);
    // The requested day is carried forward, so the answer lands on it.
    expect(persistedStage()).toMatchObject({
      pendingAmendmentTime: { date: SIXTEENTH, times: ["10:00", "22:00"] },
    });
  });

  it("asks the question in the patient's own terms", () => {
    const reply = buildBookingMeridiemQuestionReply("ar", { times: ["10:00", "22:00"] });
    expect(reply).toBe("تقصد 10:00 صباحًا ولا 10:00 مساءً؟");
    expect(buildBookingMeridiemQuestionReply("en", { times: ["10:00", "22:00"] })).toBe(
      "Did you mean 10:00 AM or 10:00 PM?",
    );
  });

  it("resolves 'الصبح' against the pending question without restarting anything", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "self" as const,
          intakeStaged: true,
          offeredSlots: [`${DATE}T15:15`, `${SIXTEENTH}T10:00`, `${SIXTEENTH}T22:00`],
          offeredDays: [DATE, SIXTEENTH],
          pendingAmendmentTime: { date: SIXTEENTH, times: ["10:00", "22:00"] },
        },
      }),
    );
    mocks.slots.mockResolvedValue(
      available(SIXTEENTH, ["10:00", "11:00", "21:00", "22:00"]),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الصبح",
      conversationEscalated: false,
    });

    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: SIXTEENTH }),
    );
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: SIXTEENTH,
      time: "10:00",
    });
    expect(persistedStage()).toMatchObject({ pendingAmendmentTime: null });
  });

  it("resolves 'بالليل' to the evening reading", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "self" as const,
          intakeStaged: true,
          offeredSlots: [`${DATE}T15:15`],
          offeredDays: [DATE],
          pendingAmendmentTime: { date: SIXTEENTH, times: ["10:00", "22:00"] },
        },
      }),
    );
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00", "22:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "بالليل",
      conversationEscalated: false,
    });
    expect(turn.bookingConfirmation).toMatchObject({ date: SIXTEENTH, time: "22:00" });
  });

  it("keeps the draft when the clarified slot turns out to be taken", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "self" as const,
          intakeStaged: true,
          offeredSlots: [`${DATE}T15:15`],
          offeredDays: [DATE],
          pendingAmendmentTime: { date: SIXTEENTH, times: ["10:00", "22:00"] },
        },
      }),
    );
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["11:00", "22:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الصبح",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({
      kind: "unavailable",
      value: { date: SIXTEENTH, requestedTime: "10:00" },
    });
    expect(collectedWrites()).toEqual([]);
  });
});

describe("D — a date on its own does show that day's times", () => {
  it("moves the day and lists the authoritative slots", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00", "11:00", "16:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "غيره ليوم 16",
      conversationEscalated: false,
    });
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: SIXTEENTH }),
    );
    expect(turn.bookingAmendment).toMatchObject({
      kind: "choose_time",
      value: { doctorName: "Ahmed Nabil", date: SIXTEENTH, slots: ["10:00", "11:00", "16:00"] },
    });
  });
});

describe("E — a time on its own keeps the day", () => {
  it("re-checks the same doctor on the same day", async () => {
    mocks.slots.mockResolvedValue(available(DATE, ["15:15", "16:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4",
      conversationEscalated: false,
    });
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: DATE }),
    );
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: DATE,
      time: "16:00",
    });
  });
});

describe("F — nothing here is a confirmation, and nothing here is a doctor change", () => {
  it("never authorizes a booking write on an amendment turn", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10 صباحًا",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
    expect(turn.informationalTools).toEqual([]);
  });

  it("holds the doctor, the department and the intake invariant", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "other" as const,
          bookingForOther: true,
          intakeStaged: true,
          offeredDoctorIds: [DOCTOR, OTHER_DOCTOR],
          offeredSlots: [`${DATE}T15:15`],
          offeredDays: [DATE],
        },
      }),
    );
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10 صباحًا",
      conversationEscalated: false,
    });
    expect(mocks.slots).toHaveBeenCalledWith(expect.objectContaining({ doctorId: DOCTOR }));
    for (const write of collectedWrites()) {
      expect(Object.keys(write).sort()).toEqual(["appointment_date", "appointment_time"]);
    }
    expect(persistedStage()).toMatchObject({
      beneficiary: "other",
      bookingForOther: true,
      intakeStaged: true,
    });
  });

  it("produces one draft, not two bookings, when amended twice", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["10:00"]));
    for (let i = 0; i < 2; i += 1) {
      const turn = await openBookingStageTurn(ctx, "patient_booking", {
        latestPatientText: "خليه يوم 16 الساعة 10 صباحًا",
        conversationEscalated: false,
      });
      expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
    }
    for (const write of collectedWrites()) {
      expect(write).toEqual({
        appointment_date: SIXTEENTH,
        appointment_time: 10 * 60,
      });
    }
  });
});

describe("picking one of the alternatives offered on the requested day", () => {
  it("remembers which day the alternatives were on", async () => {
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["11:00", "12:00"]));
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 16 الساعة 10 صباحًا",
      conversationEscalated: false,
    });
    expect(persistedStage()).toMatchObject({
      pendingAmendmentTime: { date: SIXTEENTH, times: ["11:00", "12:00"] },
    });
  });

  it("lands the pick on that day, not on the day the draft still holds", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "self" as const,
          intakeStaged: true,
          offeredSlots: [`${DATE}T15:15`],
          offeredDays: [DATE],
          pendingAmendmentTime: { date: SIXTEENTH, times: ["11:00", "12:00"] },
        },
      }),
    );
    mocks.slots.mockResolvedValue(available(SIXTEENTH, ["11:00", "12:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "11:00",
      conversationEscalated: false,
    });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: SIXTEENTH,
      time: "11:00",
    });
  });
});
