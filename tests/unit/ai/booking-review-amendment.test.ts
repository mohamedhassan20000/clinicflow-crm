/**
 * Editing the booking that is sitting in the final review, in place.
 *
 * The review — «راجع تفاصيل طلب الحجز… هل تؤكد؟» — is preserved exactly. What
 * these tests pin is the other answer to it: a patient who moves the day or the
 * time gets the same review back with the new values, keeps the same doctor and
 * the same patient, and has nothing written to the appointments table until they
 * confirm in so many words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const OTHER_DOCTOR = "55555555-5555-4555-8555-555555555555";
const DATE = "2026-09-09";

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

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";
import { buildBookingAmendmentReply } from "@/lib/ai/patient-booking-confirmation";

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
      // The intake was staged in *this* conversation: a provisional patient.
      intakeStaged: true,
      offeredSlots: [`${DATE}T15:15`],
      offeredDays: [DATE],
    },
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

// A fixed Tuesday, so "الخميس" is a day this test can name.
const NOW = new Date("2026-09-08T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(identity());
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.slots.mockResolvedValue(available(DATE, ["15:15", "16:00", "16:15", "16:30"]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("time change from the review", () => {
  it("moves the draft and returns the same review with the new time", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4 بدل 3:15",
      conversationEscalated: false,
    });

    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: DATE,
      time: "16:00",
    });
    expect(collectedWrites()).toContainEqual({
      appointment_date: DATE,
      appointment_time: 16 * 60,
    });
  });

  it("re-checks availability for the same doctor and never another one", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "ممكن الساعة 4؟",
      conversationEscalated: false,
    });
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: DATE }),
    );
    for (const write of collectedWrites()) {
      expect(write.doctor_id).toBeUndefined();
      expect(write.department_id).toBeUndefined();
      expect(write.full_name).toBeUndefined();
    }
  });

  it("writes nothing and mounts nothing that could create a booking", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4 بدل 3:15",
      conversationEscalated: false,
    });
    // No tool at all is mounted on an amendment turn, so no path to a write.
    expect(turn.informationalTools).toEqual([]);
    expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
  });

  it("offers real alternatives, and keeps the draft, when the time is taken", async () => {
    mocks.slots.mockResolvedValue(available(DATE, ["15:15", "16:15", "16:30"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4 بدل 3:15",
      conversationEscalated: false,
    });

    expect(turn.bookingAmendment).toMatchObject({
      kind: "unavailable",
      value: { doctorName: "Ahmed Nabil", date: DATE, requestedTime: "16:00" },
    });
    expect(
      turn.bookingAmendment?.kind === "unavailable" && turn.bookingAmendment.value.slots,
    ).toEqual(["15:15", "16:15", "16:30"]);
    // The booking they were reviewing is untouched.
    expect(collectedWrites()).toEqual([]);
  });
});

describe("date change from the review", () => {
  const NEXT = "2026-09-10";

  it("keeps the doctor, moves the day, and offers that day's times", async () => {
    mocks.slots.mockResolvedValue(available(NEXT, ["10:00", "10:30", "11:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 10 سبتمبر",
      conversationEscalated: false,
    });

    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR, date: NEXT }),
    );
    expect(turn.bookingAmendment).toMatchObject({
      kind: "choose_time",
      value: { doctorName: "Ahmed Nabil", date: NEXT },
    });
    // The day is settled; the time is cleared so the next message is read as a
    // time on the *new* day rather than the old one.
    expect(collectedWrites()).toContainEqual({
      appointment_date: NEXT,
      appointment_time: "",
    });
  });

  it("commits straight back to the review when the new day has one free time", async () => {
    mocks.slots.mockResolvedValue(available(NEXT, ["10:00"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه يوم 10 سبتمبر",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: NEXT,
      time: "10:00",
    });
  });

  it("changes a day and a time in one sentence", async () => {
    mocks.slots.mockResolvedValue(available(NEXT, ["16:00", "17:00", "17:30"]));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليها الخميس الساعة 5",
      conversationEscalated: false,
    });
    expect(turn.bookingConfirmation).toEqual({
      doctorName: "Ahmed Nabil",
      date: NEXT,
      time: "17:00",
    });
  });
});

describe("confirmation is still required, and still explicit", () => {
  it("treats a bare confirmation as a confirmation, not an amendment", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "أيوه",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toBeNull();
    expect(turn.authority).toMatchObject({ operation: "create_preliminary_booking" });
  });

  it("does not read a time change as permission to submit", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "غيرها للساعة 4",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
  });

  it("is idempotent: the same inbound twice leaves one draft and no booking", async () => {
    for (let i = 0; i < 2; i += 1) {
      const turn = await openBookingStageTurn(ctx, "patient_booking", {
        latestPatientText: "خليه الساعة 4 بدل 3:15",
        conversationEscalated: false,
      });
      expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
    }
    for (const write of collectedWrites()) {
      expect(write).toEqual({ appointment_date: DATE, appointment_time: 16 * 60 });
    }
  });
});

describe("the amendment reply is the review, with an acknowledgement", () => {
  it("repeats every line of the review with the new values", () => {
    const reply = buildBookingAmendmentReply("ar", {
      doctorName: "Ahmed Nabil",
      date: DATE,
      time: "16:00",
    });
    expect(reply).toContain("عدّلت الموعد");
    expect(reply).toContain("راجع تفاصيل طلب الحجز");
    expect(reply).toContain("Ahmed Nabil");
    expect(reply).toContain("طلب حجز منتظر تأكيد العيادة");
    expect(reply).toContain("هل تؤكد إرسال الطلب بهذه التفاصيل؟");
  });
});

describe("nothing about the amendment can change the doctor", () => {
  it("never writes a doctor id, even when another one exists", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DEPARTMENT,
          doctor_id: DOCTOR,
          doctor_name: "Ahmed Nabil",
          appointment_date: DATE,
          appointment_time: 15 * 60 + 15,
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          intakeStaged: true,
          offeredDoctorIds: [DOCTOR, OTHER_DOCTOR],
          offeredSlots: [`${DATE}T15:15`],
          offeredDays: [DATE],
        },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4",
      conversationEscalated: false,
    });
    expect(mocks.slots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOCTOR }),
    );
    for (const write of collectedWrites()) {
      expect(Object.keys(write).sort()).toEqual(["appointment_date", "appointment_time"]);
    }
  });
});
