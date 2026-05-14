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
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="font-semibold">Clinic settings</h2>
        <p className="text-sm text-muted-foreground">
          Update your clinic&apos;s name, logo, contact information, and working hours.
        </p>
      </div>

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
  );
}
