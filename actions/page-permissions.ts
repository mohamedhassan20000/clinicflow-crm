"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { revalidatePath } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { getPrimaryClinicAdminId, isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  getRolePageSlugs,
  PAGE_DEFINITIONS,
  type PageSlug,
} from "@/lib/page-permissions";
import type { Database } from "@/types/database";
import { domainFailureToActionResult } from "@/actions/_domain";
import {
  savePagePermissionsMutation,
  setPagePermissionMutation,
} from "@/lib/settings/mutations";

type UserRole = Database["public"]["Enums"]["user_role"];

export type StaffPagePermission = {
  slug: PageSlug;
  /**
   * P2C — no `label` here on purpose. This crosses a server/client boundary, and an English label
   * baked in on the server would render in English no matter what language the reader chose. The
   * consumer translates `nav.tenant.<slug>`, which is the same key the sidebar uses, so the two can
   * never disagree about what a page is called.
   */
  isVisible: boolean;
  alwaysVisible: boolean;
};

export type StaffPagePermissionsRow = {
  id: string;
  fullName: string;
  role: UserRole;
  departmentName: string | null;
  permissions: StaffPagePermission[];
};

export type PagePermissionResult = {
  error?: string;
  success?: boolean;
};

export type PendingPageVisibilityChange = {
  slug: PageSlug;
  isVisible: boolean;
};

function isMissingPermissionsTable(error: { code?: string; message?: string } | null) {
  return (
    error?.code === "42P01" ||
    error?.message?.toLowerCase().includes("user_page_permissions") === true
  );
}

export async function ensureDefaultPagePermissions(
  userId: string,
  role: UserRole,
  clinicId: string,
): Promise<PagePermissionResult> {
  const actor = await requireMutationRole(["admin", "manager"]);
  if (actor.clinicId !== clinicId) return { error: await actionError("page-permissions.clinicScopeMismatch") };
  const adminClient = createClinicScopedAdminClient(clinicId);
  const rows = getRolePageSlugs(role).map((pageSlug) => ({
    user_id: userId,
    clinic_id: clinicId,
    page_slug: pageSlug,
    is_visible: true,
  }));

  const { error } = await adminClient
    .from("user_page_permissions")
    .upsert(rows, { onConflict: "user_id,page_slug" });

  if (isMissingPermissionsTable(error)) {
    return ensureDefaultPagePermissionsFallback(userId, role, clinicId);
  }
  if (error) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  return { success: true };
}

async function ensureDefaultPagePermissionsFallback(
  userId: string,
  role: UserRole,
  clinicId: string,
): Promise<PagePermissionResult> {
  const adminClient = createClinicScopedAdminClient(clinicId);
  const pages = getRolePageSlugs(role);

  for (const pageSlug of pages) {
    const { error: deleteError } = await adminClient
      .from("user_customizations")
      .delete()
      .eq("profile_id", userId)
      .eq("clinic_id", clinicId)
      .eq("feature", "_visible")
      .eq("page", pageSlug);
    if (deleteError) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  const rows = pages.map((pageSlug) => ({
    profile_id: userId,
    clinic_id: clinicId,
    feature: "_visible",
    page: pageSlug,
    access: "read_edit",
  }));
  const { error } = await adminClient
    .from("user_customizations")
    .upsert(rows, { onConflict: "profile_id,page,feature" });
  if (error) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  return { success: true };
}

export async function listStaffPagePermissions(): Promise<{
  data?: StaffPagePermissionsRow[];
  error?: string;
}> {
  const user = await requireRole("admin");
  if (
    user.role === "admin" &&
    !(await isPrimaryClinicAdmin(user.id, user.clinicId))
  ) {
    return { error: await actionError("page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility") };
  }
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const primaryAdminId = await getPrimaryClinicAdminId(user.clinicId);

  const { data: staffRows, error: staffError } = await adminClient
    .from("profiles")
    .select("id, full_name, role, department_id, departments(name)")
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .neq("id", primaryAdminId ?? "")
    .order("full_name");

  if (staffError) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  const staff =
    user.role === "manager"
      ? (staffRows ?? []).filter((member) => member.role !== "admin")
      : (staffRows ?? []);

  const ids = staff.map((member) => member.id);
  const { data: stored, error: permissionsError } = ids.length
    ? await adminClient
        .from("user_page_permissions")
        .select("user_id, page_slug, is_visible")
        .eq("clinic_id", user.clinicId)
        .in("user_id", ids)
    : { data: [], error: null };

  if (isMissingPermissionsTable(permissionsError)) {
    const { data: fallback, error: fallbackError } = ids.length
      ? await adminClient
          .from("user_customizations")
          .select("profile_id, page, access")
          .eq("clinic_id", user.clinicId)
          .eq("feature", "_visible")
          .in("profile_id", ids)
      : { data: [], error: null };

    if (fallbackError) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };

    return {
      data: staff.map((member) =>
        buildStaffRow(
          member,
          (fallback ?? []).map((permission) => ({
            user_id: permission.profile_id,
            page_slug: permission.page,
            is_visible: permission.access !== "hidden",
          })),
        ),
      ),
    };
  }
  if (permissionsError) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };

  return {
    data: staff.map((member) => buildStaffRow(member, stored ?? [])),
  };
}

function buildStaffRow(
  member: {
    id: string;
    full_name: string;
    role: UserRole;
    departments: { name: string } | { name: string }[] | null;
  },
  stored: { user_id: string; page_slug: string; is_visible: boolean }[],
): StaffPagePermissionsRow {
  const storedForUser = new Map(
    stored
      .filter((permission) => permission.user_id === member.id)
      .map((permission) => [permission.page_slug, permission.is_visible]),
  );
  const roleSlugs = new Set(getRolePageSlugs(member.role));
  const department = Array.isArray(member.departments)
    ? member.departments[0]
    : member.departments;

  return {
    id: member.id,
    fullName: member.full_name,
    role: member.role,
    departmentName: department?.name ?? null,
    permissions: PAGE_DEFINITIONS.filter((page) => roleSlugs.has(page.slug)).map(
      (page) => ({
        slug: page.slug,
        isVisible: page.alwaysVisible ? true : (storedForUser.get(page.slug) ?? true),
        alwaysVisible: Boolean(page.alwaysVisible),
      }),
    ),
  };
}

export async function updateUserPageVisibility(
  targetUserId: string,
  pageSlug: PageSlug,
  isVisible: boolean,
): Promise<PagePermissionResult> {
  const user = await requireMutationRole("admin");
  const result = await setPagePermissionMutation(user, {
    target_user_id: targetUserId,
    page_slug: pageSlug,
    is_visible: isVisible,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function saveUserPageVisibilityChanges(
  targetUserId: string,
  changes: PendingPageVisibilityChange[],
): Promise<PagePermissionResult> {
  const user = await requireMutationRole("admin");
  // Batch core, not a loop over the per-item core: the per-item core refuses
  // `dashboard` and role-invalid slugs, which this saver has always dropped
  // silently. Looping it wrote a prefix of the list and then reported failure.
  const result = await savePagePermissionsMutation(user, {
    target_user_id: targetUserId,
    changes: changes.map((change) => ({
      page_slug: change.slug,
      is_visible: change.isVisible,
    })),
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function resetUserPageVisibilityToRoleDefaults(
  targetUserId: string,
): Promise<PagePermissionResult> {
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
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id, role, clinic_id")
    .eq("id", targetUserId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (targetError || !target) return { error: await actionError("page-permissions.staffMemberNotFound") };
  const { error: deleteError } = await adminClient
    .from("user_page_permissions")
    .delete()
    .eq("user_id", target.id)
    .eq("clinic_id", target.clinic_id);

  if (isMissingPermissionsTable(deleteError)) {
    return ensureDefaultPagePermissionsFallback(
      target.id,
      target.role,
      target.clinic_id,
    );
  }
  if (deleteError) return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const ensured = await ensureDefaultPagePermissions(
    target.id,
    target.role,
    target.clinic_id,
  );
  if (ensured.error) return ensured;

  revalidatePath("/settings/staff");
  revalidatePath("/settings/customize");
  return { success: true };
}
