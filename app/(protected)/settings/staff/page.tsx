import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchUserCustomizationMap, featureAccess } from "@/lib/get-user-customizations";
import { StaffByDepartment } from "@/components/settings/staff-by-department";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";
import { StaffTrash } from "@/components/settings/staff-trash";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const customMap = await fetchUserCustomizationMap(user.id);
  const canEdit = featureAccess(customMap, "settings", "staff", user.role) === "read_edit";
  const isAdmin = user.role === "admin";
  const supabase = await createClient();

  // Lazy 30-day cleanup: permanently delete any soft-deleted staff past their expiry
  if (isAdmin) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: expired } = await supabase
      .from("profiles")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", true)
      .lt("deleted_at", cutoff);

    if (expired?.length) {
      const adminClient = createAdminClient();
      for (const s of expired) {
        await adminClient.auth.admin.deleteUser(s.id);
        await supabase.from("profiles").delete().eq("id", s.id);
      }
    }
  }

  const [{ data: staff }, { data: departments }, { data: deletedStaff }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("*, departments(name, color)")
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .order("full_name"),
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      isAdmin
        ? supabase
            .from("profiles")
            .select("id, full_name, role, phone, deleted_at, departments(name, color)")
            .eq("clinic_id", user.clinicId)
            .eq("is_deleted", true)
            .order("deleted_at", { ascending: false })
        : Promise.resolve({ data: [] }),
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
        isAdmin={isAdmin}
        readOnly={!canEdit}
      />

      {isAdmin && (
        <StaffTrash
          deletedStaff={
            (deletedStaff ?? []) as Parameters<typeof StaffTrash>[0]["deletedStaff"]
          }
        />
      )}
    </div>
  );
}
