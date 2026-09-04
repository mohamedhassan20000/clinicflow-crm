/**
 * Who the appointment is for, as distinct from who is holding the phone.
 *
 * A WhatsApp thread linked to a patient file proves the sender's identity and
 * nothing else. These tests pin that the beneficiary is established from the
 * patient's own words, that it is asked exactly once when they have not said,
 * that it is never asked when they already have, and that it survives the whole
 * booking — doctor, day, time and every amendment to the review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
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

import { detectBookingBeneficiary } from "@/lib/ai/booking-beneficiary";
import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";

/** A sender the clinic has authoritatively linked to a patient file. */
function linkedIdentity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: PATIENT,
    linked: true,
    identityVerifiedAt: null,
    bookingIdentityConfirmedAt: null,
    identityLockedUntil: null,
    patientDisplayName: "Anas Talal Ali",
    patientNationalIdSuffix: "4567",
    clinicName: "Generated Test Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {},
    pendingClarification: null,
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE },
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

/** The stage record the turn persisted, as the next turn would read it. */
function persistedStage(): Record<string, unknown> | null {
  const writes = mocks.setState.mock.calls
    .map(([input]) => (input as { stage?: Record<string, unknown> }).stage)
    .filter(Boolean) as Record<string, unknown>[];
  return writes.length > 0 ? writes[writes.length - 1]! : null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T09:00:00.000Z"));
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(linkedIdentity());
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.slots.mockResolvedValue({
    ok: true as const,
    doctorId: DOCTOR,
    doctorName: "Ahmed Nabil",
    date: DATE,
    availableSlots: ["10:00", "16:00"],
    availabilityReason: "available",
    workingHours: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the beneficiary out of one message", () => {
  it("reads an explicit third-party booking", () => {
    for (const text of [
      "عايز احجز لصاحبي",
      "الحجز لمراتي",
      "عايز احجز لابني",
      "احجزلي لوالدتي من فضلك",
      "book for my friend",
      "I want to book for someone else",
    ]) {
      expect(detectBookingBeneficiary(text), text).toBe("other");
    }
  });

  it("reads an explicit booking for the sender", () => {
    for (const text of ["ليا", "الحجز ليا", "لنفسي", "أنا", "for me", "it's for myself"]) {
      expect(detectBookingBeneficiary(text), text).toBe("self");
    }
  });

  it("says nothing about a message that does not say", () => {
    expect(detectBookingBeneficiary("عايز احجز")).toBeNull();
    expect(detectBookingBeneficiary("I want an appointment")).toBeNull();
    expect(detectBookingBeneficiary("")).toBeNull();
  });

  it("does not read a relationship word without a beneficiary preposition", () => {
    // A sentence *about* someone is not an instruction to book for them.
    expect(detectBookingBeneficiary("مراتي تعبانة من امبارح")).toBeNull();
  });

  it("reads a third-party booking even when the sentence starts with 'أنا'", () => {
    expect(detectBookingBeneficiary("أنا عايز احجز لمراتي")).toBe("other");
  });
});

describe("a linked sender is still asked who the booking is for", () => {
  it("asks once on a generic booking request, despite the linkage", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عايز احجز",
      conversationEscalated: false,
    });
    expect(turn.briefing).toContain("الحجز ليك ولا لشخص تاني؟");
    // The identity confirmation must not ride along in the same message: an
    // «أيوه» to that pair would answer one question and be recorded as both.
    expect(turn.briefing).not.toContain("مرتبطة بملف باسم");
    expect(persistedStage()).toMatchObject({ beneficiary: null, bookingForOther: false });
  });

  it("does not ask when the message already said it is for somebody else", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عايز احجز لصاحبي",
      conversationEscalated: false,
    });
    expect(turn.briefing ?? "").not.toContain("الحجز ليك ولا لشخص تاني؟");
    expect(persistedStage()).toMatchObject({ beneficiary: "other", bookingForOther: true });
  });

  it("collects that person's own details rather than the sender's", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الحجز لمراتي",
      conversationEscalated: false,
    });
    // `bookingForOther` puts the ladder on the intake rung even though the
    // sender has a file of their own.
    expect(persistedStage()).toMatchObject({ bookingForOther: true });
    expect(turn.briefing).toContain("الناقص فعلًا لفتح الملف");
  });

  it("answers 'لشخص تاني' to the question by opening a third-party intake", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لشخص تاني",
      conversationEscalated: false,
    });
    expect(persistedStage()).toMatchObject({ beneficiary: "other", bookingForOther: true });
    expect(turn.briefing ?? "").not.toContain("الحجز ليك ولا لشخص تاني؟");
  });

  it("answers 'ليا' by using the linked file and asking for no intake again", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "ليا",
      conversationEscalated: false,
    });
    expect(persistedStage()).toMatchObject({ beneficiary: "self", bookingForOther: false });
    expect(turn.briefing ?? "").not.toContain("الحجز ليك ولا لشخص تاني؟");
    // A linked patient already has a file. Nothing about it is re-collected.
    expect(turn.briefing ?? "").not.toContain("الناقص فعلًا لفتح الملف");
  });

  it("never infers 'self' from the linkage alone", async () => {
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عايز احجز",
      conversationEscalated: false,
    });
    expect(persistedStage()).toMatchObject({ beneficiary: null });
  });
});

describe("the beneficiary survives the rest of the booking", () => {
  it("is not re-asked once the booking has moved on to a doctor and a day", async () => {
    mocks.authorize.mockResolvedValue(
      linkedIdentity({
        collectedData: {
          department_id: DEPARTMENT,
          doctor_id: DOCTOR,
          doctor_name: "Ahmed Nabil",
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "selecting_day" as const,
          beneficiary: "other" as const,
          bookingForOther: true,
          intakeStaged: true,
        },
      }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "يوم 16 الجاي",
      conversationEscalated: false,
    });
    expect(turn.briefing ?? "").not.toContain("الحجز ليك ولا لشخص تاني؟");
    expect(persistedStage()).toMatchObject({ beneficiary: "other", bookingForOther: true });
  });

  it("survives an amendment to the booking review", async () => {
    mocks.authorize.mockResolvedValue(
      linkedIdentity({
        collectedData: {
          department_id: DEPARTMENT,
          doctor_id: DOCTOR,
          doctor_name: "Ahmed Nabil",
          appointment_date: DATE,
          appointment_time: 10 * 60,
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "confirming" as const,
          beneficiary: "other" as const,
          bookingForOther: true,
          intakeStaged: true,
          offeredSlots: [`${DATE}T10:00`],
          offeredDays: [DATE],
        },
      }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه الساعة 4 العصر",
      conversationEscalated: false,
    });
    expect(turn.bookingAmendment).toMatchObject({ kind: "updated" });
    expect(persistedStage()).toMatchObject({ beneficiary: "other", bookingForOther: true });
    // Nothing about the person being booked for was touched.
    for (const [input] of mocks.setState.mock.calls) {
      const collected = (input as { collected?: Record<string, unknown> }).collected;
      if (!collected) continue;
      expect(collected.full_name).toBeUndefined();
      expect(collected.doctor_id).toBeUndefined();
    }
  });
});

describe("a stranger's very first message", () => {
  it("establishes a third-party booking before anything is collected", async () => {
    mocks.authorize.mockResolvedValue(
      linkedIdentity({
        patientId: null,
        linked: false,
        patientDisplayName: null,
        patientNationalIdSuffix: null,
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عايز احجز لصاحبي",
      conversationEscalated: false,
    });
    expect(persistedStage()).toMatchObject({ beneficiary: "other", bookingForOther: true });
  });
});
