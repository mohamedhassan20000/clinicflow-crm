import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  results: {
    assistant_launcher_settings: {
      data: [] as Array<{ area: string; role: "admin" | "manager" | "receptionist" | "doctor"; enabled: boolean }>,
      error: null as unknown,
    },
    assistant_launcher_user_overrides: {
      data: [] as Array<{ user_id: string; area: string; enabled: boolean }>,
      error: null as unknown,
    },
    profiles: {
      data: [] as Array<{ id: string; full_name: string; role: "admin" | "manager" | "receptionist" | "doctor" }>,
      error: null as unknown,
    },
  },
  queries: [] as Array<{
    table: string;
    filters: Array<[string, unknown]>;
  }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: (table: keyof typeof mocks.results) => {
      const log = { table, filters: [] as Array<[string, unknown]> };
      mocks.queries.push(log);
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          log.filters.push([column, value]);
          return query;
        }),
        is: vi.fn((column: string, value: unknown) => {
          log.filters.push([column, value]);
          return query;
        }),
        in: vi.fn((column: string, value: unknown) => {
          log.filters.push([column, value]);
          return query;
        }),
        order: vi.fn(() => query),
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(mocks.results[table]).then(resolve, reject),
      };
      return query;
    },
  }),
}));

import { getAssistantLauncherCustomization } from "@/lib/ai/launcher-customization";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "owner@clinic.test",
  role: "admin" as const,
  fullName: "Owner",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.results.assistant_launcher_settings = { data: [], error: null };
  mocks.results.assistant_launcher_user_overrides = { data: [], error: null };
  mocks.results.profiles = { data: [], error: null };
});

describe("P4.9B customization read model", () => {
  it("returns the complete registry matrix and only eligible persisted choices", async () => {
    const doctorId = "22222222-2222-4222-8222-222222222222";
    mocks.results.assistant_launcher_settings.data = [
      { area: "patient", role: "doctor", enabled: false },
      // A corrupt/stale unsupported combination must never become a UI toggle.
      { area: "revenue", role: "doctor", enabled: true },
    ];
    mocks.results.assistant_launcher_user_overrides.data = [
      { user_id: doctorId, area: "patient", enabled: true },
      { user_id: doctorId, area: "revenue", enabled: true },
    ];
    mocks.results.profiles.data = [
      { id: doctorId, full_name: "Dr. Lina", role: "doctor" },
    ];

    const result = await getAssistantLauncherCustomization(USER);

    expect(result.roleSettings.map((row) => row.area)).toEqual([
      "patient",
      "appointments",
      "dashboard",
      "revenue",
      "reports",
      "invoices",
      "staff",
      "departments",
      "doctor-schedule",
    ]);
    expect(result.roleSettings.find((row) => row.area === "patient")).toMatchObject({
      eligibleRoles: ["doctor"],
      roleSettings: { doctor: false },
    });
    expect(result.roleSettings.find((row) => row.area === "revenue")?.roleSettings)
      .toEqual({});
    expect(result.staff).toEqual([
      {
        id: doctorId,
        fullName: "Dr. Lina",
        role: "doctor",
        overrides: { patient: true },
      },
    ]);
  });

  it("pins every read to the authenticated clinic and excludes inactive/deleted staff", async () => {
    await getAssistantLauncherCustomization(USER);

    for (const query of mocks.queries) {
      expect(query.filters).toContainEqual(["clinic_id", USER.clinicId]);
    }
    const profiles = mocks.queries.find((query) => query.table === "profiles");
    expect(profiles?.filters).toEqual(expect.arrayContaining([
      ["is_active", true],
      ["is_deleted", false],
      ["deleted_at", null],
      ["role", ["admin", "manager", "receptionist", "doctor"]],
    ]));
  });

  it("fails closed when any placement or staff read fails", async () => {
    mocks.results.assistant_launcher_user_overrides.error = { code: "PGRST205" };
    await expect(getAssistantLauncherCustomization(USER)).rejects.toThrow(
      "Failed to load Assistant launcher customization",
    );
  });
});
