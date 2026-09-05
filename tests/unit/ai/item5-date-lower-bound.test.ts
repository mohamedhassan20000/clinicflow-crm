/**
 * Item #5 — "بعد يوم 9" is a lower bound, and must never silently become a day.
 *
 * ## The regression
 *
 * `readDateBoundary` has read this shape correctly since P12, but its only
 * consumer was the `list_available_days` tool. The deterministic turn opener
 * never asked, so a boundary arriving mid-flow was handed straight to
 * `commitLatestOfferedSelection`, which reads a short declarative message as an
 * *answer to the offer in front of the patient*. The `9` in it then matched an
 * offered day, or was read as an hour against the offered slots, and the
 * booking moved on with a day the patient never chose.
 *
 * The rule this file pins: a message the server can prove is a date lower bound
 * selects nothing, invalidates the date and time already held, and routes the
 * turn back to authoritative day discovery — where the same text is read again
 * by the tool that knows what to do with it.
 */
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
const D_NABIL = "aaaaaaaa-0000-4000-8000-000000000001";

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

const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: PATIENT,
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

/** The collected-data patch the turn wrote, as the next turn would read it. */
function persistedCollected(): Record<string, unknown> {
  return Object.assign(
    {},
    ...mocks.persist.mock.calls.map(
      ([input]) => (input as { collected?: Record<string, unknown> }).collected ?? {},
    ),
  );
}

/** The stage record the turn persisted. */
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
  mocks.tables = {
    departments: [{ id: DERM, name: "الجلدية", is_active: true, deleted_at: null }],
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

/** A booking that has a doctor and has been offered the 9th, 10th and 11th. */
function offeredDays(overrides: Record<string, unknown> = {}) {
  return identity({
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
      offeredDays: ["2026-09-09", "2026-09-10", "2026-09-11"],
      ...overrides,
    },
  });
}

describe("a date lower bound selects nothing", () => {
  it("does not commit the 9th when the patient asks for the days after it", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أقصد اعرض لي الأيام بعد يوم 9",
      conversationEscalated: false,
    });
    expect(persistedCollected().appointment_date).not.toBe("2026-09-09");
    expect(persistedCollected().appointment_date).not.toBe("2026-09-10");
  });

  it("re-opens day discovery instead of leaving the old offer standing", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أقصد اعرض لي الأيام بعد يوم 9",
      conversationEscalated: false,
    });
    // `list_available_days` is the only reader that applies the boundary
    // against the clinic's real calendar, so the turn must route there. With
    // the stale offer still recorded the authority would report
    // `committed_days` and pin nothing at all.
    expect(turn.authority).toMatchObject({
      step: "day",
      operation: "list_available_days",
    });
    expect(persistedStage()).toMatchObject({ offeredDays: [] });
  });

  it("invalidates a date and time already held, and nothing upstream of them", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DERM,
          department_name: "الجلدية",
          doctor_id: D_NABIL,
          doctor_name: "أحمد نبيل",
          appointment_date: "2026-09-09",
          appointment_time: 600,
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          stage: "selecting_time",
          beneficiary: "self",
          offeredDoctorIds: [D_NABIL],
          offeredDays: ["2026-09-09", "2026-09-10"],
          offeredSlots: ["2026-09-09T10:00", "2026-09-09T11:00"],
        },
      }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أقصد اعرض لي الأيام بعد يوم 9",
      conversationEscalated: false,
    });
    const collected = persistedCollected();
    expect(collected.appointment_date).toBe("");
    expect(collected.appointment_time).toBe("");
    // Upstream state is untouched: the boundary is about days, not about who
    // or where.
    expect(collected.doctor_id).toBeUndefined();
    expect(collected.department_id).toBeUndefined();
    expect(turn.authority).toMatchObject({ step: "day" });
  });

  it("reads the bare boundary the same way", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "بعد 9",
      conversationEscalated: false,
    });
    expect(persistedCollected().appointment_date).not.toBe("2026-09-09");
    expect(persistedCollected().appointment_date).not.toBe("2026-09-10");
  });

  it("reads the English boundary the same way", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "show me days after the 9th",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "day" });
    expect(persistedCollected().appointment_date).not.toBe("2026-09-10");
  });

  it("keeps a week window a boundary too, not a chosen day", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الأسبوع اللي بعد يوم 9",
      conversationEscalated: false,
    });
    expect(turn.authority).toMatchObject({ step: "day" });
    expect(persistedCollected().appointment_date).not.toBe("2026-09-10");
  });
});

describe("what a boundary is not", () => {
  it("leaves an explicit day selection alone", async () => {
    // "يوم 10" names a day the server offered. It is an answer, not a bound,
    // and the pre-commit must still take it.
    mocks.authorize.mockResolvedValue(offeredDays());
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "يوم 10",
      conversationEscalated: false,
    });
    expect(persistedCollected().appointment_date).toBe("2026-09-10");
  });

  it("leaves a time constraint alone", async () => {
    // "بعد الساعة 9" is a clock bound, which `readDateBoundary` already
    // refuses; it must not reach the day path or clear anything.
    mocks.authorize.mockResolvedValue(
      offeredDays({ offeredSlots: ["2026-09-10T09:00", "2026-09-10T11:00"] }),
    );
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "بعد الساعة 9",
      conversationEscalated: false,
    });
    expect(turn.authority?.step).not.toBe("done");
    expect(persistedCollected().appointment_date).not.toBe("");
  });

  it("leaves a relative day alone", async () => {
    mocks.authorize.mockResolvedValue(offeredDays());
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "بعد بكرة",
      conversationEscalated: false,
    });
    expect(turn.authority?.step).not.toBe("done");
  });
});
