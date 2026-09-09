import "server-only";
import { unstable_cache } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";

type DepartmentRow = Database["public"]["Tables"]["departments"]["Row"];
type InsuranceRow = Database["public"]["Tables"]["insurance_providers"]["Row"];
type ServiceRow = Pick<
  Database["public"]["Tables"]["services"]["Row"],
  | "id"
  | "name"
  | "name_ar"
  | "name_en"
  | "price"
  | "department_id"
  | "is_active"
  | "deleted_at"
> & {
  departments: Pick<DepartmentRow, "id" | "name" | "color"> | null;
};
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"] & {
  departments: Pick<DepartmentRow, "name" | "color"> | null;
};

export function getCachedDepartments(clinicId: string): Promise<DepartmentRow[]> {
  return unstable_cache(
    async () => {
      const supabase = createClinicScopedAdminClient(clinicId);
      const { data } = await supabase
        .from("departments")
        .select("*")
        .eq("clinic_id", clinicId)
        .order("name");
      return (data ?? []) as DepartmentRow[];
    },
    ["departments", clinicId],
    { tags: [`departments:${clinicId}`], revalidate: 300 },
  )();
}

export function getCachedInsuranceProviders(clinicId: string): Promise<InsuranceRow[]> {
  return unstable_cache(
    async () => {
      const supabase = createClinicScopedAdminClient(clinicId);
      const { data } = await supabase
        .from("insurance_providers")
        .select("*")
        .eq("clinic_id", clinicId)
        .order("name");
      return (data ?? []) as InsuranceRow[];
    },
    ["insurance", clinicId],
    { tags: [`insurance:${clinicId}`], revalidate: 300 },
  )();
}

export function getCachedServices(clinicId: string): Promise<ServiceRow[]> {
  return unstable_cache(
    async () => {
      const supabase = createClinicScopedAdminClient(clinicId);
      const { data } = await supabase
        .from("services")
        // `*` rather than a column list, deliberately: the optional bilingual
        // display-name columns are additive and are applied on the clinic's own
        // schedule, and naming them explicitly would make this read — and with
        // it the whole services screen — fail on a database where that
        // migration has not run yet.
        .select("*, departments(id, name, color)")
        .eq("clinic_id", clinicId)
        .order("name");
      return (data ?? []) as ServiceRow[];
    },
    ["services", clinicId],
    { tags: [`services:${clinicId}`], revalidate: 300 },
  )();
}

export function getCachedStaff(clinicId: string): Promise<ProfileRow[]> {
  return unstable_cache(
    async () => {
      const supabase = createClinicScopedAdminClient(clinicId);
      const { data } = await supabase
        .from("profiles")
        .select("*, departments(name, color)")
        .eq("clinic_id", clinicId)
        .order("full_name");
      return (data ?? []) as ProfileRow[];
    },
    ["staff", clinicId],
    { tags: [`staff:${clinicId}`], revalidate: 300 },
  )();
}
