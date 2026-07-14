import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientForm } from "@/components/patients/patient-form";
import { updatePatient } from "@/actions/patients";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataEditPatient") };
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}

export default async function EditPatientPage({ params, searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const { id } = await params;
  const { returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientUrl = resolveReturnTo(returnTo, patientPath, [patientPath]);
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const [
    { data: patient },
    { data: departments },
    { data: doctors },
    { data: insuranceProviders },
  ] = await Promise.all([
    supabase
      .from("patients")
      .select("*")
      .eq("id", id)
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false)
      .single(),
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

  if (!patient) notFound();

  const action = updatePatient.bind(null, id);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: patientUrl, label: patient.full_name }}
        breadcrumbs={[
          { label: t("patients"), href: "/patients" },
          { label: patient.full_name, href: patientUrl },
          { label: t("edit") },
        ]}
        title={t("editPatient")}
        description={t("updatePatientRecord", { patient: patient.full_name })}
      />

      <div className="max-w-2xl mx-auto rounded-xl border border-border/50 bg-card p-6">
        <PatientForm
          action={action}
          departments={departments ?? []}
          doctors={doctors ?? []}
          insuranceProviders={insuranceProviders ?? []}
          patient={patient}
          cancelHref={patientUrl}
          defaultValues={{
            full_name: patient.full_name,
            national_id: patient.national_id,
            date_of_birth: patient.date_of_birth,
            phone: patient.phone,
            email: patient.email,
            blood_type: patient.blood_type,
            department_id: patient.department_id,
            assigned_doctor_id: patient.assigned_doctor_id,
            insurance_provider_id: patient.insurance_provider_id,
          }}
        />
      </div>
    </div>
  );
}
