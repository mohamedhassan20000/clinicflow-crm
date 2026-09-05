/**
 * Item #6 — the same rule, driven through the real turn opener.
 *
 * `item6-confirmation-prerequisites.test.ts` pins the ladder as a pure
 * function. This file pins the *wiring*: that the turn opener actually reads
 * the live staged-file fact and that a third-party booking with no staged file
 * is asked for the missing thing instead of for a confirmation it cannot honour.
 *
 * Without this the pure test would keep passing while the fact was never
 * supplied in production, which is exactly the shape of the original defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const DATE = "2026-09-10";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  setState: vi.fn(),
  audit: vi.fn(),
  slots: vi.fn(),
  pendingIntake: vi.fn(),
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
  getPendingConversationIntake: mocks.pendingIntake,
}));
vi.mock("@/lib/booking/patient", () => ({ getPatientAvailableSlots: mocks.slots }));

import { EMPTY_BOOKING_STAGE_STATE, type BookingStageState } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";

const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };
const NOW = new Date("2026-09-08T09:00:00.000Z");

/** A third-party booking with every scheduling field settled and the latch set. */
function thirdPartyReadyToConfirm(stage: Partial<BookingStageState> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: "66666666-6666-4666-8666-666666666666",
    linked: true,
    identityVerifiedAt: "2026-09-01T08:00:00.000Z",
    bookingIdentityConfirmedAt: "2026-09-01T08:00:00.000Z",
    identityLockedUntil: null,
    patientDisplayName: "Anas Talal Ali",
    patientNationalIdSuffix: "4567",
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
      appointment_date: DATE,
      appointment_time: 10 * 60,
    },
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      stage: "confirming" as const,
      beneficiary: "other" as const,
      bookingForOther: true,
      // The latch register_patient sets — including on `linked_existing`,
      // which creates no intake row at all. This is the QA state.
      intakeStaged: true,
      offeredDays: [DATE],
      offeredSlots: [`${DATE}T10:00`],
      ...stage,
    } satisfies BookingStageState,
    communicationStyle: {
      locale: "ar" as const,
      arabicDialect: "egyptian" as const,
      tone: "friendly" as const,
      styleInstruction: null,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.slots.mockResolvedValue({
    ok: true,
    doctorId: DOCTOR,
    doctorName: "Ahmed Nabil",
    date: DATE,
    availableSlots: ["10:00"],
    availabilityReason: "available",
    workingHours: [],
  });
  mocks.authorize.mockResolvedValue(thirdPartyReadyToConfirm());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a third-party booking with no staged file", () => {
  beforeEach(() => {
    // No `ai_patient_intakes` row: exactly what the write refuses on.
    mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  });

  it("asks for the intake instead of asking for a confirmation", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "تمام كده",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "intake" });
    expect(turn.authority?.reason).not.toBe("needs_booking_confirmation");
    expect(turn.bookingConfirmation).toBeNull();
  });

  it("does not hand a confirmation write authority when the patient says «موافق»", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "موافق",
      conversationEscalated: false,
    });
    // The loop was: confirm → write refuses → review again. There is no review
    // to come back to now, because the rung is the missing thing itself.
    expect(turn.authority?.operation).not.toBe("create_preliminary_booking");
    expect(turn.authority).toMatchObject({ step: "intake" });
  });

  it("reads the same row the write reads, for this conversation and clinic", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "موافق",
      conversationEscalated: false,
    });
    expect(mocks.pendingIntake).toHaveBeenCalledWith({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
    });
  });
});

describe("a third-party booking whose file really is staged", () => {
  beforeEach(() => {
    mocks.pendingIntake.mockResolvedValue({
      data: { id: "intake-1", is_third_party: true },
      error: null,
    });
  });

  it("reaches the confirmation, exactly as before", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "تمام كده",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "confirm" });
  });

  it("hands write authority once the patient confirms", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "اه تمام موافق",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({
      step: "confirm",
      requirement: "write_authority",
      operation: "create_preliminary_booking",
    });
  });
});

describe("failure and non-third-party paths are unchanged", () => {
  it("does not send the patient back to intake when the row cannot be read", async () => {
    // An unreadable row is not evidence the file is missing. Sending somebody
    // back to re-enter details they already gave is its own defect.
    mocks.pendingIntake.mockResolvedValue({ data: null, error: { message: "boom" } });
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "تمام كده",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "confirm" });
  });

  it("does not read the row at all for a booking the sender is making for themself", async () => {
    mocks.authorize.mockResolvedValue({
      ...thirdPartyReadyToConfirm(),
      bookingStage: {
        ...thirdPartyReadyToConfirm().bookingStage,
        beneficiary: "self" as const,
        bookingForOther: false,
      },
    });
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "تمام كده",
      conversationEscalated: false,
    });
    expect(mocks.pendingIntake).not.toHaveBeenCalled();
    expect(turn.authority).toMatchObject({ step: "confirm" });
  });

  it("keeps a submitted booking terminal rather than re-asking anything", async () => {
    mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
    mocks.authorize.mockResolvedValue(thirdPartyReadyToConfirm({ submitted: true }));
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "موافق",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "done" });
    expect(turn.bookingConfirmation).toBeNull();
  });
});
