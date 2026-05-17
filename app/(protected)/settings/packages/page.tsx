import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments } from "@/lib/cache/reference-data";
import { AddPackageTemplateDialog } from "@/components/settings/packages/add-package-template-dialog";
import {
  PackageTemplateRowActions,
  type PackageTemplateRowData,
} from "@/components/settings/packages/package-template-row-actions";

export const metadata: Metadata = { title: "Package templates" };

function fmtTRY(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export default async function PackagesSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const canMutate = user.role === "admin";

  const supabase = await createClient();
  const [allDepartments, { data: templates }] = await Promise.all([
    getCachedDepartments(user.clinicId),
    supabase
      .from("package_templates")
      .select(
        "id, name, department_id, total_sessions, price_per_session, total_price, notes, is_active",
      )
      .eq("clinic_id", user.clinicId)
      .order("name"),
  ]);

  const deptList = allDepartments.filter((d) => !d.deleted_at && d.is_active);
  const rows = (templates ?? []) as PackageTemplateRowData[];
  const activeRows = rows.filter((r) => r.is_active);
  const inactiveRows = rows.filter((r) => !r.is_active);

  const deptById = new Map(deptList.map((d) => [d.id, d]));
  const byDept = new Map<
    string,
    {
      dept: { id: string; name: string; color: string };
      rows: PackageTemplateRowData[];
    }
  >();
  for (const t of activeRows) {
    const d = deptById.get(t.department_id);
    if (!d) continue;
    const entry = byDept.get(d.id) ?? { dept: d, rows: [] };
    entry.rows.push(t);
    byDept.set(d.id, entry);
  }
  const groups = Array.from(byDept.values()).sort((a, b) =>
    a.dept.name.localeCompare(b.dept.name),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Package templates</h2>
          <p className="text-sm text-muted-foreground">
            {activeRows.length} active template
            {activeRows.length !== 1 ? "s" : ""} across {groups.length}{" "}
            department{groups.length !== 1 ? "s" : ""}.
          </p>
        </div>
        {canMutate ? <AddPackageTemplateDialog departments={deptList} /> : null}
      </div>

      {!canMutate ? (
        <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          Read-only view. Only admins can manage package templates.
        </div>
      ) : null}

      {deptList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          Add at least one department in{" "}
          <a href="/settings/departments" className="underline">
            Departments
          </a>{" "}
          before creating package templates.
        </div>
      ) : activeRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          No package templates yet. Click &ldquo;Add template&rdquo; to create
          one.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(({ dept, rows: deptRows }) => (
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
                <span className="ml-auto text-[11px] font-normal opacity-80">
                  {deptRows.length} template{deptRows.length !== 1 ? "s" : ""}
                </span>
              </div>
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col />
                  <col className="w-24" />
                  <col className="w-32" />
                  <col className="w-32" />
                  <col className="w-44" />
                </colgroup>
                <thead className="border-b border-border/50 bg-muted/20">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Template
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Sessions
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Price / session
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Total price
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {deptRows.map((t) => (
                    <tr key={t.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{t.name}</div>
                        {t.notes ? (
                          <div className="line-clamp-1 text-xs text-muted-foreground">
                            {t.notes}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {t.total_sessions}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {fmtTRY(
                          t.price_per_session !== null
                            ? Number(t.price_per_session)
                            : null,
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {fmtTRY(
                          t.total_price !== null ? Number(t.total_price) : null,
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <PackageTemplateRowActions
                          template={t}
                          departments={deptList}
                          canMutate={canMutate}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {inactiveRows.length > 0 ? (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-muted-foreground">
            Deactivated templates
          </div>
          <div className="overflow-hidden rounded-xl border border-border/50 bg-muted/10">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-44" />
              </colgroup>
              <tbody className="divide-y divide-border/40">
                {inactiveRows.map((t) => {
                  const d = deptById.get(t.department_id);
                  return (
                    <tr key={t.id}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {d?.name ?? "Unknown department"} · {t.total_sessions}{" "}
                          sessions
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground tabular-nums">
                        {fmtTRY(
                          t.price_per_session !== null
                            ? Number(t.price_per_session)
                            : null,
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <PackageTemplateRowActions
                          template={t}
                          departments={deptList}
                          canMutate={canMutate}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
