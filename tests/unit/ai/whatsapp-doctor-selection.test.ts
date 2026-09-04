import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression suite for the WhatsApp doctor-selection defect.
 *
 * The failure it locks down: a patient picked a department, the assistant
 * offered exactly one doctor, and "في دكاترة غيره؟" produced a technical error.
 * Three separate causes were behind that — the roster never travelled with a
 * non-resolved result, the treating-doctor shortcut swallowed every follow-up,
 * and the shared availability engine could not read `doctor_unavailability`
 * through the patient client at all. All three are covered here.
 *
 * The Supabase mock below applies the real `.eq`/`.is`/`.lte`/`.gt` filters to
 * fixture rows rather than returning a canned list, so a query that stops
 * filtering by department or by `is_active` fails the test instead of passing it.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DERM = "33333333-3333-4333-8333-333333333333";
const CARDIO = "44444444-4444-4444-8444-444444444444";
const NUTRITION = "55555555-5555-4555-8555-555555555555";

const D_NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const D_SARA = "aaaaaaaa-0000-4000-8000-000000000002";
const D_KHALED = "aaaaaaaa-0000-4000-8000-000000000003";
const D_ON_LEAVE = "aaaaaaaa-0000-4000-8000-000000000004";
const D_INACTIVE = "aaaaaaaa-0000-4000-8000-000000000005";
const D_CARDIO = "aaaaaaaa-0000-4000-8000-000000000006";
const D_SOLO = "aaaaaaaa-0000-4000-8000-000000000007";
const PATIENT = "bbbbbbbb-0000-4000-8000-000000000001";

const NOW = new Date("2026-08-22T09:00:00.000Z");

function doctorRow(
  id: string,
  full_name: string,
  department_id: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    full_name,
    department_id,
    role: "doctor",
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

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

import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";
import { listDoctorsTool } from "@/lib/ai/tools/list-doctors";
import { buildPatientTools } from "@/lib/ai/patient-tools";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    identityLockedUntil: null,
    clinicName: "Clinic",
    clinicLocale: "ar",
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {},
    pendingClarification: null,
    ...overrides,
  };
}

function prepare(input: Record<string, unknown>) {
  return prepareBookingTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}
function listDoctors(input: Record<string, unknown> = {}) {
  return listDoctorsTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}
function names(result: Record<string, unknown>, key = "doctors"): string[] {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.clinicInfo.mockResolvedValue({ data: { phone: "+20 2 1234 5678" }, error: null });
  mocks.authorize.mockResolvedValue(identity());
  mocks.tables = {
    departments: [
      { id: DERM, name: "الجلدية", is_active: true, deleted_at: null },
      { id: CARDIO, name: "القلب", is_active: true, deleted_at: null },
      { id: NUTRITION, name: "التغذية", is_active: true, deleted_at: null },
    ],
    profiles: [
      doctorRow(D_NABIL, "أحمد نبيل", DERM),
      doctorRow(D_SARA, "سارة علي", DERM),
      doctorRow(D_KHALED, "محمد خالد", DERM),
      doctorRow(D_ON_LEAVE, "هالة فؤاد", DERM),
      doctorRow(D_INACTIVE, "عمر زكي", DERM, { is_active: false }),
      doctorRow(D_CARDIO, "يوسف عادل", CARDIO),
      doctorRow(D_SOLO, "نور سالم", NUTRITION),
    ],
    doctor_unavailability: [
      {
        doctor_id: D_ON_LEAVE,
        starts_at: "2026-08-20T00:00:00.000Z",
        ends_at: "2026-08-30T00:00:00.000Z",
        is_active: true,
      },
      // Leave that has not started yet must never make a doctor look away.
      {
        doctor_id: D_SARA,
        starts_at: "2026-12-01T00:00:00.000Z",
        ends_at: "2026-12-10T00:00:00.000Z",
        is_active: true,
      },
    ],
    patients: [],
  };
});

describe("department → doctors", () => {
  it("returns every bookable doctor of the chosen department, not one", async () => {
    const result = await prepare({ department: "جلدية" });
    expect(result).toMatchObject({
      needs_selection: true,
      field: "doctor",
      department: { id: DERM },
      doctor_count: 3,
      only_one_available: false,
    });
    expect(names(result)).toEqual(["أحمد نبيل", "سارة علي", "محمد خالد"]);
  });

  it("excludes inactive, on-leave and cross-department doctors from the list", async () => {
    const result = await prepare({ department: "جلدية" });
    expect(names(result)).not.toContain("عمر زكي");
    expect(names(result)).not.toContain("هالة فؤاد");
    expect(names(result)).not.toContain("يوسف عادل");
  });

  it("never repeats a doctor", async () => {
    const result = await prepare({ department: "جلدية" });
    const ids = ((result.doctors ?? []) as Array<{ id: string }>).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("says so explicitly when a department has exactly one doctor", async () => {
    const result = await prepare({ department: "التغذية" });
    expect(result).toMatchObject({ doctor_count: 1, only_one_available: true });
    expect(String(result.guidance)).toMatch(/exactly one doctor/i);
  });

  it("works the same for an English department name", async () => {
    mocks.tables.departments = [
      { id: DERM, name: "Dermatology", is_active: true, deleted_at: null },
    ];
    const result = await prepare({ department: "dermatolgy" });
    expect(result).toMatchObject({ department: { id: DERM }, doctor_count: 3 });
  });
});

describe("'any other doctors?' follow-up", () => {
  it.each([
    "في دكاترة غيره؟",
    "مين تاني؟",
    "عايز دكتور تاني",
    "show other doctors",
    "who else is available?",
  ])("keeps the department and returns the roster for: %s", async (phrase) => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DERM,
          department_name: "الجلدية",
          doctor_id: D_NABIL,
          doctor_name: "أحمد نبيل",
        },
      }),
    );
    const result = await prepare({ doctor: phrase });
    expect(result.needs_clarification).toBeUndefined();
    expect(result).toMatchObject({
      needs_selection: true,
      field: "doctor",
      department: { id: DERM },
      doctor_count: 3,
    });
    // The department is never re-asked and the flow never restarts.
    expect(result.field).not.toBe("department");
  });

  it("list_doctors answers the follow-up without touching booking state", async () => {
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: DERM, doctor_id: D_NABIL } }),
    );
    const result = await listDoctors({ exclude_doctor_id: D_NABIL });
    expect(result).toMatchObject({
      department: { id: DERM },
      department_already_selected: true,
      doctor_count: 2,
    });
    expect(names(result)).toEqual(["سارة علي", "محمد خالد"]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

describe("existing patient", () => {
  beforeEach(() => {
    mocks.tables.patients = [
      {
        id: PATIENT,
        assigned_doctor_id: D_NABIL,
        department_id: DERM,
        is_deleted: false,
      },
    ];
    mocks.authorize.mockResolvedValue(
      identity({
        linked: true,
        patientId: PATIENT,
        identityVerifiedAt: "2026-08-22T08:00:00.000Z",
      }),
    );
  });

  it("recommends the treating doctor first and carries the alternatives", async () => {
    const result = await prepare({});
    expect(result).toMatchObject({
      existing_patient: true,
      treating_doctor: { id: D_NABIL },
      department: { id: DERM },
      other_doctor_count: 2,
    });
    expect(names(result, "other_doctors")).toEqual(["سارة علي", "محمد خالد"]);
    // V2-CONTAINMENT — the treating doctor is offered, never selected.
    expect(String(result.guidance)).toMatch(/do not push the previous one/i);
    expect(result.treating_doctor_is_offer).toBe(true);
  });

  it("gives the alternatives, not the treating doctor again, on 'في دكتور غيره؟'", async () => {
    const result = await prepare({ doctor: "في دكتور غيره؟" });
    expect(result.treating_doctor).toBeUndefined();
    expect(result).toMatchObject({ field: "doctor", doctor_count: 3 });
  });

  it("does not re-open on the treating doctor once a department is established", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        linked: true,
        patientId: PATIENT,
        identityVerifiedAt: "2026-08-22T08:00:00.000Z",
        collectedData: { department_id: CARDIO },
      }),
    );
    const result = await prepare({});
    expect(result.treating_doctor).toBeUndefined();
    expect(result).toMatchObject({ department: { id: CARDIO } });
  });
});

describe("a doctor the patient names explicitly", () => {
  const collected = { collectedData: { department_id: DERM, department_name: "الجلدية" } };

  beforeEach(() => mocks.authorize.mockResolvedValue(identity(collected)));

  it("resolves a valid doctor of the selected department", async () => {
    const result = await prepare({ doctor: "سارة علي" });
    expect(result).toMatchObject({ resolved: true, doctor: { id: D_SARA } });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({ doctor_id: D_SARA }),
      }),
    );
  });

  it.each(["Sara Ali", "سارا علي", "سارة"])(
    "resolves misspelled and transliterated names: %s",
    async (written) => {
      const result = await prepare({ doctor: written });
      expect(result).toMatchObject({ resolved: true, doctor: { id: D_SARA } });
    },
  );

  it("explains a doctor who works in another department and offers the real list", async () => {
    const result = await prepare({ doctor: "يوسف عادل" });
    expect(result).toMatchObject({
      reason: "doctor_in_other_department",
      requested_doctor: { id: D_CARDIO, department: "القلب" },
      doctor_count: 3,
    });
    expect(result.technical_error).toBeUndefined();
  });

  it("explains a doctor who is currently on leave, with the stored end date", async () => {
    const result = await prepare({ doctor: "هالة فؤاد" });
    expect(result).toMatchObject({
      reason: "doctor_on_leave",
      requested_doctor: { id: D_ON_LEAVE, unavailable_until: "2026-08-30T00:00:00.000Z" },
      doctor_count: 3,
    });
    expect(String(result.guidance)).toMatch(/never invent a reason/i);
  });

  it("explains a deactivated doctor rather than calling them unknown", async () => {
    const result = await prepare({ doctor: "عمر زكي" });
    expect(result).toMatchObject({
      reason: "doctor_inactive",
      requested_doctor: { id: D_INACTIVE },
      doctor_count: 3,
    });
  });

  it("asks one short question when two doctors are plausible", async () => {
    mocks.tables.profiles = [
      doctorRow(D_NABIL, "Ahmed Ali", DERM),
      doctorRow(D_SARA, "Ahmad Aly", DERM),
    ];
    const result = await prepare({ doctor: "Ahmd Ali" });
    expect(result).toMatchObject({ needs_clarification: true, reason: "ambiguous" });
    expect((result.candidates as unknown[]).length).toBe(2);
  });

  it("reports an unknown doctor and still offers the real ones", async () => {
    const result = await prepare({ doctor: "زينب المصري" });
    expect(result).toMatchObject({ reason: "doctor_not_found", doctor_count: 3 });
    expect(names(result)).toEqual(["أحمد نبيل", "سارة علي", "محمد خالد"]);
  });

  it("never turns a doctor status into a technical error", async () => {
    for (const written of ["يوسف عادل", "هالة فؤاد", "عمر زكي", "زينب المصري"]) {
      const result = await prepare({ doctor: written });
      expect(result.technical_error).toBeUndefined();
    }
  });
});

describe("unexpected technical failure", () => {
  it("returns the clinic's stored phone instead of throwing", async () => {
    mocks.authorize.mockRejectedValue(new Error("connection reset by peer"));
    const tools = buildPatientTools(ctx, "patient_booking");
    const result = (await tools.prepare_booking!.execute!({} as never, opts)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      technical_error: true,
      retryable: true,
      clinic_phone: "+20 2 1234 5678",
    });
    expect(JSON.stringify(result)).not.toContain("connection reset");
  });

  it("applies to every patient booking/intake tool, not only availability", async () => {
    mocks.authorize.mockRejectedValue(new Error("boom"));
    const tools = buildPatientTools(ctx, "patient_booking");
    for (const name of [
      "prepare_booking",
      "list_doctors",
      "list_available_days",
      "check_availability",
      "register_patient",
      "create_preliminary_booking",
    ]) {
      const result = (await tools[name]!.execute!(
        {
          date: "tomorrow",
          full_name: "Test Patient",
          national_id: "12345678901234",
          date_of_birth: "12/9/2000",
          email: "a@b.com",
          scheduled_at: "2026-09-01T09:00:00.000Z",
        } as never,
        opts,
      )) as Record<string, unknown>;
      expect(result, name).toMatchObject({ technical_error: true });
    }
  });

  it("degrades gracefully when the clinic has stored no phone number", async () => {
    mocks.clinicInfo.mockResolvedValue({ data: { phone: null }, error: null });
    mocks.authorize.mockRejectedValue(new Error("boom"));
    const tools = buildPatientTools(ctx, "patient_booking");
    const result = (await tools.prepare_booking!.execute!({} as never, opts)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ technical_error: true, clinic_phone: null });
    expect(String(result.guidance)).toMatch(/do not give one and do not invent one/i);
  });
});
