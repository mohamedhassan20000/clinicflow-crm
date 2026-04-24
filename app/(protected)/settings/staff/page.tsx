import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { StaffTable } from "@/components/settings/staff-table";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffSettingsPage() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  const [{ data: staff }, { data: departments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*, departments(name)")
      .eq("clinic_id", user.clinicId)
      .order("full_name"),
    supabase
      .from("departments")
      .select("id, name")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Staff members</h2>
          <p className="text-sm text-muted-foreground">
            {staff?.length ?? 0} member{(staff?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <AddStaffDialog departments={departments ?? []} />
      </div>

      <StaffTable
        staff={(staff ?? []) as Parameters<typeof StaffTable>[0]["staff"]}
        departments={departments ?? []}
        currentUserId={user.id}
      />
    </div>
  );
}
