"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { getPrimaryClinicAdminId, isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { resetUserPageVisibilityToRoleDefaults } from "@/actions/page-permissions";
import { getRolePageSlugs } from "@/lib/page-permissions";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import {
  REPORT_CATALOG,
  reportDefaultVisibleForRole,
  reportsOpenableByRole,
} from "@/lib/reports/catalog";
import type { Database } from "@/types/database";
import { domainFailureToActionResult } from "@/actions/_domain";
import { saveReportPermissionsMutation } from "@/lib/settings/mutations";

type UserRole = Database["public"]["Enums"]["user_role"];

export type StaffReportPermission = {
  reportId: ClinicReportId;
  isVisible: boolean;
  /** Clinic-wide financial figures — surfaced so the UI can flag it. */
  financial: boolean;
  /** Clinic-wide administrative/performance report. */
  administrative: boolean;
};

export type StaffReportPermissionsRow = {
  id: string;
  fullName: string;
  role: UserRole;
  departmentName: string | null;
  /** Whether this employee's Reports page is enabled. When false the report
   * configuration section must be hidden/disabled. */
  reportsPageEnabled: boolean;
  permissions: StaffReportPermission[];
};

export type ReportPermissionResult = {
  error?: string;
  success?: boolean;
};

export type PendingReportVisibilityChange = {
  reportId: ClinicReportId;
  isVisible: boolean;
};

async function requirePrimaryAdmin() {
  const user = await requireRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
      ),
    };
  }
  return { user };
}

/** The report ids a role's data authorization can actually open. */
function configurableReportsForRole(role: UserRole): ClinicReportId[] {
  return reportsOpenableByRole(
    role as Parameters<typeof reportsOpenableByRole>[0],
  );
}

export async function listStaffReportPermissions(): Promise<{
  data?: StaffReportPermissionsRow[];
  error?: string;
}> {
  const access = await requirePrimaryAdmin();
  if ("error" in access) return { error: access.error };
  const { user } = access;

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const primaryAdminId = await getPrimaryClinicAdminId(user.clinicId);

  const { data: staffRows, error: staffError } = await adminClient
    .from("profiles")
    .select("id, full_name, role, department_id, departments(name)")
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .neq("id", primaryAdminId ?? "")
    .order("full_name");

  if (staffError) {
    return {
      error: await actionError(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }

  const staff = staffRows ?? [];
  const ids = staff.map((member) => member.id);

  const [reportPerms, pagePerms] = await Promise.all([
    ids.length
      ? adminClient
          .from("user_report_permissions")
          .select("user_id, report_id, is_visible")
          .eq("clinic_id", user.clinicId)
          .in("user_id", ids)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? adminClient
          .from("user_page_permissions")
          .select("user_id, page_slug, is_visible")
          .eq("clinic_id", user.clinicId)
          .in("user_id", ids)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (reportPerms.error || pagePerms.error) {
    return {
      error: await actionError(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }

  const reportByUser = new Map<string, Map<string, boolean>>();
  for (const row of reportPerms.data ?? []) {
    const map = reportByUser.get(row.user_id) ?? new Map();
    map.set(row.report_id, row.is_visible);
    reportByUser.set(row.user_id, map);
  }

  // Whether the Reports page is visible per user (stored override wins; else
  // role default). Only the reports page slug matters here.
  const reportsPageByUser = new Map<string, boolean>();
  for (const row of pagePerms.data ?? []) {
    if (row.page_slug === "reports") {
      reportsPageByUser.set(row.user_id, row.is_visible);
    }
  }

  return {
    data: staff.map((member) => {
      const department = Array.isArray(member.departments)
        ? member.departments[0]
        : member.departments;
      const stored = reportByUser.get(member.id) ?? new Map();
      const role = member.role as UserRole;
      const reportsEnabled =
        reportsPageByUser.get(member.id) ??
        getRolePageSlugs(role).includes("reports");

      return {
        id: member.id,
        fullName: member.full_name,
        role,
        departmentName: department?.name ?? null,
        reportsPageEnabled: reportsEnabled,
        permissions: configurableReportsForRole(role).map((reportId) => ({
          reportId,
          isVisible:
            stored.get(reportId) ??
            reportDefaultVisibleForRole(
              reportId,
              role as Parameters<typeof reportDefaultVisibleForRole>[1],
            ),
          financial: REPORT_CATALOG[reportId].financial,
          administrative: REPORT_CATALOG[reportId].administrative,
        })),
      };
    }),
  };
}

async function loadTarget(clinicId: string, targetUserId: string) {
  const adminClient = createClinicScopedAdminClient(clinicId);
  const { data: target, error } = await adminClient
    .from("profiles")
    .select("id, role, clinic_id")
    .eq("id", targetUserId)
    .eq("clinic_id", clinicId)
    .single();
  return { adminClient, target, error };
}

export async function saveUserReportVisibilityChanges(
  targetUserId: string,
  changes: PendingReportVisibilityChange[],
): Promise<ReportPermissionResult> {
  const user = await requireMutationRole("admin");
  // See saveUserPageVisibilityChanges: role-invalid report ids are dropped
  // before the single upsert, never turned into a partial write plus an error.
  const result = await saveReportPermissionsMutation(user, {
    target_user_id: targetUserId,
    changes: changes.map((change) => ({
      report_id: change.reportId,
      is_visible: change.isVisible,
    })),
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function updateUserReportVisibility(
  targetUserId: string,
  reportId: ClinicReportId,
  isVisible: boolean,
): Promise<ReportPermissionResult> {
  return saveUserReportVisibilityChanges(targetUserId, [{ reportId, isVisible }]);
}

/**
 * Reset to Product Defaults for one employee: restores default page visibility
 * AND default report visibility to the ClinicFlow role defaults (page + report
 * per-role defaults are code-owned). Does not enable everything — it removes the
 * employee's stored overrides so the role defaults apply.
 */
export async function resetUserVisibilityToDefaults(
  targetUserId: string,
): Promise<ReportPermissionResult> {
  const pageResult = await resetUserPageVisibilityToRoleDefaults(targetUserId);
  if (pageResult.error) return { error: pageResult.error };
  return resetUserReportVisibilityToRoleDefaults(targetUserId);
}

export async function resetUserReportVisibilityToRoleDefaults(
  targetUserId: string,
): Promise<ReportPermissionResult> {
  const user = await requireMutationRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
      ),
    };
  }
  const primaryAdminId = await getPrimaryClinicAdminId(user.clinicId);
  if (targetUserId === primaryAdminId) {
    return {
      error: await actionError(
        "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
      ),
    };
  }
  const { adminClient, target, error: targetError } = await loadTarget(
    user.clinicId,
    targetUserId,
  );
  if (targetError || !target) {
    return { error: await actionError("page-permissions.staffMemberNotFound") };
  }

  // Reset = drop all overrides; visibility then falls back to role defaults.
  const { error } = await adminClient
    .from("user_report_permissions")
    .delete()
    .eq("user_id", target.id)
    .eq("clinic_id", target.clinic_id);

  if (error) {
    return {
      error: await actionError(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }

  revalidatePath("/settings/customize");
  return { success: true };
}
