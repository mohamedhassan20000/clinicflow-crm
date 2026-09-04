import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11 — the booking engine is generic, or it is not.
 *
 * This file deliberately contains **no real specialty**. Every department here
 * is a made-up name the codebase has never seen, in Arabic and in English, and
 * the point of that is negative: a test that proved "Dermatology works" would
 * pass just as happily against a hard-coded Dermatology branch. These pass only
 * if the department is data.
 *
 * The Supabase mock applies the real `.eq`/`.is`/`.lte`/`.gt` predicates to
 * fixture rows rather than returning a canned list, so dropping the
 * `department_id`, `clinic`, `is_active` or `deleted_at` filter from a query
 * makes a test fail rather than return a bigger list.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

const ALPHA = "d0000000-0000-4000-8000-00000000000a";
const BETA = "d0000000-0000-4000-8000-00000000000b";
const GAMMA = "d0000000-0000-4000-8000-00000000000c";
const DELTA = "d0000000-0000-4000-8000-00000000000d";

const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B1 = "aaaaaaaa-0000-4000-8000-000000000003";
const G1 = "aaaaaaaa-0000-4000-8000-000000000004";
const G2 = "aaaaaaaa-0000-4000-8000-000000000005";
const G3 = "aaaaaaaa-0000-4000-8000-000000000006";
const NOBODY = "aaaaaaaa-0000-4000-8000-00000000000f";

const NOW = new Date("2026-08-25T09:00:00.000Z");

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

function departmentRow(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return { id, name, is_active: true, deleted_at: null, ...overrides };
}

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
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
  getClinicCurrency: async () => "EGP",
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

import { listDoctorsTool } from "@/lib/ai/tools/list-doctors";
import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";
import { listDepartmentServicesTool } from "@/lib/ai/tools/list-department-services";
import {
  assertRosterAuthority,
  availableDoctorsInDepartment,
  loadDoctorDirectory,
} from "@/lib/ai/doctor-directory";

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
    bookingStage: {
      stage: "idle",
      submitted: false,
      escalated: false,
      intakeStaged: false,
      bookingForOther: false,
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: {},
      turnCount: 0,
      illegalTransitions: 0,
      enteredAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      toolOutcomes: [],
    },
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
function services(input: Record<string, unknown> = {}) {
  return listDepartmentServicesTool(ctx).execute!(
    input as never,
    opts,
  ) as unknown as Promise<Record<string, unknown>>;
}
function names(result: Record<string, unknown>, key = "doctors"): string[] {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}
function ids(result: Record<string, unknown>, key = "doctors"): string[] {
  return ((result[key] ?? []) as Array<{ id: string }>).map((item) => item.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.authorize.mockResolvedValue(identity());
  mocks.tables = {
    departments: [
      departmentRow(ALPHA, "Department Alpha"),
      departmentRow(BETA, "قسم بيتا"),
      departmentRow(GAMMA, "Gamma Unit"),
    ],
    profiles: [
      doctorRow(A1, "Rana Wasfy", ALPHA),
      doctorRow(A2, "Tarek Sobhy", ALPHA),
      doctorRow(B1, "بسمة راغب", BETA),
      doctorRow(G1, "Hoda Fahmy", GAMMA),
      doctorRow(G2, "Selim Adly", GAMMA),
      doctorRow(G3, "Yara Mounir", GAMMA),
      doctorRow(NOBODY, "Unassigned Person", null),
    ],
    doctor_unavailability: [],
    services: [],
  };
});

// ---------------------------------------------------------------------------
// A–D · arbitrary departments, each returning exactly its own doctors
// ---------------------------------------------------------------------------

describe("P11 §A-D · every configured department, through one code path", () => {
  it.each([
    ["Department Alpha", ALPHA, ["Rana Wasfy", "Tarek Sobhy"]],
    ["قسم بيتا", BETA, ["بسمة راغب"]],
    ["Gamma Unit", GAMMA, ["Hoda Fahmy", "Selim Adly", "Yara Mounir"]],
  ])("returns exactly the authoritative roster for %s", async (typed, id, expected) => {
    const result = await prepare({ department: typed });
    expect(result.needs_selection).toBe(true);
    expect(result.field).toBe("doctor");
    expect((result.department as { id: string }).id).toBe(id);
    expect(names(result).sort()).toEqual([...expected].sort());
  });

  it("never leaks a doctor from a sibling department or from no department", async () => {
    for (const [typed, allowed] of [
      ["Department Alpha", [A1, A2]],
      ["قسم بيتا", [B1]],
      ["Gamma Unit", [G1, G2, G3]],
    ] as const) {
      const result = await prepare({ department: typed });
      expect(ids(result).sort()).toEqual([...allowed].sort());
      expect(ids(result)).not.toContain(NOBODY);
    }
  });

  it("resolves each department from its own words, in either script", async () => {
    // No concept lexicon covers any of these names. They resolve because the
    // clinic stored them, which is the only mechanism that generalises.
    for (const [typed, id] of [
      ["alpha", ALPHA],
      ["ألفا", ALPHA],
      ["بيتا", BETA],
      ["beta", BETA],
      ["gamma", GAMMA],
      ["جاما", GAMMA],
    ] as const) {
      const result = await prepare({ department: typed });
      expect((result.department as { id: string } | undefined)?.id, typed).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// E–H · configuration changes take effect with no code change
// ---------------------------------------------------------------------------

describe("P11 §E-H · the clinic's configuration is the only input", () => {
  it("§E a department created after startup is bookable immediately", async () => {
    expect((await prepare({ department: "Delta Wing" })).needs_clarification).toBe(true);
    mocks.tables.departments!.push(departmentRow(DELTA, "Delta Wing"));
    mocks.tables.profiles!.push(doctorRow("aaaaaaaa-0000-4000-8000-00000000000e", "Ziad Nour", DELTA));
    const after = await prepare({ department: "Delta Wing" });
    expect((after.department as { id: string }).id).toBe(DELTA);
    expect(names(after)).toEqual(["Ziad Nour"]);
  });

  it("§F a deactivated department stops being offered and stops resolving", async () => {
    mocks.tables.departments = mocks.tables.departments!.map((row) =>
      row.id === BETA ? { ...row, is_active: false } : row,
    );
    const result = await prepare({ department: "قسم بيتا" });
    expect(result.department).toBeUndefined();
    expect(
      (result.departments as Array<{ id: string }>).map((item) => item.id),
    ).not.toContain(BETA);
  });

  it("§F a soft-deleted department behaves the same way", async () => {
    mocks.tables.departments = mocks.tables.departments!.map((row) =>
      row.id === GAMMA ? { ...row, deleted_at: NOW.toISOString() } : row,
    );
    const directory = await loadDoctorDirectory(CLINIC);
    expect(directory.departments.map((item) => item.id)).not.toContain(GAMMA);
  });

  it("§G moving a doctor between departments moves them in the roster", async () => {
    mocks.tables.profiles = mocks.tables.profiles!.map((row) =>
      row.id === A2 ? { ...row, department_id: GAMMA } : row,
    );
    expect(ids(await prepare({ department: "Department Alpha" }))).toEqual([A1]);
    expect(ids(await prepare({ department: "Gamma Unit" })).sort()).toEqual(
      [G1, G2, G3, A2].sort(),
    );
  });

  it("§H a deactivated, deleted or on-leave doctor disappears from the roster", async () => {
    mocks.tables.profiles = mocks.tables.profiles!.map((row) =>
      row.id === G1 ? { ...row, is_active: false } : row,
    );
    mocks.tables.profiles = mocks.tables.profiles!.map((row) =>
      row.id === G2 ? { ...row, is_deleted: true } : row,
    );
    mocks.tables.doctor_unavailability = [
      {
        doctor_id: G3,
        starts_at: "2026-08-24T00:00:00.000Z",
        ends_at: "2026-08-30T00:00:00.000Z",
        is_active: true,
      },
    ];
    const result = await prepare({ department: "Gamma Unit" });
    expect(result.doctor_count).toBe(0);
    expect(names(result)).toEqual([]);
  });

  it("§H leave that has not started yet never removes a doctor", async () => {
    mocks.tables.doctor_unavailability = [
      {
        doctor_id: G3,
        starts_at: "2026-09-24T00:00:00.000Z",
        ends_at: "2026-09-30T00:00:00.000Z",
        is_active: true,
      },
    ];
    expect(names(await prepare({ department: "Gamma Unit" }))).toContain("Yara Mounir");
  });
});

// ---------------------------------------------------------------------------
// I · the invariant itself
// ---------------------------------------------------------------------------

describe("P11 §I · displayable doctors ⊆ the authoritative roster", () => {
  it("holds for every department, by ids and by names", async () => {
    const directory = await loadDoctorDirectory(CLINIC);
    for (const department of directory.departments) {
      const authoritative = availableDoctorsInDepartment(directory, department.id);
      const offered = await prepare({ department: department.name });
      const roster = await listDoctors({ department: department.name });
      for (const result of [offered, roster]) {
        expect(new Set(ids(result)).size).toBe(ids(result).length);
        for (const id of ids(result)) {
          expect(authoritative.map((item) => item.id)).toContain(id);
        }
        for (const name of names(result)) {
          expect(authoritative.map((item) => item.name)).toContain(name);
        }
      }
    }
  });

  it("throws rather than presenting a doctor outside the roster", async () => {
    const directory = await loadDoctorDirectory(CLINIC);
    const intruder = directory.doctors.find((item) => item.id === B1)!;
    expect(() => assertRosterAuthority(directory, ALPHA, [intruder])).toThrow(
      /outside the authoritative department roster/,
    );
  });
});

// ---------------------------------------------------------------------------
// §6, §7 · the department → doctor transition, and holding onto it
// ---------------------------------------------------------------------------

describe("P11 §6-7 · department is settled, then doctors, and it stays settled", () => {
  it("moves straight from a resolved department to its full roster", async () => {
    const result = await prepare({ department: "Gamma Unit" });
    expect(result.field).toBe("doctor");
    expect(result.doctor_count).toBe(3);
    expect(String(result.guidance)).toContain("EVERY doctor");
  });

  it("says so explicitly when a department has exactly one doctor", async () => {
    const result = await prepare({ department: "قسم بيتا" });
    expect(result.only_one_available).toBe(true);
    expect(String(result.guidance)).toContain("Exactly one doctor");
  });

  it("reports an empty department as a domain outcome, not an error", async () => {
    mocks.tables.profiles = mocks.tables.profiles!.filter(
      (row) => row.department_id !== BETA,
    );
    const result = await prepare({ department: "قسم بيتا" });
    expect(result.doctor_count).toBe(0);
    expect(result.needs_selection).toBe(true);
    expect(result.technical_error).toBeUndefined();
  });

  it("answers 'who else?' from the settled department without restarting", async () => {
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: GAMMA, doctor_id: G1 } }),
    );
    const result = await listDoctors({ exclude_doctor_id: G1 });
    expect(result.department_already_selected).toBe(true);
    expect(names(result).sort()).toEqual(["Selim Adly", "Yara Mounir"]);
  });

  it("recognises an Arabic 'who else?' as a roster request, not a name", async () => {
    // The Arabic patterns were written with `\b`, which never matches between
    // Arabic letters — so these strings used to be scored against real doctor
    // names, and whichever ranked highest came back as a "did you mean".
    const { isOtherDoctorsRequest } = await import("@/lib/ai/doctor-directory");
    for (const phrase of [
      "في دكاترة غيره؟",
      "مين تاني؟",
      "عايز دكتور تاني",
      "الدكاترة المتاحين",
      "who else is available?",
    ]) {
      expect(isOtherDoctorsRequest(phrase), phrase).toBe(true);
    }
    expect(isOtherDoctorsRequest("رنا وصفي")).toBe(false);
  });

  it("keeps a named service lookup read-only", async () => {
    mocks.tables.services = [
      { id: "s1", name: "Consultation", price: 400, department_id: GAMMA, is_active: true, deleted_at: null },
    ];
    // Naming a department to ask about services must not silently select it
    // for a later booking.
    const result = await services({ department: "Gamma Unit" });
    expect(result.found).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("does not move a booking that has already settled a department", async () => {
    mocks.tables.services = [
      { id: "s1", name: "Consultation", price: 400, department_id: ALPHA, is_active: true, deleted_at: null },
    ];
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: ALPHA } }),
    );
    await services({ department: "Gamma Unit" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("clears the day and the time when the department changes", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: ALPHA,
          doctor_id: A1,
          appointment_date: "2026-09-01",
          appointment_time: 600,
        },
      }),
    );
    await prepare({ department: "Gamma Unit" });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({
          department_id: GAMMA,
          doctor_id: "",
          appointment_date: "",
          appointment_time: "",
        }),
      }),
    );
  });
});
