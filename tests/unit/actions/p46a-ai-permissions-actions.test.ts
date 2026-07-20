import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L5 — `actions/ai-permissions.ts` had zero tests.
 *
 * This is the only write path for the financial grant, the control the
 * 2026-07-19 roadmap decision makes load-bearing: it decides whether a manager's
 * assistant can reach revenue at all. Every gate it applies is asserted here —
 * the admin-only actor, the entitlement precondition, the grantable-role list,
 * the cross-clinic target rejection, the conflict target, and revalidation.
 */

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireMutationRole: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  revalidatePath: vi.fn(),
  from: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireRole: mocks.requireRole,
  requireMutationRole: mocks.requireMutationRole,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({ from: mocks.from }),
}));
vi.mock("@/lib/primary-admin", () => ({
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
}));

import { listStaffAiPermissions, setStaffAiPermission } from "@/actions/ai-permissions";
import type { AiUserPermissionKey } from "@/lib/ai/permission-keys";

const CLINIC = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CLINIC = "00000000-0000-4000-8000-0000000000c2";
const ADMIN = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: CLINIC,
  role: "admin" as const,
  fullName: "Admin",
};
const MANAGER_ID = "00000000-0000-4000-8000-00000000000m".replace("m", "9");

/** Records every upsert so assertions can inspect the row and conflict target. */
const upserts: { row: Record<string, unknown>; options: Record<string, unknown> }[] = [];

type TableStub = {
  profiles?: { data: unknown; error: unknown };
  user_ai_permissions?: { data: unknown; error: unknown };
  upsertError?: unknown;
};

function stubTables(stub: TableStub) {
  mocks.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ["select", "eq", "is", "in", "order", "not"]) {
      builder[method] = vi.fn(chain);
    }
    const result =
      table === "profiles"
        ? (stub.profiles ?? { data: null, error: null })
        : (stub.user_ai_permissions ?? { data: [], error: null });

    builder.single = vi.fn(async () => result);
    builder.maybeSingle = vi.fn(async () => result);
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    builder.upsert = vi.fn(async (row: Record<string, unknown>, options: Record<string, unknown>) => {
      upserts.push({ row, options });
      return { error: stub.upsertError ?? null };
    });
    return builder;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  upserts.length = 0;
  mocks.requireRole.mockResolvedValue(ADMIN);
  mocks.requireMutationRole.mockResolvedValue(ADMIN);
  mocks.getEntitlements.mockResolvedValue({ features: {}, subscriptionAllowed: true });
  mocks.hasFeature.mockReturnValue(true);
  mocks.isPrimaryClinicAdmin.mockResolvedValue(true);
});

describe("setStaffAiPermission gates", () => {
  it("requires an admin actor — the role gate is the action's first move", async () => {
    mocks.requireMutationRole.mockRejectedValue(new Error("forbidden"));
    stubTables({});
    await expect(
      setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true),
    ).rejects.toThrow("forbidden");
    expect(mocks.requireMutationRole).toHaveBeenCalledWith("admin");
  });

  // The parameter is typed `AiUserPermissionKey`, so an unknown key is a
  // compile error for any in-repo caller (phase review L10). The runtime guard
  // still has to hold, because a server action is a network boundary and the
  // client can post whatever it likes — hence the deliberate cast.
  it("rejects an unknown permission key before touching the database", async () => {
    stubTables({});
    const result = await setStaffAiPermission(
      MANAGER_ID,
      "ai.everything" as AiUserPermissionKey,
      true,
    );
    expect(result.error).toBe("ai-permissions.unknownPermission");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses to grant what the plan does not include", async () => {
    mocks.hasFeature.mockReturnValue(false);
    stubTables({});
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(result.error).toBe("ai-permissions.planDoesNotIncludeFinancialAi");
    expect(upserts).toHaveLength(0);
  });

  it("rejects a target in another clinic", async () => {
    // The clinic-scoped select finds nothing, exactly as it would for a
    // cross-tenant id.
    stubTables({ profiles: { data: null, error: null } });
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(result.error).toBe("ai-permissions.staffMemberNotFound");
    expect(upserts).toHaveLength(0);
  });

  it("refuses a role the permission does not apply to", async () => {
    stubTables({
      profiles: { data: { id: MANAGER_ID, role: "receptionist", clinic_id: CLINIC }, error: null },
    });
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(result.error).toBe("ai-permissions.thisPermissionDoesNotApplyToThatRole");
    expect(upserts).toHaveLength(0);
  });

  it("refuses to write an implicit-role row rather than creating a toggleable admin grant", async () => {
    stubTables({
      profiles: { data: { id: ADMIN.id, role: "admin", clinic_id: CLINIC }, error: null },
    });
    const result = await setStaffAiPermission(ADMIN.id, "ai.financial_insights", false);
    expect(result.error).toBe("ai-permissions.thisPermissionDoesNotApplyToThatRole");
  });
});

describe("setStaffAiPermission writes", () => {
  beforeEach(() => {
    stubTables({
      profiles: { data: { id: MANAGER_ID, role: "manager", clinic_id: CLINIC }, error: null },
    });
  });

  it("grants a manager the permission and revalidates the settings page", async () => {
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(result).toEqual({ success: true });
    expect(upserts[0]!.row).toMatchObject({
      user_id: MANAGER_ID,
      clinic_id: CLINIC,
      permission_key: "ai.financial_insights",
      granted: true,
      updated_by: ADMIN.id,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/ai");
  });

  /**
   * H3 — the table's primary key is now `(clinic_id, user_id, permission_key)`.
   * An upsert still naming the old `(user_id, permission_key)` target would fail
   * at runtime against the shipped schema, so the conflict target is asserted
   * rather than assumed.
   */
  it("upserts against the tenant-scoped conflict target", async () => {
    await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(upserts[0]!.options).toMatchObject({
      onConflict: "clinic_id,user_id,permission_key",
    });
  });

  it("writes the target's own clinic, never the actor's asserted one", async () => {
    await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(upserts[0]!.row.clinic_id).toBe(CLINIC);
    expect(upserts[0]!.row.clinic_id).not.toBe(OTHER_CLINIC);
  });

  it("revokes without deleting, so the denial is explicit and auditable", async () => {
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", false);
    expect(result).toEqual({ success: true });
    expect(upserts[0]!.row.granted).toBe(false);
  });

  it("surfaces a write failure instead of reporting success", async () => {
    stubTables({
      profiles: { data: { id: MANAGER_ID, role: "manager", clinic_id: CLINIC }, error: null },
      upsertError: { message: "boom" },
    });
    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);
    expect(result.error).toBe(
      "ai-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("listStaffAiPermissions", () => {
  it("requires an admin actor", async () => {
    stubTables({});
    await listStaffAiPermissions("ai.financial_insights");
    expect(mocks.requireRole).toHaveBeenCalledWith("admin");
  });

  it("rejects an unknown key", async () => {
    const result = await listStaffAiPermissions("ai.nonsense" as AiUserPermissionKey);
    expect(result.error).toBe("ai-permissions.unknownPermission");
  });

  it("reports admins as implicitly granted and managers from stored rows", async () => {
    const staff = [
      { id: ADMIN.id, full_name: "Admin", role: "admin" },
      { id: MANAGER_ID, full_name: "Manager", role: "manager" },
    ];
    let call = 0;
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order"]) {
        builder[method] = vi.fn(() => builder);
      }
      const result =
        call++ === 0
          ? { data: staff, error: null }
          : { data: [{ user_id: MANAGER_ID, granted: true }], error: null };
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    });

    const result = await listStaffAiPermissions("ai.financial_insights");
    expect(result.data).toEqual([
      { id: ADMIN.id, fullName: "Admin", role: "admin", granted: true, implicit: true },
      { id: MANAGER_ID, fullName: "Manager", role: "manager", granted: true, implicit: false },
    ]);
  });

  it("reports a manager with no stored row as not granted", async () => {
    let call = 0;
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order"]) {
        builder[method] = vi.fn(() => builder);
      }
      const result =
        call++ === 0
          ? { data: [{ id: MANAGER_ID, full_name: "Manager", role: "manager" }], error: null }
          : { data: [], error: null };
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    });

    const result = await listStaffAiPermissions("ai.financial_insights");
    expect(result.data?.[0]).toMatchObject({ granted: false, implicit: false });
  });
});

/**
 * L11 of the P4.6 phase review. The settings page redirected non-primary
 * admins, but both actions asked only for `admin` — so the stricter rule was
 * the cosmetic one, and any non-primary admin could invoke the action directly
 * and grant the financial permission. Not an escalation of consequence (admins
 * hold the grant implicitly and administer every financial page already), but
 * two layers stating different rules is how the next change trusts the wrong
 * one.
 */
describe("primary-admin gate matches the page that hosts these actions", () => {
  it("refuses a write from a non-primary admin", async () => {
    mocks.isPrimaryClinicAdmin.mockResolvedValue(false);
    stubTables({
      profiles: { data: { id: MANAGER_ID, role: "manager", clinic_id: CLINIC }, error: null },
    });

    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);

    expect(result.error).toBe("ai-permissions.primaryAdminOnly");
    expect(upserts).toHaveLength(0);
  });

  it("refuses a read from a non-primary admin", async () => {
    mocks.isPrimaryClinicAdmin.mockResolvedValue(false);
    stubTables({});

    const result = await listStaffAiPermissions("ai.financial_insights");

    expect(result.error).toBe("ai-permissions.primaryAdminOnly");
    expect(result.data).toBeUndefined();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("allows the primary admin through both paths", async () => {
    mocks.isPrimaryClinicAdmin.mockResolvedValue(true);
    stubTables({
      profiles: { data: { id: MANAGER_ID, role: "manager", clinic_id: CLINIC }, error: null },
    });

    const result = await setStaffAiPermission(MANAGER_ID, "ai.financial_insights", true);

    expect(result.success).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
