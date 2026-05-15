import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ClinicForm } from "@/components/settings/clinic-form";
import { ClinicWorkingHoursForm } from "@/components/settings/clinic-working-hours-form";
import { getClinicWorkingHours } from "@/actions/settings";

export const metadata: Metadata = { title: "Clinic Settings" };

export default async function ClinicSettingsPage() {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const [{ data: clinic }, workingHours] = await Promise.all([
    supabase
      .from("clinics")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("name, phone, address, logo_url, time_format" as any)
      .eq("id", user.clinicId)
      .single(),
    getClinicWorkingHours(),
  ]);

  const isReadOnly = user.role !== "admin";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clinicData = clinic as any;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">Clinic settings</h2>
        <p className="text-sm text-muted-foreground">
          Update your clinic&apos;s name, logo, contact information, and working hours.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <ClinicForm
          defaultValues={{
            name: clinicData?.name ?? "",
            phone: clinicData?.phone ?? null,
            address: clinicData?.address ?? null,
            time_format: clinicData?.time_format === "12h" ? "12h" : "24h",
          }}
          logoUrl={clinicData?.logo_url ?? null}
          readOnly={isReadOnly}
        />

        <ClinicWorkingHoursForm defaultValues={workingHours} readOnly={isReadOnly} />
      </div>
    </div>
  );
}
