import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ClinicForm } from "@/components/settings/clinic-form";

export const metadata: Metadata = { title: "Clinic Settings" };

export default async function ClinicSettingsPage() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, phone, address, logo_url")
    .eq("id", user.clinicId)
    .single();

  return (
    <div className="max-w-2xl space-y-2">
      <div>
        <h2 className="font-semibold">Clinic settings</h2>
        <p className="text-sm text-muted-foreground">
          Update your clinic&apos;s name, logo, and contact information.
        </p>
      </div>

      <ClinicForm
        defaultValues={{
          name: clinic?.name ?? "",
          phone: clinic?.phone ?? null,
          address: clinic?.address ?? null,
        }}
        logoUrl={clinic?.logo_url ?? null}
      />
    </div>
  );
}
