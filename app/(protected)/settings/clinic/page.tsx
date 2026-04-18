import type { Metadata } from "next";
import { Building2 } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ClinicForm } from "@/components/settings/clinic-form";
import { AddClinicDialog } from "@/components/settings/add-clinic-dialog";

export const metadata: Metadata = { title: "Clinic Settings" };

export default async function ClinicSettingsPage() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  const [{ data: clinic }, { data: allClinics }] = await Promise.all([
    supabase
      .from("clinics")
      .select("name, phone, address, logo_url")
      .eq("id", user.clinicId)
      .single(),
    supabase
      .from("clinics")
      .select("id, name, phone, is_active, created_at")
      .order("created_at", { ascending: true }),
  ]);

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">Clinic settings</h2>
          <p className="text-sm text-muted-foreground">
            Update your clinic&apos;s name, logo, and contact information.
          </p>
        </div>
        <AddClinicDialog />
      </div>

      <ClinicForm
        defaultValues={{
          name: clinic?.name ?? "",
          phone: clinic?.phone ?? null,
          address: clinic?.address ?? null,
        }}
        logoUrl={clinic?.logo_url ?? null}
      />

      {/* All clinics list */}
      {allClinics && allClinics.length > 1 && (
        <div className="rounded-xl border border-border/50 bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4 text-primary" />
            All clinics ({allClinics.length})
          </h3>
          <ul className="divide-y divide-border/50">
            {allClinics.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between py-3 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {c.name}
                    {c.id === user.clinicId && (
                      <span className="ml-2 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Current
                      </span>
                    )}
                  </p>
                  {c.phone && (
                    <p className="text-xs text-muted-foreground">{c.phone}</p>
                  )}
                </div>
                <span
                  className={`text-xs ${c.is_active ? "text-emerald-600" : "text-muted-foreground"}`}
                >
                  {c.is_active ? "Active" : "Inactive"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
