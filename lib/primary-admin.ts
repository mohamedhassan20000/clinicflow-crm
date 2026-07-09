import "server-only";

import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export async function getPrimaryClinicAdminId(
  clinicId: string,
): Promise<string | null> {
  const adminClient = createClinicScopedAdminClient(clinicId);
  const { data, error } = await adminClient
    .from("profiles")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("role", "admin")
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) return null;
  return data?.[0]?.id ?? null;
}

export async function isPrimaryClinicAdmin(
  userId: string,
  clinicId: string,
): Promise<boolean> {
  const primaryAdminId = await getPrimaryClinicAdminId(clinicId);
  return primaryAdminId === userId;
}
