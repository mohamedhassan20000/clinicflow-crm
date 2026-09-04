/**
 * P9C — "ممكن احجز موعد لصاحبي".
 *
 * The opening line of production conversation 763b1c6b, and a request the
 * system had no way to represent. The assistant did the sensible thing — it
 * asked for the friend's name, national id, date of birth and email, and the
 * patient gave all four — and then there was nowhere to put any of it:
 * `register_patient` returns `already_linked` on a linked conversation, the
 * staging RPC refuses one outright, and the provisional booking RPC requires
 * `patient_id is null`. `ai_patient_intakes` was empty for that conversation
 * afterwards. The only thing the system could still have done with a day and a
 * time was create the appointment under the *sender's* record.
 *
 * These are the four claims that make that impossible rather than unlikely:
 *
 *   1. a linked sender *can* stage somebody else, and it is staged for review
 *      like any other intake — never created;
 *   2. the friend's details are read from what was said about the friend, never
 *      from the sender's collected state;
 *   3. booking for somebody with no staged file is a recoverable "stage them
 *      first", not a failed write and not a booking; and
 *   4. once staged, the appointment goes down the provisional path — the
 *      sender's patient record is never the subject.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "763b1c6b-c388-4f36-b8ca-965f71f20f86";
const DERMATOLOGY = "dddddddd-0000-4000-8000-000000000001";
const NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const SENDER = "bbbbbbbb-0000-4000-8000-000000000001";
const INTAKE = "eeeeeeee-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  directory: vi.fn(),
  persist: vi.fn().mockResolvedValue({ data: null, error: null }),
  clinicInfo: vi.fn().mockResolvedValue({ data: { phone: null }, error: null }),
  stageIntake: vi.fn(),
  pendingIntake: vi.fn().mockResolvedValue({ data: null, error: null }),
  createBooking: vi.fn(),
  availableSlots: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  getPatientClinicPublicInfo: mocks.clinicInfo,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  getPendingConversationIntake: mocks.pendingIntake,
  createClinicScopedAdminClient: () => {
    throw new Error("no table access is expected on these paths");
  },
}));
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/booking/patient", () => ({
  createPatientPendingBooking: mocks.createBooking,
  getPatientAvailableSlots: mocks.availableSlots,
  getPatientAvailableDays: vi.fn(),
}));

import {
  deriveStage,
  allowedToolsForStage,
  EMPTY_BOOKING_STAGE_STATE,
  offeredSlotKey,
} from "@/lib/ai/booking-stage";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

/**
 * The sender: a linked, verified patient of this clinic, whose own name and date
 * of birth are already on file for this conversation. That stored state is the
 * trap — it belongs to them, not to the friend they are booking for.
 */
function sender(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: SENDER,
    linked: true,
    identityVerifiedAt: "2026-08-22T19:00:00.000Z",
    identityLockedUntil: null,
    clinicName: "ClinicFlow",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {
      full_name: "محمد حسن",
      date_of_birth: "1995-04-02",
      department_id: DERMATOLOGY,
      doctor_id: NABIL,
    },
    pendingClarification: null,
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, bloodTypeResolved: true },
    ...overrides,
  };
}

/**
 * The friend, exactly as the patient typed them in production.
 *
 * `٣-٢-٢٠٠١` is genuinely ambiguous — 3 February or 2 March — and the resolver
 * is right to ask. What matters here is that asking is a *recoverable* answer
 * with a way forward, not a dead end, and that the answer to it stages the file.
 */
const FRIEND_AS_TYPED = {
  full_name: "على النجار",
  national_id: "٩٩٧٦٥٤٣٨١٢٠",
  date_of_birth: "٣-٢-٢٠٠١",
  email: "Ali-elnajar@clinic.com",
  phone: "٠١٠١٢٣٤٥٦٧٨",
};

/**
 * The same friend after the assistant asked which month they meant — and after
 * it showed them the English spelling of their name.
 *
 * P10 transliterates an Arabic name onto the Latin-script convention the
 * patient files use, and asks once when any part of it is a guess. "النجار" is
 * not in the curated name table, so "Ali Alngar" is a proposal rather than a
 * lookup and `register_patient` refuses to file it unseen. `name_spelling_confirmed`
 * is the patient having said yes; the refusal itself is asserted separately in
 * `tests/unit/ai/p10-whatsapp-device-regressions.test.ts`.
 */
const FRIEND = {
  ...FRIEND_AS_TYPED,
  date_of_birth: "٣ فبراير ٢٠٠١",
  name_spelling_confirmed: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  mocks.directory.mockResolvedValue({
    departments: [{ id: DERMATOLOGY, name: "Dermatology" }],
    doctors: [
      {
        id: NABIL,
        name: "Ahmed Nabil",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.stageIntake.mockResolvedValue({
    data: [{ status: "staged", intake_id: INTAKE, attempts_remaining: null }],
    error: null,
  });
  mocks.availableSlots.mockResolvedValue({
    ok: true,
    doctorId: NABIL,
    doctorName: "Ahmed Nabil",
    date: "2026-08-24",
    availableSlots: ["10:00"],
    availabilityReason: "open",
    workingHours: [],
  });
  mocks.createBooking.mockResolvedValue({
    ok: true,
    appointmentId: "cccccccc-0000-4000-8000-000000000001",
    expiresAt: "2026-08-24T09:00:00.000Z",
    provisional: true,
  });
});

describe("P9C · registering the person the patient is booking for", () => {
  it("asks one self-contained question about an ambiguous date, and never gives up", async () => {
    mocks.authorize.mockResolvedValue(sender());

    const result = (await registerPatientTool(ctx).execute!(
      { ...FRIEND_AS_TYPED, for_someone_else: true },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("ambiguous_date");
    expect(result.needs_clarification).toBe(true);
    expect(result.technical_error).toBeUndefined();
    // The incomplete date itself must be restated, while every already-resolved
    // field is kept in the isolated third-party draft.
    expect(String(result.guidance)).toContain("for_someone_else");
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    // And nothing about the friend leaked into the sender's own state.
    expect(mocks.persist).not.toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({ date_of_birth: expect.anything() }),
      }),
    );
  });

  it("stages the friend instead of answering already_linked", async () => {
    mocks.authorize.mockResolvedValue(sender());

    const result = (await registerPatientTool(ctx).execute!(
      { ...FRIEND, for_someone_else: true },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).not.toBe("already_linked");
    expect(result.intake_staged).toBe(true);
    expect(result.awaiting_staff_review).toBe(true);
    // Staged for a human, never registered. That property is what makes this
    // safe to allow at all.
    expect(result.registered).toBe(false);
    expect(mocks.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        forThirdParty: true,
        // Filed in the Latin-script form the patient confirmed…
        fullName: "Ali Alngar",
        // …with what they actually typed kept beside it, never instead of it.
        fullNameOriginal: "على النجار",
      }),
    );
  });

  it("never reuses the sender's own details for the friend", async () => {
    mocks.authorize.mockResolvedValue(sender());

    await registerPatientTool(ctx).execute!({ ...FRIEND, for_someone_else: true }, opts);

    const staged = mocks.stageIntake.mock.calls[0]![0] as Record<string, unknown>;
    expect(staged.fullName).toBe("Ali Alngar");
    expect(staged.fullNameOriginal).toBe("على النجار");
    // The sender's own name, in either script, never reaches the friend's file.
    expect(staged.fullName).not.toBe("محمد حسن");
    expect(staged.fullName).not.toBe("Mohamed Hassan");
    // ٣-٢-٢٠٠١ read as the friend's own date, not the sender's stored one.
    expect(staged.dateOfBirth).toBe("2001-02-03");
    expect(staged.dateOfBirth).not.toBe("1995-04-02");
  });

  it("does not write the friend's details over the sender's collected state", async () => {
    mocks.authorize.mockResolvedValue(sender());

    await registerPatientTool(ctx).execute!({ ...FRIEND, for_someone_else: true }, opts);

    for (const call of mocks.persist.mock.calls) {
      const collected = (call[0] as { collected?: Record<string, unknown> }).collected;
      expect(collected?.full_name).toBeUndefined();
      expect(collected?.date_of_birth).toBeUndefined();
      expect(collected?.national_id).toBeUndefined();
    }
  });

  it("passes the friend's own number when given, and never the sender's", async () => {
    mocks.authorize.mockResolvedValue(sender());

    await registerPatientTool(ctx).execute!(
      { ...FRIEND, for_someone_else: true, phone: "٠١٠١٢٣٤٥٦٧٨" },
      opts,
    );

    const staged = mocks.stageIntake.mock.calls[0]![0] as Record<string, unknown>;
    expect(staged.phone).toBe("+201012345678");
    expect(staged.phone).not.toBe("+201000000000");
  });

  it("continues a third-party intake across messages without reusing sender fields", async () => {
    mocks.authorize.mockResolvedValue(
      sender({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bloodTypeResolved: true,
          bookingForOther: true,
          thirdPartyIntake: {
            fullName: "على النجار",
            nationalId: "99765438120",
            dateOfBirth: null,
            email: null,
            phone: "+201012345678",
            bloodType: null,
            nameSpellingConfirmed: true,
          },
        },
      }),
    );

    const result = (await registerPatientTool(ctx).execute!(
      {
        date_of_birth: "٣ فبراير ٢٠٠١",
        email: "ali-elnajar@clinic.com",
      },
      opts,
    )) as Record<string, unknown>;

    expect(result.intake_staged).toBe(true);
    expect(mocks.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        forThirdParty: true,
        fullName: "Ali Alngar",
        nationalId: "99765438120",
        dateOfBirth: "2001-02-03",
        email: "ali-elnajar@clinic.com",
        phone: "+201012345678",
      }),
    );
    const staged = mocks.stageIntake.mock.calls[0]![0] as Record<string, unknown>;
    expect(staged.fullName).not.toBe("محمد حسن");
    expect(staged.dateOfBirth).not.toBe("1995-04-02");
  });

  it("still refuses a linked sender registering themselves", async () => {
    mocks.authorize.mockResolvedValue(sender());

    const result = (await registerPatientTool(ctx).execute!(
      { ...FRIEND },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("already_linked");
    expect(mocks.stageIntake).not.toHaveBeenCalled();
  });
});

describe("P9C · the booking cannot land on the sender's record", () => {
  it("refuses to book for somebody who has not been staged", async () => {
    mocks.authorize.mockResolvedValue(
      sender({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          offeredDays: ["2026-08-24"],
          offeredSlots: [offeredSlotKey("2026-08-24", "10:00")],
        },
      }),
    );
    mocks.pendingIntake.mockResolvedValue({ data: null, error: null });

    const result = (await createPreliminaryBookingTool(ctx).execute!(
      {
        doctor_id: NABIL,
        date: "2026-08-24",
        time: "10:00",
        duration_minutes: 30,
        for_someone_else: true,
      },
      opts,
    )) as Record<string, unknown>;

    expect(result.created).toBe(false);
    expect(result.reason).toBe("intake_required");
    expect(result.needs_intake).toBe(true);
    // The load-bearing assertion: nothing was written anywhere.
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("books against the staged file once the friend exists", async () => {
    mocks.authorize.mockResolvedValue(
      sender({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          offeredDays: ["2026-08-24"],
          offeredSlots: [offeredSlotKey("2026-08-24", "10:00")],
        },
      }),
    );
    mocks.pendingIntake.mockResolvedValue({
      data: {
        id: INTAKE,
        full_name: "على النجار",
        doctor_id: NABIL,
        department_id: DERMATOLOGY,
        is_third_party: true,
      },
      error: null,
    });

    const result = (await createPreliminaryBookingTool(ctx).execute!(
      {
        doctor_id: NABIL,
        date: "2026-08-24",
        time: "10:00",
        duration_minutes: 30,
        for_someone_else: true,
      },
      opts,
    )) as Record<string, unknown>;

    expect(result.created).toBe(true);
    expect(result.provisional_intake).toBe(true);
    expect(result.booked_for_other_person).toBe(true);
    expect(result.booked_for_name).toBe("على النجار");
    expect(result.requires_staff_confirmation).toBe(true);
  });
});

describe("P9C · the stage machine knows who the booking is for", () => {
  const facts = {
    collected: { department_id: DERMATOLOGY, doctor_id: NABIL },
    linked: true,
    identityVerified: true,
    identityLocked: false,
    intakeStaged: false,
    submitted: false,
    escalated: false,
    bookingIntent: true,
  };

  it("sends a linked sender booking for a friend to intake_collecting", () => {
    // Without the latch this derives `selecting_day`, `register_patient` is
    // never mounted, and the friend can never be staged — which is precisely
    // how the production conversation ran out of moves.
    expect(deriveStage({ ...facts, bookingForOther: false })).toBe("selecting_day");
    expect(deriveStage({ ...facts, bookingForOther: true })).toBe("intake_collecting");
  });

  it("moves on to the day once the friend is staged", () => {
    expect(
      deriveStage({ ...facts, bookingForOther: true, intakeStaged: true }),
    ).toBe("selecting_day");
  });

  it("mounts register_patient in the stage a third-party booking reaches", () => {
    expect(allowedToolsForStage("intake_collecting", [...PATIENT_TOOL_NAMES])).toContain(
      "register_patient",
    );
  });
});
