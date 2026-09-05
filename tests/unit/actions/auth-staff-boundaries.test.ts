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
  const mutations = await import("@/lib/settings/mutations");
  return { ...settings, ...mutations, mocks };
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

  it("returns a localized top-level error for invalid invoice follow-up settings", async () => {
    const { updateInvoiceFollowupSettings, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    const result = await updateInvoiceFollowupSettings({
      enabled: true,
      firstDays: 10,
      secondDays: 5,
      emailSubject: null,
      emailBody: null,
    });

    expect(result.error).toBe(
      "The second reminder must be scheduled after the first.",
    );
    expect(result.fieldErrors?.second_days).toEqual([
      "The second reminder must be scheduled after the first.",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /settings\.invoiceFollowupSecondAfterFirst/,
    );
  });

  it("keeps Assistant staff creation password-free and excludes manager/admin roles", async () => {
    const { staffCreateNonPrivilegedActionSchema } = await loadSettingsActions();
    const base = {
      full_name: "Staff User",
      email: "staff@example.com",
      department_id: null,
      phone: null,
      supervising_doctor_ids: [],
    };
    expect(staffCreateNonPrivilegedActionSchema.safeParse({
      ...base,
      role: "receptionist",
    }).success).toBe(true);
    expect(staffCreateNonPrivilegedActionSchema.safeParse({
      ...base,
      role: "manager",
    }).success).toBe(false);
    expect(staffCreateNonPrivilegedActionSchema.safeParse({
      ...base,
      role: "admin",
    }).success).toBe(false);
    expect(staffCreateNonPrivilegedActionSchema.safeParse({
      ...base,
      role: "receptionist",
      temporary_password: "ModelInvented1",
    }).success).toBe(false);
  });

  it("generates an Assistant-created staff password only on the server and returns it once", async () => {
    const { createStaffMutation, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    const result = await createStaffMutation(
      mocks.state.authedUser as never,
      {
        full_name: "Staff User",
        email: "staff@example.com",
        role: "receptionist",
        department_id: null,
        phone: null,
        supervising_doctor_ids: [],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected staff creation to succeed");
    expect(result.data.one_time_temporary_password).toMatch(/^[A-Z].*[0-9]/);
    expect(mocks.state.adminCreateUser).toHaveBeenCalledWith({
      email: "staff@example.com",
      password: result.data.one_time_temporary_password,
      email_confirm: true,
    });
    expect(JSON.stringify(result.audit)).not.toContain(
      result.data.one_time_temporary_password,
    );
  });

  it("rolls back both profile and auth principal when permission seeding fails", async () => {
    const { createStaffMutation, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["user_page_permissions.insert"] = {
      data: null,
      error: { code: "42501", message: "permission seeding denied" },
    };

    const result = await createStaffMutation(
      mocks.state.authedUser as never,
      {
        full_name: "Staff User",
        email: "staff@example.com",
        temporary_password: "TempPass123",
        role: "receptionist",
        department_id: null,
        phone: null,
        supervising_doctor_ids: [],
      },
    );

    expect(result.ok).toBe(false);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "delete",
        args: ["eq", "clinic_id", "clinic-1"],
      }),
    );
    expect(mocks.state.adminDeleteUser).toHaveBeenCalledWith("created-user-1");
  });

  it("uses the legacy customization fallback when the page-permissions table is absent", async () => {
    const { createStaffMutation, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["user_page_permissions.insert"] = {
      data: null,
      error: { code: "42P01", message: "user_page_permissions missing" },
    };

    const result = await createStaffMutation(
      mocks.state.authedUser as never,
      {
        full_name: "Staff User",
        email: "staff@example.com",
        temporary_password: "TempPass123",
        role: "receptionist",
        department_id: null,
        phone: null,
        supervising_doctor_ids: [],
      },
    );

    expect(result.ok).toBe(true);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "user_customizations",
        operation: "insert",
      }),
    );
  });

  it("rejects missing departments and invalid assistant supervisors before auth creation", async () => {
    const { createStaffMutation, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    const departmentId = "77777777-7777-4777-8777-777777777777";
    const doctorId = "88888888-8888-4888-8888-888888888888";
    mocks.state.tableResults["departments.select"] = { data: null, error: null };
    const missingDepartment = await createStaffMutation(
      mocks.state.authedUser as never,
      {
        full_name: "Doctor User",
        email: "doctor@example.com",
        temporary_password: "TempPass123",
        role: "doctor",
        department_id: departmentId,
        phone: null,
        supervising_doctor_ids: [],
      },
    );
    expect(missingDepartment.ok).toBe(false);

    mocks.state.tableResults["departments.select"] = {
      data: { id: departmentId },
      error: null,
    };
    mocks.state.tableResults["profiles.select"] = { data: [], error: null };
    const invalidSupervisor = await createStaffMutation(
      mocks.state.authedUser as never,
      {
        full_name: "Assistant User",
        email: "assistant@example.com",
        temporary_password: "TempPass123",
        role: "assistant",
        department_id: departmentId,
        phone: null,
        supervising_doctor_ids: [doctorId],
      },
    );
    expect(invalidSupervisor.ok).toBe(false);
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

  it("rolls back the role and assistant assignments when role-page seeding fails", async () => {
    const { changeStaffRoleMutation, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    const doctorId = "88888888-8888-4888-8888-888888888888";
    mocks.state.tableResults["profiles.select"] = {
      data: profile({ id: STAFF_ID, role: "assistant" }),
      error: null,
    };
    mocks.state.tableResults["assistant_doctor_assignments.select"] = {
      data: [{ doctor_id: doctorId }],
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = [
      { data: null, error: null, count: 1 },
      { data: null, error: null, count: 1 },
    ];
    mocks.state.rpcResults.replace_assistant_doctor_assignments = {
      data: true,
      error: null,
    };
    mocks.state.tableResults["user_page_permissions.insert"] = {
      data: null,
      error: { code: "42501", message: "permission seeding denied" },
    };

    const result = await changeStaffRoleMutation(
      mocks.state.authedUser as never,
      {
        staff_id: STAFF_ID,
        role: "doctor",
        department_id: null,
        supervising_doctor_ids: [],
      },
    );

    expect(result.ok).toBe(false);
    const profileUpdates = mocks.state.queryLog.filter(
      (entry) =>
        entry.table === "profiles" &&
        entry.operation === "update" &&
        typeof entry.args[0] === "object",
    );
    expect(profileUpdates[0]?.args[0]).toMatchObject({ role: "doctor" });
    expect(profileUpdates[1]?.args[0]).toMatchObject({ role: "assistant" });
    expect(mocks.state.rpc).toHaveBeenNthCalledWith(
      2,
      "replace_assistant_doctor_assignments",
      {
        p_assistant_id: STAFF_ID,
        p_doctor_ids: [doctorId],
      },
    );
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

  it("keeps the Profile section update scoped to name and phone for one staff member", async () => {
    const { updateStaffProfileSection, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID, clinic_id: "clinic-1", role: "receptionist" },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = { data: null, error: null, count: 1 };

    await expect(updateStaffProfileSection(STAFF_ID, {
      full_name: "Updated Staff",
      phone: "+905550000000",
    })).resolves.toEqual({ success: true });

    const update = mocks.state.queryLog.find((entry) =>
      entry.table === "profiles" && entry.operation === "update");
    expect(update?.args[0]).toEqual({
      full_name: "Updated Staff",
      phone: "+905550000000",
    });
    expect(update?.args[0]).not.toHaveProperty("avatar_url");
    expect(update?.args[0]).not.toHaveProperty("professional_license_no");
    expect(update?.args[0]).not.toHaveProperty("role");
  });

  it("saves a non-doctor schedule only for the targeted staff member", async () => {
    const { upsertStaffSchedule, mocks } = await loadSettingsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: STAFF_ID, clinic_id: "clinic-1", role: "receptionist" },
      error: null,
    };
    const fd = new FormData();
    fd.set("schedule", JSON.stringify(Array.from({ length: 7 }, (_, day_of_week) => ({
      day_of_week,
      works: day_of_week === 1,
      start_time: day_of_week === 1 ? "09:00" : null,
      end_time: day_of_week === 1 ? "17:00" : null,
    }))));

    await expect(upsertStaffSchedule(STAFF_ID, null, fd)).resolves.toEqual({ success: true });
    expect(mocks.state.queryLog).toContainEqual(expect.objectContaining({
      table: "doctor_schedules",
      operation: "delete",
      args: ["eq", "doctor_id", STAFF_ID],
    }));
    const insert = mocks.state.queryLog.find((entry) =>
      entry.table === "doctor_schedules" && entry.operation === "insert");
    expect(insert?.args[0]).toEqual([{
      doctor_id: STAFF_ID,
      clinic_id: "clinic-1",
      day_of_week: 1,
      start_time: "09:00",
      end_time: "17:00",
    }]);
  });
});
