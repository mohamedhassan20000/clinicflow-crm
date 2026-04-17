import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DepartmentForm } from "@/components/settings/department-form";
import {
  createDepartment,
  updateDepartment,
  toggleDepartmentActive,
} from "@/actions/settings";
import { DepartmentActions } from "@/components/settings/department-actions";

export const metadata: Metadata = { title: "Departments" };

export default async function DepartmentsSettingsPage() {
  const user = await requireRole("admin");
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
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Add department
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add department</DialogTitle>
            </DialogHeader>
            <DepartmentForm action={createDepartment} submitLabel="Create department" />
          </DialogContent>
        </Dialog>
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
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </th>
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
                <td className="px-4 py-3 text-right">
                  <DepartmentActions
                    dept={dept}
                    updateAction={updateDepartment.bind(null, dept.id)}
                    toggleAction={toggleDepartmentActive.bind(null, dept.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
