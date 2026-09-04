/**
 * P12 — the same six corrections, driven through the real turn opener and the
 * real `prepare_booking` tool rather than through their pure parts.
 *
 * The Supabase mock applies the actual `.eq`/`.is` filters to fixture rows, so
 * a query that stops filtering fails the test instead of passing it. Nothing
 * here stubs the stage machine: every assertion about what was remembered
 * between turns reads the jsonb the turn actually persisted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const DERM = "33333333-3333-4333-8333-333333333333";
const CARDIO = "44444444-4444-4444-8444-444444444444";
const D_NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const D_SARA = "aaaaaaaa-0000-4000-8000-000000000002";

const NOW = new Date("2026-09-02T09:00:00.000Z");

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  clinicInfo: vi.fn(),
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
  resolvePatientAiContext: vi.fn(),
  getPatientClinicPublicInfo: mocks.clinicInfo,
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
        neq(column: string, value: unknown) {
          filters.push((row) => row[column] !== value);
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
        then: undefined,
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

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";
import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: PATIENT,
    linked: true,
    identityVerifiedAt: "2026-09-01T08:00:00.000Z",
    bookingIdentityConfirmedAt: null,
    identityLockedUntil: null,
    patientDisplayName: "Anas Talal Ali",
    patientNationalIdSuffix: "4567",
    clinicName: "Clinic",
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

function prepare(input: Record<string, unknown>) {
  return prepareBookingTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}

/** The stage record the turn persisted, as the next turn would read it. */
function persistedStage(): Record<string, unknown> | null {
  const writes = mocks.persist.mock.calls
    .map(([input]) => (input as { stage?: Record<string, unknown> }).stage)
    .filter(Boolean) as Record<string, unknown>[];
  return writes.length > 0 ? writes[writes.length - 1]! : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.clinicInfo.mockResolvedValue({ data: { phone: "+20 2 1234 5678" }, error: null });
  mocks.authorize.mockResolvedValue(identity());
  mocks.tables = {
    departments: [
      { id: DERM, name: "الجلدية", is_active: true, deleted_at: null },
      { id: CARDIO, name: "القلب", is_active: true, deleted_at: null },
    ],
    profiles: [
      {
        id: D_NABIL,
        full_name: "أحمد نبيل",
        department_id: DERM,
        role: "doctor",
        is_active: true,
        is_deleted: false,
        deleted_at: null,
      },
      {
        id: D_SARA,
        full_name: "سارة علي",
        department_id: DERM,
        role: "doctor",
        is_active: true,
        is_deleted: false,
        deleted_at: null,
      },
    ],
    doctor_unavailability: [],
    patients: [
      {
        id: PATIENT,
        assigned_doctor_id: D_NABIL,
        department_id: DERM,
        is_deleted: false,
        deleted_at: null,
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// A — self-booking is untouched
// ---------------------------------------------------------------------------

describe("A — booking for yourself still opens on your treating doctor", () => {
  it("returns the treating doctor first, with the department's alternatives", async () => {
    const result = await prepare({});
    expect(result).toMatchObject({
      existing_patient: true,
      treating_doctor: { id: D_NABIL },
      department: { id: DERM },
      other_doctor_count: 1,
    });
  });

  it("still does so once the patient has said the booking is for them", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, beneficiary: "self" },
      }),
    );
    expect(await prepare({})).toMatchObject({ treating_doctor: { id: D_NABIL } });
  });
});

// ---------------------------------------------------------------------------
// B — booking for another person
// ---------------------------------------------------------------------------

describe("B — booking for another person asks the department instead", () => {
  it("does not force the sender's treating doctor once the latch is set", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          beneficiary: "other",
          thirdPartyIntake: {
            fullName: "علي ادريس",
            nationalId: null,
            dateOfBirth: null,
            email: null,
            phone: null,
            bloodType: null,
            nameSpellingConfirmed: false,
          },
        },
      }),
    );
    const result = await prepare({});
    expect(result.treating_doctor).toBeUndefined();
    // The department question, with the real active departments behind it.
    expect(result).toMatchObject({ needs_selection: true, field: "department" });
    expect((result.departments as Array<{ id: string }>).map((item) => item.id)).toEqual([
      DERM,
      CARDIO,
    ]);
  });

  it("does not force it on the very turn the patient says it, either", async () => {
    const result = await prepare({ for_someone_else: true });
    expect(result.treating_doctor).toBeUndefined();
    expect(result).toMatchObject({ needs_selection: true, field: "department" });
  });

  it("continues the normal discovery flow once that department is chosen", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          beneficiary: "other",
        },
      }),
    );
    const result = await prepare({ department: "القلب" });
    // The department the patient named, not the sender's own.
    expect(result).toMatchObject({ department: { id: CARDIO } });
    expect(result.treating_doctor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D — a side question mid-booking
// ---------------------------------------------------------------------------

describe("D — the booking survives a side question and resumes where it stopped", () => {
  /** A booking that has reached doctor selection and is owed a day. */
  function midBooking(stage: Record<string, unknown> = {}) {
    return identity({
      bookingIdentityConfirmedAt: "2026-09-01T08:00:00.000Z",
      collectedData: {
        department_id: DERM,
        department_name: "الجلدية",
        doctor_id: D_NABIL,
        doctor_name: "أحمد نبيل",
      },
      bookingStage: {
        ...EMPTY_BOOKING_STAGE_STATE,
        stage: "selecting_day",
        beneficiary: "self",
        offeredDoctorIds: [D_NABIL],
        ...stage,
      },
    });
  }

  it("records the rung the side question interrupted, and offers to continue", async () => {
    mocks.authorize.mockResolvedValue(midBooking());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عندكم تأمين إيه؟",
      conversationEscalated: false,
    });
    expect(turn.bookingInterruption).toEqual({ kind: "paused", step: "day" });
    expect(turn.briefing).toContain("تحب نكمل الحجز؟");
    expect(persistedStage()).toMatchObject({
      interruptedBooking: { step: "day", offeredResume: true },
    });
    // Nothing about the booking was forgotten by the interruption.
    expect(persistedStage()).toMatchObject({ beneficiary: "self" });
    expect(turn.briefing).toContain("أحمد نبيل");
  });

  it("resumes from that exact rung when the patient agrees", async () => {
    mocks.authorize.mockResolvedValue(
      midBooking({ interruptedBooking: { step: "day", offeredResume: true } }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "اه تمام",
      conversationEscalated: false,
    });
    expect(turn.bookingInterruption).toEqual({ kind: "resuming", step: "day" });
    expect(turn.briefing).toContain("اكمل من نفس الخطوة بالضبط: اختيار اليوم");
    // The person, department and doctor are all still held.
    expect(turn.briefing).toContain("أحمد نبيل");
    expect(turn.briefing).toContain("الجلدية");
    // The record is cleared, so a later "اه" is not read as a resume again.
    expect(persistedStage()).toMatchObject({ interruptedBooking: null });
  });

  it("clears the record when the patient just carries on themselves", async () => {
    mocks.authorize.mockResolvedValue(
      midBooking({ interruptedBooking: { step: "day", offeredResume: true } }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "عايز يوم 9",
      conversationEscalated: false,
    });
    expect(turn.bookingInterruption).toBeNull();
    expect(persistedStage()).toMatchObject({ interruptedBooking: null });
  });

  it("does not treat an ordinary booking answer as an interruption", async () => {
    mocks.authorize.mockResolvedValue(midBooking());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "يوم 9",
      conversationEscalated: false,
    });
    expect(turn.bookingInterruption).toBeNull();
    expect(persistedStage()).toMatchObject({ interruptedBooking: null });
  });
});

// ---------------------------------------------------------------------------
// F — "say that in Arabic" changes nothing
// ---------------------------------------------------------------------------

describe("F — a restatement request leaves every booking value where it was", () => {
  it("carries the request and touches no state", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingIdentityConfirmedAt: "2026-09-01T08:00:00.000Z",
        collectedData: {
          department_id: DERM,
          department_name: "الجلدية",
          doctor_id: D_NABIL,
          doctor_name: "أحمد نبيل",
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "selecting_day",
          beneficiary: "self",
          offeredDoctorIds: [D_NABIL],
        },
      }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "مش فاهم قولها بالعربي",
      conversationEscalated: false,
    });
    expect(turn.translationRequest).toEqual({ target: "ar" });
    expect(turn.briefing).toContain("رسالتك السابقة");
    // No amendment, no beneficiary change, no interruption: nothing moved.
    expect(turn.bookingAmendment).toBeNull();
    expect(turn.bookingInterruption).toBeNull();
    expect(persistedStage()).toMatchObject({
      beneficiary: "self",
      interruptedBooking: null,
    });
  });
});
