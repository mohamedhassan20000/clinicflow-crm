import "server-only";

import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export async function getPrimaryClinicAdminId(
  clinicId: string,
): Promise<string | null> {
  const adminClient = createClinicScopedAdminClient(clinicId);
  // Must stay byte-for-byte aligned with the database authority
  // assert_primary_ai_provider_admin (P4.5B migration): same predicate
  // (is_active = true AND is_deleted = false AND deleted_at IS NULL) and the
  // same deterministic tiebreak (created_at asc, id asc). On exact created_at
  // ties or an inconsistent is_deleted/deleted_at state, app and DB would
  // otherwise name different "primary" admins.
  const { data, error } = await adminClient
    .from("profiles")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("role", "admin")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  // A query failure is not evidence that there is no eligible primary admin.
  // Keep that state distinct so callers that report authorization outcomes can
  // say the lookup failed instead of misclassifying the user as a secondary
  // administrator. Authorization callers still fail closed because the error
  // interrupts the positive check.
  if (error) {
    throw new Error("Failed to determine the primary clinic administrator", {
      cause: error,
    });
  }
  return data?.[0]?.id ?? null;
}

export async function isPrimaryClinicAdmin(
  userId: string,
  clinicId: string,
): Promise<boolean> {
  const primaryAdminId = await getPrimaryClinicAdminId(clinicId);
  return primaryAdminId === userId;
}
