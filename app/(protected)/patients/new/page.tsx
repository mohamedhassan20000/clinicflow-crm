import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientForm } from "@/components/patients/patient-form";
import { createPatient } from "@/actions/patients";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataNewPatient") };
}

export default async function NewPatientPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const t = await getTranslations("protected");
  const { returnTo } = await searchParams;
  const patientsUrl = resolveReturnTo(returnTo, "/patients", ["/patients"]);
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const [
    { data: departments },
    { data: doctors },
    { data: insuranceProviders },
  ] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("profiles")
      .select("id, full_name, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("insurance_providers")
      .select("id, name")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: patientsUrl, label: "patients" }}
        breadcrumbs={[{ label: t("patients"), href: patientsUrl }, { label: t("newPatient2") }]}
        title={t("newPatient")}
        description={t("addANewPatientRecordTo")}
      />

      <div className="max-w-2xl mx-auto rounded-xl border border-border/50 bg-card p-6">
        <PatientForm
          action={createPatient}
          departments={departments ?? []}
          doctors={doctors ?? []}
          insuranceProviders={insuranceProviders ?? []}
          cancelHref={patientsUrl}
          profileReturnTo={patientsUrl}
        />
      </div>
    </div>
  );
}
