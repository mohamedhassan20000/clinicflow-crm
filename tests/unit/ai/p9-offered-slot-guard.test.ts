/**
 * P9 — the offered-options guard, against the real tool.
 *
 * `p9-booking-stage.test.ts` proves `checkOfferedSlot` is correct as a function.
 * That is not the same claim as "a model cannot book a time nobody offered",
 * because the function could be correct and simply not wired in — or wired into
 * one of `create_preliminary_booking`'s two input paths and not the other.
 *
 * So this file exercises `createPreliminaryBookingTool` itself, with the real
 * `patient-input` resolver, the real clinic timezone handling, and the booking
 * boundary mocked at the point where it would touch the database. The load-
 * bearing assertions are the two negative ones: a never-offered time is refused
 * on the natural date/time path *and* on the `scheduled_at` path, and in neither
 * case does `createPatientPendingBooking` get called at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "dddddddd-0000-4000-8000-000000000001";
const DOCTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const PATIENT = "bbbbbbbb-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  authorize: vi.fn(),
  persist: vi.fn().mockResolvedValue({ data: null, error: null }),
  clinicInfo: vi.fn().mockResolvedValue({ data: { phone: null }, error: null }),
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
  getPendingConversationIntake: vi
    .fn()
    .mockResolvedValue({ data: null, error: null }),
}));

/**
 * P9B: the availability and booking tools now resolve their doctor against the
 * clinic's directory before touching the schedule, so a doctor id the clinic
 * never issued cannot reach the engine. The directory itself has its own tests;
 * here it only needs to know the one doctor these cases book with.
 */
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/booking/patient", () => ({
  createPatientPendingBooking: mocks.createBooking,
  getPatientAvailableSlots: mocks.availableSlots,
}));

import {
  EMPTY_BOOKING_STAGE_STATE,
  offeredSlotKey,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "en" as const };

function identity(stage: Partial<BookingStageState> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: PATIENT,
    linked: true,
    identityVerifiedAt: "2026-08-20T10:00:00.000Z",
    identityLockedUntil: null,
    clinicName: "Nile Care",
    clinicLocale: "en" as const,
    // Africa/Cairo is UTC+3 in September, which is what makes the timestamp
    // path a real test rather than a string comparison.
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    // A conversation that has genuinely reached the time-selection step: the
    // department and the doctor are settled and a day has been checked. The
    // stage is derived from these, never read from the record.
    collectedData: {
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      appointment_date: "2026-09-07",
    },
    pendingClarification: null,
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, ...stage },
  };
}

/** The three slots `check_availability` returned for 7 September. */
const OFFERED: BookingStageState = {
  ...EMPTY_BOOKING_STAGE_STATE,
  stage: "selecting_time",
  offeredDays: ["2026-09-07"],
  offeredSlots: [
    offeredSlotKey("2026-09-07", "10:00"),
    offeredSlotKey("2026-09-07", "10:30"),
    offeredSlotKey("2026-09-07", "11:00"),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directory.mockResolvedValue({
    departments: [{ id: DEPARTMENT, name: "Dermatology" }],
    doctors: [
      {
        id: DOCTOR,
        name: "Sara Ali",
        departmentId: DEPARTMENT,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
  delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.clinicInfo.mockResolvedValue({ data: { phone: null }, error: null });
  mocks.createBooking.mockResolvedValue({
    ok: true,
    appointmentId: "cccccccc-0000-4000-8000-000000000001",
    expiresAt: "2026-09-06T09:00:00.000Z",
    provisional: false,
  });
  mocks.availableSlots.mockResolvedValue({
    ok: true,
    doctorId: DOCTOR,
    doctorName: "Sara Ali",
    date: "2026-09-07",
    availableSlots: ["10:00", "10:30", "11:00"],
  });
});

async function book(
  stage: Partial<BookingStageState>,
  input: Record<string, unknown>,
) {
  mocks.authorize.mockResolvedValue(identity(stage));
  const tool = createPreliminaryBookingTool(ctx);
  return (await tool.execute!(input as never, opts)) as Record<string, unknown>;
}

describe("P9 · create_preliminary_booking refuses a slot nobody offered", () => {
  it("books a time that check_availability actually returned", async () => {
    // "10:30 am" rather than "10:30": a bare hour is genuinely ambiguous and the
    // pre-existing conversational resolver asks about the meridiem before this
    // tool ever gets a value. That behaviour is not this guard's business, and
    // pinning it here would make this file a test of `human-input.ts`.
    const result = await book(OFFERED, { date: "2026-09-07", time: "10:30 am" });
    expect(result.created).toBe(true);
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
  });

  it("refuses a never-offered time on the natural date/time path", async () => {
    const result = await book(OFFERED, { date: "2026-09-07", time: "4pm" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("slot_not_offered");
    // The real slots travel with the refusal, so the assistant's next move is to
    // offer them rather than to apologise.
    expect(result.available_times).toEqual(["10:00", "10:30", "11:00"]);
    // Nothing reached the booking boundary.
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("refuses a never-offered time on the scheduled_at path too", async () => {
    // 16:00 Africa/Cairo on 7 September is 13:00Z. The guard converts back into
    // clinic-local time before comparing, so a UTC timestamp cannot slip past a
    // record written in local time.
    const result = await book(OFFERED, {
      scheduled_at: "2026-09-07T13:00:00.000Z",
      doctor_id: DOCTOR,
    });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("slot_not_offered");
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("accepts an offered time expressed as a UTC timestamp", async () => {
    // 10:30 Africa/Cairo is 07:30Z, and it was offered.
    const result = await book(OFFERED, {
      scheduled_at: "2026-09-07T07:30:00.000Z",
      doctor_id: DOCTOR,
    });
    expect(result.created).toBe(true);
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
  });

  it("refuses an available slot on a day that was never checked", async () => {
    // The case the availability recheck alone does not catch: 10:00 on the 8th
    // is genuinely bookable and was never put in front of this patient.
    const result = await book(OFFERED, { date: "2026-09-08", time: "10:00 am" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("slot_not_offered");
    expect(result.available_times).toEqual([]);
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("does not enforce before the conversation has been offered anything", async () => {
    // A conversation with no recorded offer falls through untouched: the guard
    // holds the model to what the availability flow said, and says nothing when
    // the flow has not run.
    const result = await book({}, { date: "2026-09-07", time: "4pm" });
    expect(result.created).toBe(true);
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
  });

  it("is inert when stage tracking is rolled back to off", async () => {
    process.env.AI_PATIENT_STAGE_ORCHESTRATION = "off";
    const result = await book(OFFERED, { date: "2026-09-07", time: "4pm" });
    // Exactly the pre-P9 behaviour: the request reaches the booking boundary and
    // the availability recheck there is the only thing standing in its way.
    expect(result.reason).not.toBe("slot_not_offered");
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
  });

  it("still refuses when no doctor has been resolved, before any offer check", async () => {
    mocks.authorize.mockResolvedValue({
      ...identity(OFFERED),
      collectedData: { department_id: DEPARTMENT, appointment_date: "2026-09-07" },
    });
    const tool = createPreliminaryBookingTool(ctx);
    const result = (await tool.execute!(
      { date: "2026-09-07", time: "10:00 am" } as never,
      opts,
    )) as Record<string, unknown>;
    expect(result.created).toBe(false);
    expect(result.reason).toBe("doctor_required");
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });
});

/**
 * The rollback contract, pinned.
 *
 * `shadow` scoping the model's view was a real bug in the first cut of this
 * work: `openBookingStageTurn` returned a stage whenever *tracking* was on, and
 * `createPatientAgent` narrows whenever it is handed one, so the default mode
 * silently behaved like `on`. These assertions are the reason that cannot come
 * back — the difference between the three modes is exactly what a rollback is.
 */
describe("P9 · the three orchestration modes", () => {
  it("separates tracking from scoping", async () => {
    const { stageTrackingEnabled, stageScopedMountEnabled, stageOrchestrationMode } =
      await import("@/lib/ai/booking-stage-store");

    // P11: the default moved from `shadow` to `on`. An unset variable now
    // scopes the mount and the prompt to the stage, which is what makes the
    // department → doctor step structural instead of advisory. `shadow` and
    // `off` are unchanged and remain the rollbacks; an unrecognised value
    // fails to the new default rather than to the old one.
    for (const [value, mode, tracking, scoping] of [
      [undefined, "on", true, true],
      ["shadow", "shadow", true, false],
      ["on", "on", true, true],
      ["1", "on", true, true],
      ["off", "off", false, false],
      ["false", "off", false, false],
      ["nonsense", "on", true, true],
    ] as const) {
      if (value === undefined) delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
      else process.env.AI_PATIENT_STAGE_ORCHESTRATION = value;
      expect(stageOrchestrationMode(), String(value)).toBe(mode);
      expect(stageTrackingEnabled(), String(value)).toBe(tracking);
      expect(stageScopedMountEnabled(), String(value)).toBe(scoping);
    }
    delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  });

  it("hands the agent no stage in shadow, so the mount and prompt stay flat", async () => {
    const { openBookingStageTurn } = await import("@/lib/ai/booking-stage-store");
    mocks.authorize.mockResolvedValue(identity(OFFERED));

    // P10: the turn context is an object now — the stage plus the clinic's
    // communication style and the per-turn briefing. Only `stage` is gated by
    // the orchestration mode; the other two narrow nothing and are always
    // resolved, so a rollback to `shadow` still honours the clinic's settings.
    process.env.AI_PATIENT_STAGE_ORCHESTRATION = "shadow";
    expect((await openBookingStageTurn(ctx, "patient_booking")).stage).toBeNull();
    // …but the turn was still counted, persisted and traced. That is `shadow`.
    expect(mocks.persist).toHaveBeenCalled();

    mocks.persist.mockClear();
    process.env.AI_PATIENT_STAGE_ORCHESTRATION = "on";
    expect((await openBookingStageTurn(ctx, "patient_booking")).stage).toBe(
      "selecting_time",
    );

    mocks.persist.mockClear();
    process.env.AI_PATIENT_STAGE_ORCHESTRATION = "off";
    expect((await openBookingStageTurn(ctx, "patient_booking")).stage).toBeNull();
    // Off means off: nothing was written and nothing was logged.
    expect(mocks.persist).not.toHaveBeenCalled();

    delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  });

  it("never scopes a FAQ turn, whatever the mode", async () => {
    const { openBookingStageTurn } = await import("@/lib/ai/booking-stage-store");
    mocks.authorize.mockResolvedValue(identity(OFFERED));
    process.env.AI_PATIENT_STAGE_ORCHESTRATION = "on";
    expect((await openBookingStageTurn(ctx, "patient_faq")).stage).toBeNull();
    delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  });
});
