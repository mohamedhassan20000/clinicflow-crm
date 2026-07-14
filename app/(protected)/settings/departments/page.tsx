import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { getCachedDepartments } from "@/lib/cache/reference-data";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  updateDepartment,
  toggleDepartmentActive,
  softDeleteDepartment,
  restoreDepartment,
  permanentDeleteDepartment,
  emptyDepartmentsTrash,
} from "@/actions/settings";
import { DepartmentActions } from "@/components/settings/department-actions";
import { AddDepartmentDialog } from "@/components/settings/add-department-dialog";
import { SettingsTrashSection, type TrashItem } from "@/components/settings/settings-trash-section";
import { THIRTY_DAYS_MS } from "@/lib/constants";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataDepartments") };
}

export default async function DepartmentsSettingsPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);

  const allDepartments = await getCachedDepartments(user.clinicId);

  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();
  const departments = (allDepartments ?? []).filter((d) => !d.deleted_at);
  const trashedDepts = (allDepartments ?? []).filter(
    (d) => d.deleted_at && d.deleted_at > cutoff,
  );
  const trashItems: TrashItem[] = trashedDepts.map((d) => ({
    id: d.id,
    label: d.name,
    subtitle: d.description ?? undefined,
    deletedAt: d.deleted_at!,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{t("departments")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("departmentCount", { count: departments?.length ?? 0 })}
          </p>
        </div>
        <AddDepartmentDialog />
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-40" />
            <col className="hidden sm:table-column" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>{t("department")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("description")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  {t("noDepartmentsYet")}</TableCell>
              </TableRow>
            )}
            {departments.map((dept) => (
              <TableRow key={dept.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: dept.color }}
                    />
                    <span className="font-medium">{dept.name}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {dept.description ?? <span className="text-muted-foreground/50">—</span>}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={dept.is_active ? "default" : "secondary"}
                    className={`text-xs ${dept.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" : ""}`}
                  >
                    {dept.is_active ? t("active") : t("inactive")}
                  </Badge>
                </TableCell>
                <TableCell className="text-end">
                  <DepartmentActions
                    dept={dept}
                    updateAction={updateDepartment.bind(null, dept.id)}
                    toggleAction={toggleDepartmentActive.bind(null, dept.id)}
                    deleteAction={softDeleteDepartment.bind(null, dept.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <SettingsTrashSection
        items={trashItems}
        entityLabel="department"
        onRestore={restoreDepartment}
        onPermanentDelete={permanentDeleteDepartment}
        onEmptyTrash={emptyDepartmentsTrash}
      />
    </div>
  );
}
