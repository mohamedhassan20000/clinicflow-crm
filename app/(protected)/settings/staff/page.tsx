import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { StaffByDepartment } from "@/components/settings/staff-by-department";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const isAdmin = user.role === "admin";
  const supabase = await createClient();

  const [{ data: staff }, { data: departments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*, departments(name, color)")
      .eq("clinic_id", user.clinicId)
      .order("full_name"),
    supabase
      .from("departments")
      .select("id, name, color")
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
            {staff?.length ?? 0} member{(staff?.length ?? 0) !== 1 ? "s" : ""}{" "}
            across {departments?.length ?? 0} department
            {(departments?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        {isAdmin && (
          <AddStaffDialog
            departments={
              (departments ?? []).map(({ id, name }) => ({ id, name }))
            }
          />
        )}
      </div>

      <StaffByDepartment
        staff={
          (staff ?? []) as Parameters<
            typeof StaffByDepartment
          >[0]["staff"]
        }
        departments={departments ?? []}
        currentUserId={user.id}
        readOnly={!isAdmin}
      />
    </div>
  );
}
