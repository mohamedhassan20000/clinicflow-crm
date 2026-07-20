import "server-only";

import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import type { AuthedUser } from "@/lib/rbac";
import type { AiUserPermissionKey } from "@/lib/ai/permission-keys";

/**
 * Per-user AI permissions (P4.6A). These are admin-granted, deny-by-default
 * grants layered *on top of* a plan entitlement — they widen nothing on their
 * own, and without the matching entitlement they are inert.
 *
 * The only key today is the financial grant. RLS on patient_deposits and
 * outstanding_settlements already permits manager reads, so the manager
 * restriction cannot be delegated to the database; this permission is the
 * application-layer authority the roadmap requires (§P4.6 security note).
 */
export {
  AI_USER_PERMISSION_KEYS,
  AI_FINANCIAL_INSIGHTS_PERMISSION,
  isAiUserPermissionKey,
} from "@/lib/ai/permission-keys";
export type { AiUserPermissionKey } from "@/lib/ai/permission-keys";

/**
 * Admins carry the financial grant implicitly — they already administer billing
 * and every financial page. Managers must be granted it explicitly (default
 * OFF); receptionists and doctors are excluded by the role matrix and never
 * reach this check.
 */
const IMPLICIT_PERMISSION_ROLES: Record<AiUserPermissionKey, readonly AuthedUser["role"][]> = {
  "ai.financial_insights": ["admin"],
};

/**
 * Request-scoped memo (L6). The grant is deliberately re-checked at every tool
 * invocation, and that semantic is preserved: `cache` lives and dies with one
 * server request, so a revocation still denies the next *turn*. What it removes
 * is the repeated round-trip when one turn resolves the mount and then calls
 * two or three financial tools inside the same request.
 *
 * Keyed on primitives, not the `AuthedUser` object, so memoization does not
 * depend on callers happening to share a reference.
 */
const readGrant = cache(
  async (userId: string, clinicId: string, key: AiUserPermissionKey): Promise<boolean> => {
    try {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("user_ai_permissions")
        .select("granted")
        .eq("user_id", userId)
        .eq("clinic_id", clinicId)
        .eq("permission_key", key)
        .maybeSingle();

      if (error) {
        Sentry.captureMessage("ai user permission lookup failed", {
          level: "warning",
          extra: { key, clinicId, error: error.message },
        });
        return false;
      }
      return data?.granted === true;
    } catch (error) {
      Sentry.captureException(error, { tags: { area: "ai-user-permissions" } });
      return false;
    }
  },
);

/**
 * Resolves one per-user AI permission. Fails closed: a lookup error denies,
 * because a permission read that did not succeed is not a grant.
 *
 * The `clinic_id` filter is load-bearing beyond tenancy hygiene: the grant row
 * is only honored when it belongs to the caller's own clinic, so even a row
 * written against the wrong tenant grants nothing.
 */
export async function hasAiUserPermission(
  user: AuthedUser,
  key: AiUserPermissionKey,
): Promise<boolean> {
  if (IMPLICIT_PERMISSION_ROLES[key].includes(user.role)) return true;
  return readGrant(user.id, user.clinicId, key);
}
