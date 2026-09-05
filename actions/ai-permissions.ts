"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  AI_USER_PERMISSION_KEYS,
  type AiUserPermissionKey,
} from "@/lib/ai/permissions";
import type { Database } from "@/types/database";
import { domainFailureToActionResult } from "@/actions/_domain";
import { setAiPermissionMutation } from "@/lib/settings/mutations";

type UserRole = Database["public"]["Enums"]["user_role"];

export type AiPermissionResult = { error?: string; success?: boolean };

export type StaffAiPermissionRow = {
  id: string;
  fullName: string;
  role: UserRole;
  /** Granted explicitly by an admin. */
  granted: boolean;
  /**
   * True when the role carries the permission inherently (admins). Such a row
   * is informational — it cannot be toggled off, because revoking it would not
   * reduce what the user can already reach through the financial pages.
   */
  implicit: boolean;
};

/**
 * Roles that can be granted a per-user AI permission. Receptionists and doctors
 * are excluded from financial tools by the P4.6 role matrix (non-registration),
 * so offering them a toggle would imply an access path that does not exist.
 */
const GRANTABLE_ROLES: Record<AiUserPermissionKey, readonly UserRole[]> = {
  "ai.financial_insights": ["manager"],
};

const IMPLICIT_ROLES: Record<AiUserPermissionKey, readonly UserRole[]> = {
  "ai.financial_insights": ["admin"],
};

function isPermissionKey(value: string): value is AiUserPermissionKey {
  return (AI_USER_PERMISSION_KEYS as readonly string[]).includes(value);
}

/**
 * Both AI-permission actions require the *primary* clinic admin, matching the
 * page that hosts them.
 *
 * The page already redirected non-primary admins, but the actions asked only
 * for `admin`, so the stricter rule was the cosmetic one: any non-primary admin
 * could invoke the action directly and grant the financial permission. Not an
 * escalation of consequence — admins hold the grant implicitly and administer
 * every financial page already — but two layers stating different rules is how
 * the *next* change picks the wrong one to trust.
 */
async function requirePrimaryAdmin() {
  const user = await requireRole("admin");
  return (await isPrimaryClinicAdmin(user.id, user.clinicId)) ? user : null;
}

/**
 * Lists the clinic's staff alongside their per-user AI permission state.
 * Admin-only, clinic-scoped, and read-only — it grants nothing by itself.
 */
export async function listStaffAiPermissions(
  permissionKey: AiUserPermissionKey,
): Promise<{ data?: StaffAiPermissionRow[]; error?: string }> {
  // Typed as AiUserPermissionKey, not string. The per-user permission namespace
  // and the plan-entitlement namespace both happen to contain the literal
  // "ai.financial_insights", so passing the entitlement constant here compiled
  // and worked by pure coincidence — and would have failed into an empty staff
  // list on a page that looked healthy if either namespace were ever renamed.
  // The runtime guard stays as the boundary check for untyped callers.
  if (!isPermissionKey(permissionKey)) {
    return { error: await actionError("ai-permissions.unknownPermission") };
  }
  const user = await requirePrimaryAdmin();
  if (!user) {
    return { error: await actionError("ai-permissions.primaryAdminOnly") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const relevantRoles = [
    ...GRANTABLE_ROLES[permissionKey],
    ...IMPLICIT_ROLES[permissionKey],
  ];

  const { data: staff, error: staffError } = await adminClient
    .from("profiles")
    .select("id, full_name, role")
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .in("role", relevantRoles)
    .order("full_name");
  if (staffError) {
    return { error: await actionError("ai-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  const ids = (staff ?? []).map((member) => member.id);
  const { data: stored, error: storedError } = ids.length
    ? await adminClient
        .from("user_ai_permissions")
        .select("user_id, granted")
        .eq("clinic_id", user.clinicId)
        .eq("permission_key", permissionKey)
        .in("user_id", ids)
    : { data: [], error: null };
  if (storedError) {
    return { error: await actionError("ai-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  const grants = new Map((stored ?? []).map((row) => [row.user_id, row.granted]));
  return {
    data: (staff ?? []).map((member) => {
      const implicit = IMPLICIT_ROLES[permissionKey].includes(member.role);
      return {
        id: member.id,
        fullName: member.full_name,
        role: member.role,
        granted: implicit || grants.get(member.id) === true,
        implicit,
      };
    }),
  };
}

/**
 * Grants or revokes one per-user AI permission.
 *
 * Deliberately narrow: admin actor, same clinic, grantable role only, and the
 * clinic must actually hold the matching entitlement — a grant against a plan
 * that has no financial AI would be a promise the tool layer will not keep.
 * The grant never widens role or RLS; it only decides whether an already
 * entitled tool is mounted for that one user.
 */
export async function setStaffAiPermission(
  targetUserId: string,
  permissionKey: AiUserPermissionKey,
  granted: boolean,
): Promise<AiPermissionResult> {
  if (!isPermissionKey(permissionKey)) {
    return { error: await actionError("ai-permissions.unknownPermission") };
  }
  const user = await requireMutationRole("admin");
  const result = await setAiPermissionMutation(user, {
    target_user_id: targetUserId,
    permission_key: permissionKey,
    granted,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}
