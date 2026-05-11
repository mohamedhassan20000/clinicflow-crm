"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/rbac";
import { getPrimaryClinicAdminId, isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  getRolePageSlugs,
  PAGE_DEFINITIONS,
  type PageSlug,
} from "@/lib/page-permissions";
import type { Database } from "@/types/database";

type UserRole = Database["public"]["Enums"]["user_role"];

export type StaffPagePermission = {
  slug: PageSlug;
  label: string;
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
  const adminClient = createAdminClient();
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
  if (error) return { error: error.message };
  return { success: true };
}

async function ensureDefaultPagePermissionsFallback(
  userId: string,
  role: UserRole,
  clinicId: string,
): Promise<PagePermissionResult> {
  const adminClient = createAdminClient();
  const pages = getRolePageSlugs(role);

  for (const pageSlug of pages) {
    const { error: deleteError } = await adminClient
      .from("user_customizations")
      .delete()
      .eq("profile_id", userId)
      .eq("clinic_id", clinicId)
      .eq("feature", "_visible")
      .eq("page", pageSlug);
    if (deleteError) return { error: deleteError.message };
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
  if (error) return { error: error.message };
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
    return { error: "Only the primary clinic admin can customize page visibility." };
  }
  const adminClient = createAdminClient();
  const primaryAdminId = await getPrimaryClinicAdminId(user.clinicId);

  const { data: staffRows, error: staffError } = await adminClient
    .from("profiles")
    .select("id, full_name, role, department_id, departments(name)")
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .neq("id", primaryAdminId ?? "")
    .order("full_name");

  if (staffError) return { error: staffError.message };
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

    if (fallbackError) return { error: fallbackError.message };

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
  if (permissionsError) return { error: permissionsError.message };

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
        label: page.label,
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
  const user = await requireRole("admin");
  if (
    user.role === "admin" &&
    !(await isPrimaryClinicAdmin(user.id, user.clinicId))
  ) {
    return { error: "Only the primary clinic admin can customize page visibility." };
  }
  if (pageSlug === "dashboard") return { error: "Dashboard cannot be hidden." };

  const adminClient = createAdminClient();
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id, role, clinic_id")
    .eq("id", targetUserId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (targetError || !target) return { error: "Staff member not found." };
  if (user.role === "manager" && target.role === "admin") {
    return { error: "Only admins can customize admin users." };
  }
  if (target.id === await getPrimaryClinicAdminId(user.clinicId)) {
    return { error: "The primary clinic admin cannot be customized." };
  }
  if (!getRolePageSlugs(target.role).includes(pageSlug)) {
    return { error: "This page is not available for that user's role." };
  }

  const { error } = await adminClient.from("user_page_permissions").upsert(
    {
      user_id: target.id,
      clinic_id: target.clinic_id,
      page_slug: pageSlug,
      is_visible: isVisible,
    },
    { onConflict: "user_id,page_slug" },
  );

  if (isMissingPermissionsTable(error)) {
    return updateUserPageVisibilityFallback(
      target.id,
      target.clinic_id,
      pageSlug,
      isVisible,
    );
  }
  if (error) return { error: error.message };

  revalidatePath("/settings/customize");
  return { success: true };
}

export async function saveUserPageVisibilityChanges(
  targetUserId: string,
  changes: PendingPageVisibilityChange[],
): Promise<PagePermissionResult> {
  const user = await requireRole("admin");
  if (
    user.role === "admin" &&
    !(await isPrimaryClinicAdmin(user.id, user.clinicId))
  ) {
    return { error: "Only the primary clinic admin can customize page visibility." };
  }
  const primaryAdminId = await getPrimaryClinicAdminId(user.clinicId);
  if (targetUserId === primaryAdminId) {
    return { error: "The primary clinic admin cannot be customized." };
  }

  const adminClient = createAdminClient();
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id, role, clinic_id")
    .eq("id", targetUserId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (targetError || !target) return { error: "Staff member not found." };
  if (user.role === "manager" && target.role === "admin") {
    return { error: "Only admins can customize admin users." };
  }

  const roleSlugs = new Set(getRolePageSlugs(target.role));
  const rows = changes
    .filter((change) => change.slug !== "dashboard" && roleSlugs.has(change.slug))
    .map((change) => ({
      user_id: target.id,
      clinic_id: target.clinic_id,
      page_slug: change.slug,
      is_visible: change.isVisible,
    }));

  if (rows.length === 0) return { success: true };

  const { error } = await adminClient
    .from("user_page_permissions")
    .upsert(rows, { onConflict: "user_id,page_slug" });

  if (isMissingPermissionsTable(error)) {
    return saveUserPageVisibilityChangesFallback(
      target.id,
      target.clinic_id,
      rows.map((row) => ({
        slug: row.page_slug,
        isVisible: row.is_visible,
      })),
    );
  }
  if (error) return { error: error.message };

  revalidatePath("/settings/customize");
  return { success: true };
}

export async function resetUserPageVisibilityToRoleDefaults(
  targetUserId: string,
): Promise<PagePermissionResult> {
  const user = await requireRole("admin");
  const adminClient = createAdminClient();
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id, role, clinic_id")
    .eq("id", targetUserId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (targetError || !target) return { error: "Staff member not found." };
  if (user.role === "manager" && target.role === "admin") {
    return { error: "Only admins can reset admin users." };
  }

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
  if (deleteError) return { error: deleteError.message };

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

async function updateUserPageVisibilityFallback(
  userId: string,
  clinicId: string,
  pageSlug: PageSlug,
  isVisible: boolean,
): Promise<PagePermissionResult> {
  return saveUserPageVisibilityChangesFallback(userId, clinicId, [
    { slug: pageSlug, isVisible },
  ]);
}

async function saveUserPageVisibilityChangesFallback(
  userId: string,
  clinicId: string,
  changes: PendingPageVisibilityChange[],
): Promise<PagePermissionResult> {
  const adminClient = createAdminClient();

  for (const change of changes) {
    const { error: upsertError } = await adminClient
      .from("user_customizations")
      .upsert(
        {
          profile_id: userId,
          clinic_id: clinicId,
          feature: "_visible",
          page: change.slug,
          access: change.isVisible ? "read_edit" : "hidden",
        },
        { onConflict: "profile_id,page,feature" },
      );
    if (upsertError) return { error: upsertError.message };
  }

  revalidatePath("/settings/customize");
  return { success: true };
}
