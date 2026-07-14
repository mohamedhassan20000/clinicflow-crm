import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const STAFF_ID = "33333333-3333-4333-8333-333333333333";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    role: "receptionist",
    full_name: "Test User",
    clinic_id: "clinic-1",
    department_id: null,
    must_change_password: false,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

function staffForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("full_name", "Staff User");
  form.set("email", "staff@example.com");
  form.set("temporary_password", "TempPass123");
  form.set("role", "receptionist");
  form.set("department_id", "");
  form.set("phone", "");
  form.set("is_active", "true");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

async function loadRbac() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("server-only", () => ({}));
  vi.doMock("next/navigation", () => ({
    redirect: mocks.state.redirect,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const rbac = await import("@/lib/rbac");
  return { ...rbac, mocks };
}

async function loadAuthActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
    revalidateTag: vi.fn(),
  }));
  vi.doMock("next/navigation", () => ({
    redirect: mocks.state.redirect,
  }));
  vi.doMock("next/headers", () => ({
    headers: vi.fn(async () => new Headers()),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: vi.fn(() => mocks.client()),
    createClinicScopedAdminClient: vi.fn(() => mocks.client()),
  }));
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: vi.fn(),
  }));

  const auth = await import("@/actions/auth");
  return { ...auth, mocks };
}

async function loadSettingsActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
    revalidateTag: vi.fn(),
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
    requireMutationRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: vi.fn(() => mocks.client()),
    createClinicScopedAdminClient: vi.fn(() => mocks.client()),
  }));
  vi.doMock("@/actions/page-permissions", () => ({
    ensureDefaultPagePermissions: vi.fn(async () => ({ success: true })),
  }));

  const settings = await import("@/actions/settings");
  return { ...settings, mocks };
}

describe("auth and RBAC boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getAuthedUser rejects inactive profiles", async () => {
    const { getAuthedUser, mocks } = await loadRbac();
    mocks.state.tableResults["profiles.select"] = {
      data: profile({ is_active: false }),
      error: null,
    };

    await expect(getAuthedUser()).resolves.toBeNull();
  });

  it("requireUser redirects deleted and soft-deleted profiles to login", async () => {
    const { requireUser, mocks } = await loadRbac();
    mocks.state.tableResults["profiles.select"] = {
      data: profile({ is_deleted: true, deleted_at: "2026-05-01T00:00:00Z" }),
      error: null,
    };

    await requireUser();

    expect(mocks.state.redirect).toHaveBeenCalledWith("/login");
  });

  it("requirePlatformAdmin accepts a platform admin without requiring a clinic profile", async () => {
    const { requirePlatformAdmin, mocks } = await loadRbac();
    mocks.state.authGetUser.mockResolvedValue({
      data: { user: { id: "platform-user", email: "operator@example.com" } },
      error: null,
    });
    mocks.state.tableResults["platform_admins.select"] = {
      data: { user_id: "platform-user" },
      error: null,
    };

    await expect(requirePlatformAdmin()).resolves.toEqual({
      id: "platform-user",
      email: "operator@example.com",
    });
  });

  it("requirePlatformAdmin fails closed for an authenticated clinic user", async () => {
    const { requirePlatformAdmin, mocks } = await loadRbac();
    mocks.state.authGetUser.mockResolvedValue({
      data: { user: { id: "clinic-user", email: "admin@example.com" } },
      error: null,
    });
    mocks.state.tableResults["platform_admins.select"] = {
      data: null,
      error: null,
    };

    await requirePlatformAdmin();

    expect(mocks.state.redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("uses the freshly signed-in user when choosing the login redirect", async () => {
    const { signIn, mocks } = await loadAuthActions();
    mocks.state.authSignInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: "fresh-login-user",
          email: "manager@example.com",
        },
      },
      error: null,
    });
    mocks.state.authGetUser.mockResolvedValue({
      data: {
        user: {
          id: "stale-cookie-user",
          email: "old@example.com",
        },
      },
      error: null,
    });
    mocks.state.tableResults["profiles.select"] = {
      data: profile({ must_change_password: false }),
      error: null,
    };
    const form = new FormData();
    form.set("email", "manager@example.com");
    form.set("password", "NewPass123");

    const result = await signIn(form);

    expect(result).toEqual({ ok: true, redirectTo: "/dashboard" });
    expect(mocks.state.authGetUser).not.toHaveBeenCalled();
    expect(mocks.state.queryLog).toContainEqual({
      table: "profiles",
      operation: "select",
      args: ["eq", "id", "fresh-login-user"],
    });
    expect(mocks.state.rpc).toHaveBeenCalledWith("record_own_last_login");
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "update",
      }),
    );
  });

  it("does not block login if last-login tracking fails", async () => {
    const { signIn, mocks } = await loadAuthActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.authSignInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: "fresh-login-user",
          email: "manager@example.com",
        },
      },
      error: null,
    });
    mocks.state.tableResults["profiles.select"] = {
      data: profile({ must_change_password: true }),
      error: null,
    };
    mocks.state.rpcResults.record_own_last_login = {
      data: null,
      error: {
        code: "42501",
        message: "last login denied",
        details: "policy mismatch",
        hint: "check rpc",
      },
    };
    const form = new FormData();
    form.set("email", "manager@example.com");
    form.set("password", "TempPass123");

    const result = await signIn(form);

    expect(result).toEqual({ ok: true, redirectTo: "/change-password" });
    expect(consoleError).toHaveBeenCalledWith(
      "last_login_update_failed",
      expect.objectContaining({
        code: "42501",
        message: "last login denied",
        details: "policy mismatch",
        hint: "check rpc",
        userId: "fresh-login-user",
      }),
    );
  });

  it("clears forced password changes through the secure RPC helper", async () => {
    const { changePassword, mocks } = await loadAuthActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { must_change_password: false },
      error: null,
    };
    const form = new FormData();
    form.set("password", "NewPass123");
    form.set("confirmPassword", "NewPass123");

    const result = await changePassword(null, form);

    expect(result).toEqual({ ok: true, redirectTo: "/login?password_changed=1" });
    expect(mocks.state.authUpdateUser).toHaveBeenCalledWith({
      password: "NewPass123",
    });
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "clear_own_must_change_password",
    );
    expect(mocks.state.authSignOut).toHaveBeenCalled();
  });

  it("returns the RPC error if the flag clear fails", async () => {
    const { changePassword, mocks } = await loadAuthActions();
    mocks.state.rpcResults.clear_own_must_change_password = {
      data: null,
      error: { message: "Managers cannot update protected staff profile fields" },
    };
    const form = new FormData();
    form.set("password", "NewPass123");
    form.set("confirmPassword", "NewPass123");

    const result = await changePassword(null, form);

    expect(result.error).toBe("We could not complete this request. Please try again.");
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "clear_own_must_change_password",
    );
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "update",
      }),
    );
    expect(mocks.state.authSignOut).not.toHaveBeenCalled();
    expect(mocks.state.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("staff permission boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prevents managers from creating admin users", async () => {
    const { createStaff, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "manager";

    const result = await createStaff(
      null,
      staffForm({ role: "admin", email: "admin@example.com" }),
    );

    expect(result).toEqual({ error: "Only admins can create admin users." });
    expect(mocks.state.adminCreateUser).not.toHaveBeenCalled();
  });

  it("prevents managers from changing staff roles", async () => {
    const { updateStaff, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "manager";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID, clinic_id: "clinic-1", role: "receptionist" },
      error: null,
    };

    const result = await updateStaff(
      STAFF_ID,
      null,
      staffForm({ role: "doctor" }),
    );

    expect(result).toEqual({ error: "Only admins can change staff roles." });
    expect(mocks.state.tableResults["profiles.update"]).toBeUndefined();
  });

  it("prevents managers from managing admin users", async () => {
    const { updateStaff, resetStaffPassword, mocks } =
      await loadSettingsActions();
    mocks.state.authedUser.role = "manager";
    mocks.state.tableResults["profiles.select"] = [
      { data: { id: STAFF_ID, clinic_id: "clinic-1", role: "admin" }, error: null },
      { data: { id: STAFF_ID, clinic_id: "clinic-1", role: "admin" }, error: null },
    ];

    const updateResult = await updateStaff(
      STAFF_ID,
      null,
      staffForm({ role: "admin" }),
    );
    const resetResult = await resetStaffPassword(STAFF_ID, "TempPass123");

    expect(updateResult).toEqual({
      error: "Only admins can manage admin users.",
    });
    expect(resetResult).toEqual({
      error: "Only admins can manage admin users.",
    });
    expect(mocks.state.adminUpdateUserById).not.toHaveBeenCalled();
  });

  it("allows admins to update admin users where intended", async () => {
    const { updateStaff, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID, clinic_id: "clinic-1", role: "admin" },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = {
      data: null,
      error: null,
      count: 1,
    };

    const result = await updateStaff(
      STAFF_ID,
      null,
      staffForm({ role: "admin", full_name: "Admin User" }),
    );

    expect(result).toEqual({ success: true });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/settings/staff");
  });
});
