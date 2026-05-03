import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { fetchUserCustomizationMap, featureAccess } from "@/lib/get-user-customizations";
import { Badge } from "@/components/ui/badge";
import {
  updateDepartment,
  toggleDepartmentActive,
} from "@/actions/settings";
import { DepartmentActions } from "@/components/settings/department-actions";
import { AddDepartmentDialog } from "@/components/settings/add-department-dialog";

export const metadata: Metadata = { title: "Departments" };

export default async function DepartmentsSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const customMap = await fetchUserCustomizationMap(user.id);
  const canEdit = featureAccess(customMap, "settings", "departments", user.role) === "read_edit";
  const isAdmin = user.role === "admin";
  const supabase = await createClient();

  const { data: departments } = await supabase
    .from("departments")
    .select("*")
    .eq("clinic_id", user.clinicId)
    .order("name");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Departments</h2>
          <p className="text-sm text-muted-foreground">
            {departments?.length ?? 0} department{(departments?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        {canEdit && <AddDepartmentDialog />}
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Department</th>
              <th className="hidden px-4 py-3 text-left font-medium text-muted-foreground sm:table-cell">
                Description
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              {canEdit && (
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {(departments ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  No departments yet.
                </td>
              </tr>
            )}
            {(departments ?? []).map((dept) => (
              <tr key={dept.id} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: dept.color }}
                    />
                    <span className="font-medium">{dept.name}</span>
                  </div>
                </td>
                <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                  {dept.description ?? <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant={dept.is_active ? "default" : "secondary"}
                    className={`text-xs ${dept.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/20" : ""}`}
                  >
                    {dept.is_active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                {canEdit && (
                  <td className="px-4 py-3 text-right">
                    <DepartmentActions
                      dept={dept}
                      updateAction={updateDepartment.bind(null, dept.id)}
                      toggleAction={toggleDepartmentActive.bind(null, dept.id)}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
