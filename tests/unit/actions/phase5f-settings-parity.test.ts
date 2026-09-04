import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5f review fixes — F3 and F4.
 *
 * F3: extracting the staff cores must not hand the Settings UI a restriction it
 * never had. `actions/settings-legacy.ts` let any admin update, deactivate,
 * trash or permanently delete the earliest-created admin; the shared cores had
 * started refusing all four with page-permission copy ("cannot be customized")
 * on a Deactivate/Delete click. These tests pin the legacy behaviour back.
 *
 * F4: the bulk Customize savers must filter to the target's role first and then
 * write once. Looping the per-item privileged core made a change set containing
 * `dashboard` (or a role-invalid slug/report) write a prefix of the list and
 * then report failure — permission state an admin cannot reason about.
 */

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  adminFrom: vi.fn(),
  sessionFrom: vi.fn(),
  getPrimaryClinicAdminId: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: mocks.revalidateTag,
}));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
  actionWeekday: (day: number) => Promise.resolve(String(day)),
  actionAppointmentStatus: (status: string) => Promise.resolve(status),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: mocks.requireMutationRole,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: mocks.adminFrom,
    auth: { admin: { deleteUser: mocks.deleteUser } },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mocks.sessionFrom }),
}));
vi.mock("@/lib/primary-admin", () => ({
  getPrimaryClinicAdminId: mocks.getPrimaryClinicAdminId,
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
}));

import {
  saveUserPageVisibilityChanges,
  updateUserPageVisibility,
} from "@/actions/page-permissions";
import { saveUserReportVisibilityChanges } from "@/actions/report-permissions";
import {
  setStaffActiveMutation,
  staffLifecycleMutation,
  updateStaffMutation,
} from "@/lib/settings/mutations";
import type { AuthedUser } from "@/lib/rbac";

const CLINIC = "00000000-0000-4000-8000-0000000000c1";
const PRIMARY_ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000002",
  clinicId: CLINIC,
  email: "second.admin@example.com",
  fullName: "Second Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

type Upsert = { rows: unknown; options: unknown };
const upserts: Record<string, Upsert[]> = {};

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRIMARY_ADMIN_ID,
    clinic_id: CLINIC,
    role: "admin",
    full_name: "Founding Admin",
    department_id: null,
    phone: null,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    must_change_password: false,
    ...overrides,
  };
}

/** Table stub that records upserts and lets each table return a fixed row. */
function stubAdminTables(rows: Record<string, unknown>) {
  mocks.adminFrom.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ["select", "eq", "is", "in", "order", "not", "delete"]) {
      builder[method] = vi.fn(chain);
    }
    const result = { data: rows[table] ?? null, error: null };
    builder.single = vi.fn(async () => result);
    builder.maybeSingle = vi.fn(async () => result);
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    builder.upsert = vi.fn(async (payload: unknown, options: unknown) => {
      (upserts[table] ??= []).push({ rows: payload, options });
      return { error: null };
    });
    return builder;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(upserts)) delete upserts[key];
  mocks.requireMutationRole.mockResolvedValue(ACTOR);
  mocks.getPrimaryClinicAdminId.mockResolvedValue(PRIMARY_ADMIN_ID);
  mocks.isPrimaryClinicAdmin.mockResolvedValue(true);
  mocks.sessionFrom.mockImplementation(() => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ["eq", "is", "in"]) builder[method] = vi.fn(chain);
    builder.update = vi.fn(chain);
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ error: null, count: 1 }).then(resolve);
    return builder;
  });
});

describe("F3 — the shared staff cores keep legacy Settings behaviour for a primary admin", () => {
  it("lets an admin demote the primary clinic admin, as settings-legacy did", async () => {
    stubAdminTables({ profiles: profileRow() });
    const result = await updateStaffMutation(
      ACTOR,
      {
        staff_id: PRIMARY_ADMIN_ID,
        values: {
          full_name: "Founding Admin",
          role: "manager",
          department_id: null,
          phone: null,
          is_active: true,
          supervising_doctor_ids: [],
        },
      },
      "preview",
    );
    expect(result.ok).toBe(true);
    expect(mocks.getPrimaryClinicAdminId).not.toHaveBeenCalled();
  });

  it("lets an admin deactivate the primary clinic admin, as settings-legacy did", async () => {
    stubAdminTables({ profiles: profileRow() });
    const result = await setStaffActiveMutation(
      ACTOR,
      { staff_id: PRIMARY_ADMIN_ID, is_active: false },
      "preview",
    );
    expect(result.ok).toBe(true);
    expect(mocks.getPrimaryClinicAdminId).not.toHaveBeenCalled();
  });

  it.each(["soft_delete", "permanent_delete"] as const)(
    "lets an admin %s the primary clinic admin, as settings-legacy did",
    async (operation) => {
      stubAdminTables({
        profiles: profileRow(
          operation === "permanent_delete"
            ? { is_deleted: true, deleted_at: "2026-08-01T00:00:00.000Z" }
            : {},
        ),
      });
      const result = await staffLifecycleMutation(
        ACTOR,
        operation,
        { staff_id: PRIMARY_ADMIN_ID },
        "preview",
      );
      expect(result.ok).toBe(true);
      expect(mocks.getPrimaryClinicAdminId).not.toHaveBeenCalled();
    },
  );

  it("never emits the page-permission 'cannot be customized' copy from a staff core", async () => {
    stubAdminTables({ profiles: profileRow() });
    for (const result of [
      await setStaffActiveMutation(
        ACTOR,
        { staff_id: PRIMARY_ADMIN_ID, is_active: false },
        "preview",
      ),
      await staffLifecycleMutation(
        ACTOR,
        "soft_delete",
        { staff_id: PRIMARY_ADMIN_ID },
        "preview",
      ),
    ]) {
      expect(result.ok || result.code).not.toBe(
        "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
      );
    }
  });
});

describe("F4 — bulk visibility saves filter first and write once", () => {
  const RECEPTIONIST = "00000000-0000-4000-8000-00000000000a";

  beforeEach(() => {
    mocks.getPrimaryClinicAdminId.mockResolvedValue(PRIMARY_ADMIN_ID);
    stubAdminTables({
      profiles: profileRow({
        id: RECEPTIONIST,
        role: "receptionist",
        full_name: "Sara Ahmed",
      }),
    });
  });

  it("drops dashboard and role-invalid slugs, persists every valid entry in one upsert", async () => {
    const result = await saveUserPageVisibilityChanges(RECEPTIONIST, [
      { slug: "patients", isVisible: false },
      { slug: "dashboard", isVisible: false },
      // `settings` is not in a receptionist's role page set; legacy dropped it
      // silently instead of failing the whole save.
      { slug: "settings", isVisible: false },
      { slug: "appointments", isVisible: true },
    ]);

    expect(result).toEqual({ success: true });
    expect(upserts.user_page_permissions).toHaveLength(1);
    const rows = upserts.user_page_permissions[0].rows as {
      page_slug: string;
      is_visible: boolean;
    }[];
    expect(rows.map((row) => row.page_slug).sort()).toEqual([
      "appointments",
      "patients",
    ]);
    expect(rows.every((row) => row.page_slug !== "dashboard")).toBe(true);
  });

  it("returns success without writing when nothing in the change set is valid", async () => {
    const result = await saveUserPageVisibilityChanges(RECEPTIONIST, [
      { slug: "dashboard", isVisible: false },
    ]);
    expect(result).toEqual({ success: true });
    expect(upserts.user_page_permissions).toBeUndefined();
  });

  it("keeps the single-item page saver's per-item refusals intact", async () => {
    const result = await updateUserPageVisibility(
      RECEPTIONIST,
      "dashboard",
      false,
    );
    expect(result.error).toBe("page-permissions.dashboardCannotBeHidden");
    expect(upserts.user_page_permissions).toBeUndefined();
  });

  it("drops reports outside the target role and writes the rest in one upsert", async () => {
    const result = await saveUserReportVisibilityChanges(RECEPTIONIST, [
      { reportId: "revenue", isVisible: false },
      // Not openable by a receptionist, and not a report id at all: both were
      // dropped by the legacy saver rather than failing the whole request.
      { reportId: "doctor_performance", isVisible: false },
      { reportId: "not_a_report" as never, isVisible: false },
      { reportId: "no_shows", isVisible: true },
    ]);

    expect(result).toEqual({ success: true });
    expect(upserts.user_report_permissions).toHaveLength(1);
    const rows = upserts.user_report_permissions[0].rows as {
      report_id: string;
    }[];
    expect(rows.map((row) => row.report_id).sort()).toEqual([
      "no_shows",
      "revenue",
    ]);
  });

  it("returns success without writing when every report is outside the role", async () => {
    const result = await saveUserReportVisibilityChanges(RECEPTIONIST, [
      { reportId: "doctor_performance", isVisible: false },
    ]);
    expect(result).toEqual({ success: true });
    expect(upserts.user_report_permissions).toBeUndefined();
  });
});
