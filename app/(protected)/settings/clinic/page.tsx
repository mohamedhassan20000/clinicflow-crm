import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ClinicForm } from "@/components/settings/clinic-form";
import { ClinicWorkingHoursForm } from "@/components/settings/clinic-working-hours-form";
import { StaffShiftTemplatesForm } from "@/components/settings/staff-shift-templates-form";
import { getClinicWorkingHours, getStaffShiftTemplates } from "@/actions/settings";
import { getTranslations } from "next-intl/server";
import {
  ensureClinicLogoCleaned,
  isClinicLogoCleaned,
} from "@/lib/images/clinic-logo-cleanup";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataClinicSettings") };
}

export default async function ClinicSettingsPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const [{ data: clinic }, workingHours, shiftTemplates] = await Promise.all([
    supabase
      .from("clinics")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("name, phone, address, logo_url, time_format, email, website, license_no, tax_id, document_footer, branding_metadata" as any)
      .eq("id", user.clinicId)
      .single(),
    getClinicWorkingHours(),
    getStaffShiftTemplates(),
  ]);

  const isReadOnly = user.role !== "admin";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clinicData = clinic as any;
  const logoUrl = clinicData?.logo_url ?? null;

  if (logoUrl && !isClinicLogoCleaned(logoUrl, user.clinicId)) {
    after(async () => {
      const result = await ensureClinicLogoCleaned({
        supabase,
        clinicId: user.clinicId,
        logoUrl,
      });
      if (result.status === "migrated") {
        revalidatePath("/", "layout");
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">{t("clinicSettings")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("updateYourClinicSNameLogo")}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <ClinicForm
          defaultValues={{
            name: clinicData?.name ?? "",
            phone: clinicData?.phone ?? null,
            address: clinicData?.address ?? null,
            email: clinicData?.email ?? null,
            website: clinicData?.website ?? null,
            license_no: clinicData?.license_no ?? null,
            tax_id: clinicData?.tax_id ?? null,
            document_footer: clinicData?.document_footer ?? null,
            branding_metadata: JSON.stringify(
              clinicData?.branding_metadata ?? {},
              null,
              2,
            ),
            time_format: clinicData?.time_format === "12h" ? "12h" : "24h",
          }}
          logoUrl={logoUrl}
          readOnly={isReadOnly}
        />

        <div className="space-y-6">
          <ClinicWorkingHoursForm defaultValues={workingHours} readOnly={isReadOnly} />
          <StaffShiftTemplatesForm defaultValues={shiftTemplates} readOnly={isReadOnly} />
        </div>
      </div>
    </div>
  );
}
