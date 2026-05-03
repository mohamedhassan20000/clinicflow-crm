import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { fetchUserCustomizationMap, featureAccess } from "@/lib/get-user-customizations";
import { AddServiceDialog } from "@/components/settings/add-service-dialog";
import { ServiceRowActions } from "@/components/settings/service-row-actions";

export const metadata: Metadata = { title: "Services" };

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export default async function ServicesSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const customMap = await fetchUserCustomizationMap(user.id);
  const canEdit = featureAccess(customMap, "settings", "services", user.role) === "read_edit";
  const isAdmin = user.role === "admin";
  const supabase = await createClient();

  const [{ data: departments }, { data: services }] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("services")
      .select("id, name, price, department_id, is_active, departments(id, name, color)")
      .eq("clinic_id", user.clinicId)
      .order("name"),
  ]);

  const deptList = departments ?? [];
  const svcList = services ?? [];

  // Group services by department for readability
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
          <h2 className="font-semibold">Services &amp; pricing</h2>
          <p className="text-sm text-muted-foreground">
            {svcList.length} service{svcList.length !== 1 ? "s" : ""} across{" "}
            {groups.length} department{groups.length !== 1 ? "s" : ""}.
          </p>
        </div>
        {canEdit && <AddServiceDialog departments={deptList} />}
      </div>

      {deptList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          Add at least one department in{" "}
          <a href="/settings/departments" className="underline">
            Departments
          </a>{" "}
          before creating services.
        </div>
      ) : svcList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          No services yet. Click &ldquo;Add service&rdquo; to create one — e.g. Consultation
          1000, Examination 500.
        </div>
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
                <span className="ml-auto text-[11px] font-normal opacity-80">
                  {rows.length} service{rows.length !== 1 ? "s" : ""}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="border-b border-border/50 bg-muted/20">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Service
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Price
                    </th>
                    {canEdit && (
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-medium">{s.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {fmtTRY(Number(s.price))}
                      </td>
                      {canEdit && (
                        <td className="px-4 py-2 text-right">
                          <ServiceRowActions
                            service={{
                              id: s.id,
                              name: s.name,
                              price: Number(s.price),
                              department_id: s.department_id,
                            }}
                            departments={deptList}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
