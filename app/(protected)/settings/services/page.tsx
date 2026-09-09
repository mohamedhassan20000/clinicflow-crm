import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments, getCachedServices } from "@/lib/cache/reference-data";
import { AddServiceDialog } from "@/components/settings/add-service-dialog";
import { ServiceRowActions } from "@/components/settings/service-row-actions";
import { SettingsTrashSection, type TrashItem } from "@/components/settings/settings-trash-section";
import { restoreService, deleteService, emptyServicesTrash } from "@/actions/settings";
import { THIRTY_DAYS_MS } from "@/lib/constants";
import { clinicLocaleFromRow } from "@/lib/datetime";
import { getServerMoneyFormatter } from "@/lib/currency/server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataServices") };
}

export default async function ServicesSettingsPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const [allDepartments, allServices, { data: clinic }] = await Promise.all([
    getCachedDepartments(user.clinicId),
    getCachedServices(user.clinicId),
    supabase
      .from("clinics")
      .select("time_format, timezone, currency, locale, country, week_start, digits")
      .eq("id", user.clinicId)
      .single(),
  ]);
  const clinicLocale = clinicLocaleFromRow(clinic);
  const fmtMoney = await getServerMoneyFormatter(user.id, clinicLocale);

  const deptList = allDepartments.filter((d) => !d.deleted_at && d.is_active);
  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();
  const svcList = allServices.filter((s) => !s.deleted_at);
  const trashedServices = (allServices ?? []).filter(
    (s) => s.deleted_at && s.deleted_at > cutoff,
  );
  const trashItems: TrashItem[] = trashedServices.map((s) => ({
    id: s.id,
    label: s.name,
    subtitle: (s.departments as { name: string } | null)?.name,
    deletedAt: s.deleted_at!,
  }));

  const byDept = new Map<
    string,
    { dept: { id: string; name: string; color: string }; rows: typeof svcList }
  >();
  for (const s of svcList) {
    const d = s.departments;
    if (!d) continue;
    const entry = byDept.get(d.id) ?? { dept: d, rows: [] };
    entry.rows.push(s);
    byDept.set(d.id, entry);
  }
  const groups = Array.from(byDept.values()).sort((a, b) =>
    a.dept.name.localeCompare(b.dept.name),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{t("servicesPricing")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("servicesAcrossDepartments", { services: svcList.length, departments: groups.length })}
          </p>
        </div>
        <AddServiceDialog departments={deptList} />
      </div>

      {deptList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          {t("addAtLeastOneDepartmentIn")}{" "}
          <a href="/settings/departments" className="underline">
            {t("departments")}</a>{" "}
          {t("beforeCreatingServices")}</div>
      ) : svcList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          {t("noServicesYetClickAddService")}</div>
      ) : (
        <div className="space-y-6">
          {groups.map(({ dept, rows }) => (
            <div
              key={dept.id}
              className="overflow-hidden rounded-xl border border-border/50"
            >
              <div
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold"
                style={{
                  backgroundColor: `color-mix(in oklab, ${dept.color} 12%, transparent)`,
                  color: dept.color,
                }}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: dept.color }}
                />
                {dept.name}
                <span className="ms-auto text-[11px] font-normal opacity-80">
                  {t("serviceCount", { count: rows.length })}
                </span>
              </div>
              <Table dense className="table-fixed">
                <colgroup>
                  <col />
                  <col className="w-36" />
                  <col className="w-36" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("service")}</TableHead>
                    <TableHead className="text-end">{t("price")}</TableHead>
                    <TableHead className="text-end">
                      <span className="sr-only">{t("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {fmtMoney(Number(s.price))}
                      </TableCell>
                      <TableCell className="text-end">
                        <ServiceRowActions
                          service={{
                            id: s.id,
                            name: s.name,
                            price: Number(s.price),
                            department_id: s.department_id,
                            name_ar: s.name_ar,
                            name_en: s.name_en,
                          }}
                          departments={deptList}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      )}

      <SettingsTrashSection
        items={trashItems}
        entityLabel="service"
        onRestore={restoreService}
        onPermanentDelete={deleteService}
        onEmptyTrash={emptyServicesTrash}
      />
    </div>
  );
}
