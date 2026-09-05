import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  rows: {
    departments: [] as Array<Record<string, unknown>>,
    doctors: [] as Array<Record<string, unknown>>,
    patient: null as Record<string, unknown> | null,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  getPatientClinicPublicInfo: async () => ({ data: { phone: null }, error: null }),
  // Table-aware and filter-aware: `prepare_booking` now reads departments,
  // profiles, doctor leave and the patient row through one client, so a mock
  // that answered every table with the same array would hide exactly the bugs
  // this file exists to catch.
  createClinicScopedAdminClient: () => ({
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const rows = () => {
        const source =
          table === "departments"
            ? mocks.rows.departments
            : table === "profiles"
              ? mocks.rows.doctors
              : table === "patients"
                ? (mocks.rows.patient ? [mocks.rows.patient] : [])
                : [];
        return (source as Array<Record<string, unknown>>).filter((row) =>
          filters.every((predicate) => predicate(row)),
        );
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        lte: () => builder,
        gt: () => builder,
        limit: async () => ({ data: rows(), error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      };
      return builder;
    },
  }),
}));

import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const opts = {} as never;

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    identityLockedUntil: null,
    clinicName: "Clinic",
    clinicLocale: "en",
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {},
    pendingClarification: null,
    ...overrides,
  };
}

function execute(input: { department?: string; doctor?: string }) {
  return prepareBookingTool({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    locale: "en",
  }).execute!(input, opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.patient = null;
  mocks.rows.departments = [
    { id: DEPARTMENT, name: "Cardiology", is_active: true, deleted_at: null },
    {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Dentistry",
      is_active: true,
      deleted_at: null,
    },
  ];
  mocks.rows.doctors = [
    {
      id: DOCTOR,
      full_name: "Mohamed Hassan",
      role: "doctor",
      department_id: DEPARTMENT,
      is_active: true,
      is_deleted: false,
      deleted_at: null,
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      full_name: "Ahmed Ali",
      role: "doctor",
      department_id: DEPARTMENT,
      is_active: true,
      is_deleted: false,
      deleted_at: null,
    },
  ];
  mocks.authorize.mockResolvedValue(identity());
});

describe("WhatsApp booking context", () => {
  it("does not disclose the treating doctor before booking identity confirmation", async () => {
    mocks.authorize.mockResolvedValue(identity({ linked: true, patientId: "patient-id" }));
    await expect(execute({})).rejects.toMatchObject({
      reason: "booking_identity_required",
    });
  });

  it("suggests the existing patient's treating doctor before department selection", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        linked: true,
        patientId: "patient-id",
        identityVerifiedAt: "2026-08-22T12:00:00.000Z",
      }),
    );
    mocks.rows.patient = {
      id: "patient-id",
      is_deleted: false,
      department_id: DEPARTMENT,
      assigned_doctor_id: DOCTOR,
    };
    const result = await execute({});
    expect(result).toMatchObject({
      existing_patient: true,
      treating_doctor: { id: DOCTOR, name: "Mohamed Hassan" },
    });
    // V2-CONTAINMENT — suggested, not settled. The guidance says so and the
    // result carries the flag the reply layer reads.
    expect(String((result as { guidance: string }).guidance)).toMatch(
      /suggestion, not a selection/i,
    );
    expect(result).toMatchObject({ treating_doctor_is_offer: true });
  });

  it("offers only real active departments for a new patient", async () => {
    expect(await execute({})).toMatchObject({
      needs_selection: true,
      field: "department",
      // Projected to id/name only: internal status columns never reach the model.
      departments: [
        { id: DEPARTMENT, name: "Cardiology" },
        { id: "55555555-5555-4555-8555-555555555555", name: "Dentistry" },
      ],
    });
  });

  it("resolves a misspelled department then offers only its doctors", async () => {
    expect(await execute({ department: "cardiolgy" })).toMatchObject({
      department: { id: DEPARTMENT },
      needs_selection: true,
      field: "doctor",
      doctors: [
        { id: DOCTOR, name: "Mohamed Hassan" },
        { id: "66666666-6666-4666-8666-666666666666", name: "Ahmed Ali" },
      ],
    });
  });

  it("resolves Arabic/ordinal doctor selection and persists real ids", async () => {
    const result = await execute({ department: "قلب", doctor: "الثاني" });
    expect(result).toMatchObject({
      resolved: true,
      department: { id: DEPARTMENT },
      doctor: { id: "66666666-6666-4666-8666-666666666666" },
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({
          department_id: DEPARTMENT,
          doctor_id: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    );
  });
});
