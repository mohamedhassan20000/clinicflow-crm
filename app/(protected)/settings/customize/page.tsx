import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { CustomizePage } from "@/components/settings/customize-page";

export const metadata: Metadata = { title: "Customize" };

export default async function CustomizeSettingsPage() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  const { data: staff } = await supabase
    .from("profiles")
    .select("id, full_name, role, departments(name)")
    .eq("clinic_id", user.clinicId)
    .neq("id", user.id)
    .order("full_name");

  return (
    <CustomizePage
      staff={
        (staff ?? []).map((s) => ({
          id: s.id,
          full_name: s.full_name,
          role: s.role,
          department: (s.departments as { name: string } | null)?.name ?? null,
        }))
      }
    />
  );
}
