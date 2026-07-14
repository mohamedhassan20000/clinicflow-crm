import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments, getCachedInsuranceProviders, getCachedStaff } from "@/lib/cache/reference-data";
import { NewAppointmentLayout } from "@/components/appointments/new-appointment-layout";
import { createAppointment } from "@/actions/appointments";
import { getClinicWorkingHours } from "@/actions/settings";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataNewAppointment") };
}

interface PageProps {
  searchParams: Promise<{
    patient_id?: string;
    doctor_id?: string;
    dept_id?: string;
    insurance_id?: string;
    returnTo?: string;
  }>;
}

export default async function NewAppointmentPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "receptionist"]);
  const { patient_id, doctor_id, dept_id, insurance_id, returnTo } = await searchParams;
  const allowedParentPaths = [
    "/appointments",
    ...(patient_id ? [`/patients/${patient_id}`] : []),
  ];
  const returnHref = resolveReturnTo(returnTo, "/appointments", allowedParentPaths);
  const returnsToPatient = returnHref.startsWith("/patients/");
  const supabase = await createClient();

  const [{ data: patients }, { data: packageRows }, cachedStaff, cachedDepartments, cachedInsurance, clinicWorkingHours] =
    await Promise.all([
      supabase
        .from("patients")
        .select(
          "id, full_name, phone, department_id, assigned_doctor_id, insurance_provider_id, national_id, file_number, assigned_doctor:profiles!assigned_doctor_id(id, full_name, department_id)",
        )
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .order("full_name"),
      supabase
        .from("patient_packages")
        .select("id, patient_id, name, total_sessions, used_sessions, price_per_session")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false }),
      getCachedStaff(user.clinicId),
      getCachedDepartments(user.clinicId),
      getCachedInsuranceProviders(user.clinicId),
      getClinicWorkingHours(),
    ]);

  const doctors = cachedStaff
    .filter((s) => s.role === "doctor" && s.is_active && !s.deleted_at)
    .map((s) => ({ id: s.id, full_name: s.full_name, department_id: s.department_id }));
  const departments = cachedDepartments
    .filter((d) => !d.deleted_at && d.is_active)
    .map((d) => ({ id: d.id, name: d.name }));
  const insurance = cachedInsurance
    .filter((p) => !p.deleted_at && p.is_active)
    .map((p) => ({ id: p.id, name: p.name }));
  const packages = (packageRows ?? []).filter(
    (pkg) => Number(pkg.used_sessions) < Number(pkg.total_sessions),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: returnHref, label: returnsToPatient ? "patient" : "appointments" }}
        breadcrumbs={returnsToPatient
          ? [{ label: t("patients"), href: "/patients" }, { label: t("patient"), href: returnHref }, { label: t("newAppointment2") }]
          : [{ label: t("appointments"), href: returnHref }, { label: t("newAppointment2") }]}
        title={t("newAppointment")}
        description={t("bookANewAppointmentForA")}
      />

      <NewAppointmentLayout
        action={createAppointment}
        patients={patients ?? []}
        doctors={doctors ?? []}
        departments={departments ?? []}
        insuranceProviders={insurance ?? []}
        packages={packages}
        defaultPatientId={patient_id}
        defaultDoctorId={doctor_id}
        defaultDepartmentId={dept_id}
        defaultInsuranceId={insurance_id}
        clinicWorkingHours={clinicWorkingHours}
        cancelHref={returnHref}
      />
    </div>
  );
}
