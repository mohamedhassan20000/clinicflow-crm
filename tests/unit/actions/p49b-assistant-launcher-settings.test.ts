import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryLog = {
  client: "auth" | "admin";
  table: string;
  operation: "select" | "upsert" | "delete";
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, unknown]>;
};

const mocks = vi.hoisted(() => ({
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "owner@clinic.test",
    role: "admin" as const,
    fullName: "Owner",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  },
  primary: true,
  entitled: true,
  target: {
    id: "22222222-2222-4222-8222-222222222222",
    role: "doctor" as "admin" | "manager" | "receptionist" | "doctor",
  } as { id: string; role: "admin" | "manager" | "receptionist" | "doctor" } | null,
  targetError: null as unknown,
  writeError: null as unknown,
  logs: [] as QueryLog[],
  requireMutationRole: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  revalidatePath: vi.fn(),
}));

function builder(client: "auth" | "admin", table: string) {
  const entry: QueryLog = {
    client,
    table,
    operation: "select",
    filters: [],
  };
  mocks.logs.push(entry);
  const query = {
    select: vi.fn(() => query),
    upsert: vi.fn((payload: unknown, options: unknown) => {
      entry.operation = "upsert";
      entry.payload = payload;
      entry.options = options;
      return Promise.resolve({ data: null, error: mocks.writeError });
    }),
    delete: vi.fn(() => {
      entry.operation = "delete";
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return query;
    }),
    is: vi.fn((column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return query;
    }),
    single: vi.fn(async () => ({
      data: mocks.target,
      error: mocks.targetError,
    })),
    then: (
      resolve: (value: { data: null; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({ data: null, error: mocks.writeError }).then(
        resolve,
        reject,
      ),
  };
  return query;
}

vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
}));
vi.mock("@/lib/primary-admin", () => ({
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder("auth", table) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: (table: string) => builder("admin", table),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: async (key: string) => key,
}));

import {
  setAssistantRoleLauncherPlacement,
  setAssistantUserLauncherOverride,
} from "@/actions/assistant-launcher-settings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logs.length = 0;
  mocks.primary = true;
  mocks.entitled = true;
  mocks.target = {
    id: "22222222-2222-4222-8222-222222222222",
    role: "doctor",
  };
  mocks.targetError = null;
  mocks.writeError = null;
  mocks.requireMutationRole.mockResolvedValue(mocks.user);
  mocks.isPrimaryClinicAdmin.mockImplementation(async () => mocks.primary);
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockImplementation(() => mocks.entitled);
});

describe("P4.9B role placement actions", () => {
  it("writes through the authenticated RLS client with the server-owned clinic and actor", async () => {
    await expect(setAssistantRoleLauncherPlacement({
      area: "patient",
      role: "doctor",
      enabled: false,
    })).resolves.toEqual({ success: true });

    expect(mocks.requireMutationRole).toHaveBeenCalledWith("admin");
    expect(mocks.isPrimaryClinicAdmin).toHaveBeenCalledWith(
      mocks.user.id,
      mocks.user.clinicId,
    );
    expect(mocks.hasFeature).toHaveBeenCalledWith(
      { planSlug: "pro_ai" },
      "ai.assistant_customization",
    );
    expect(mocks.logs).toContainEqual(expect.objectContaining({
      client: "auth",
      table: "assistant_launcher_settings",
      operation: "upsert",
      payload: {
        clinic_id: mocks.user.clinicId,
        area: "patient",
        role: "doctor",
        enabled: false,
        updated_by: mocks.user.id,
      },
      options: { onConflict: "clinic_id,area,role" },
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/assistant");
  });

  it("deletes one exact role row when resetting to the code default", async () => {
    await expect(setAssistantRoleLauncherPlacement({
      area: "dashboard",
      role: "manager",
      enabled: null,
    })).resolves.toEqual({ success: true });

    expect(mocks.logs).toContainEqual(expect.objectContaining({
      client: "auth",
      table: "assistant_launcher_settings",
      operation: "delete",
      filters: [
        ["clinic_id", mocks.user.clinicId],
        ["area", "dashboard"],
        ["role", "manager"],
      ],
    }));
  });

  it("rejects a role/area combination absent from the launcher registry before authorization", async () => {
    await expect(setAssistantRoleLauncherPlacement({
      area: "revenue",
      role: "doctor",
      enabled: true,
    })).resolves.toEqual({
      error: "assistant-launcher-settings.areaNotAvailableForRole",
    });
    expect(mocks.requireMutationRole).not.toHaveBeenCalled();
    expect(mocks.logs).toEqual([]);
  });

  it("denies secondary admins and non-entitled clinics without writing", async () => {
    mocks.primary = false;
    await expect(setAssistantRoleLauncherPlacement({
      area: "dashboard",
      role: "admin",
      enabled: false,
    })).resolves.toEqual({
      error: "assistant-launcher-settings.primaryAdminOnly",
    });
    expect(mocks.logs).toEqual([]);

    mocks.primary = true;
    mocks.entitled = false;
    await expect(setAssistantRoleLauncherPlacement({
      area: "dashboard",
      role: "admin",
      enabled: false,
    })).resolves.toEqual({
      error: "assistant-launcher-settings.planDoesNotIncludeCustomization",
    });
    expect(mocks.logs).toEqual([]);
  });
});

describe("P4.9B per-user override actions", () => {
  it("validates the same-clinic active target before writing an override", async () => {
    await expect(setAssistantUserLauncherOverride({
      userId: mocks.target?.id,
      area: "patient",
      enabled: true,
    })).resolves.toEqual({ success: true });

    expect(mocks.logs[0]).toEqual(expect.objectContaining({
      client: "admin",
      table: "profiles",
      operation: "select",
      filters: expect.arrayContaining([
        ["clinic_id", mocks.user.clinicId],
        ["id", mocks.target?.id],
        ["is_active", true],
        ["is_deleted", false],
        ["deleted_at", null],
      ]),
    }));
    expect(mocks.logs).toContainEqual(expect.objectContaining({
      client: "auth",
      table: "assistant_launcher_user_overrides",
      operation: "upsert",
      payload: {
        clinic_id: mocks.user.clinicId,
        user_id: mocks.target?.id,
        area: "patient",
        enabled: true,
      },
      options: { onConflict: "clinic_id,user_id,area" },
    }));
  });

  it("denies missing/cross-tenant targets and unsupported target roles without a write", async () => {
    mocks.target = null;
    await expect(setAssistantUserLauncherOverride({
      userId: "33333333-3333-4333-8333-333333333333",
      area: "dashboard",
      enabled: true,
    })).resolves.toEqual({
      error: "assistant-launcher-settings.staffMemberOrAreaNotAvailable",
    });
    expect(mocks.logs.filter((entry) => entry.client === "auth")).toEqual([]);

    mocks.logs.length = 0;
    mocks.target = {
      id: "22222222-2222-4222-8222-222222222222",
      role: "doctor",
    };
    await expect(setAssistantUserLauncherOverride({
      userId: mocks.target.id,
      area: "revenue",
      enabled: true,
    })).resolves.toEqual({
      error: "assistant-launcher-settings.staffMemberOrAreaNotAvailable",
    });
    expect(mocks.logs.filter((entry) => entry.client === "auth")).toEqual([]);
  });

  it("removes only the selected user's exact area override", async () => {
    await expect(setAssistantUserLauncherOverride({
      userId: mocks.target?.id,
      area: "patient",
      enabled: null,
    })).resolves.toEqual({ success: true });

    expect(mocks.logs).toContainEqual(expect.objectContaining({
      client: "auth",
      table: "assistant_launcher_user_overrides",
      operation: "delete",
      filters: [
        ["clinic_id", mocks.user.clinicId],
        ["user_id", mocks.target?.id],
        ["area", "patient"],
      ],
    }));
  });
});
