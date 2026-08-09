import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { clinicLocaleFromRow, formatClinicDate } from "@/lib/datetime";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { PrintHeader } from "@/components/shared/print-header";
import { PatientReportHeader } from "@/components/patients/patient-report-header";
import { HistoryDateFilter } from "@/components/patients/file/history-date-filter";
import {
  PatientPackagesSection,
  type PatientPackageDepartment,
  type PatientPackageItem,
  type PatientPackageService,
  type PatientPackageTemplate,
} from "@/components/patients/patient-packages-section";
import { buildDocumentQuery, resolveHistoryRange } from "@/lib/patients/file-data";
import { resolveReturnTo } from "@/lib/navigation/return-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("patients");
  return { title: t("packages") };
}

type PackageStatus = "all" | "active" | "inactive";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    status?: string;
    preset?: string;
    from?: string;
    to?: string;
    returnTo?: string;
  }>;
}

export default async function PatientPackagesPage({
  params,
  searchParams,
}: PageProps) {
  const t = await getTranslations("patients");
  const { id } = await params;
  const { status: statusParam, preset, from, to, returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientHref = resolveReturnTo(returnTo, patientPath, [patientPath]);
  const status: PackageStatus =
    statusParam === "active" || statusParam === "inactive" ? statusParam : "all";

  const user = await requireUser();
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, full_name, file_number, phone, is_deleted, department_id, assigned_doctor_id",
    )
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  if (user.role === "doctor") {
    const canAccess =
      patient.assigned_doctor_id === user.id ||
      (!!user.departmentId && patient.department_id === user.departmentId);
    if (!canAccess) notFound();
  }

  const range = resolveHistoryRange({ preset, from, to });
  const canManage =
    (user.role === "admin" || user.role === "receptionist") && !patient.is_deleted;

  const [
    { data: packageRows },
    { data: packageTemplates },
    { data: packageDepartments },
    { data: packageServices },
    { data: clinic },
  ] = await Promise.all([
    supabase
      .from("patient_packages")
      .select(
        "id, patient_id, department_id, service_id, name, total_sessions, used_sessions, price_per_session, notes, is_active, created_at, departments(id, name, color), services(id, name)",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .order("is_active", { ascending: false })
      .order("updated_at", { ascending: false }),
    supabase
      .from("package_templates")
      .select("id, department_id, name, total_sessions, price_per_session, total_price, notes, is_active")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true }),
    supabase
      .from("services")
      .select("id, name, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true }),
    supabase
      .from("clinics")
      .select("name, address, phone, logo_url, timezone, locale, digits, time_format")
      .eq("id", user.clinicId)
      .single(),
  ]);

  const allPackages = (packageRows ?? []) as (PatientPackageItem & {
    created_at: string;
  })[];
  const filteredPackages = allPackages.filter((pkg) => {
    if (status === "active" && !pkg.is_active) return false;
    if (status === "inactive" && pkg.is_active) return false;
    if (range.from && pkg.created_at < `${range.from}T00:00:00.000Z`) return false;
    if (range.to && pkg.created_at > `${range.to}T23:59:59.999Z`) return false;
    return true;
  });

  const clinicLocale = clinicLocaleFromRow(clinic);
  const generatedAt = formatClinicDate(new Date(), clinicLocale, {
    dateStyle: "long",
    timeStyle: "short",
  });
  const filtered = status !== "all" || range.preset !== "all";

  const statusOptions: { value: PackageStatus; labelKey: string }[] = [
    { value: "all", labelKey: "packageStatusAll" },
    { value: "active", labelKey: "active" },
    { value: "inactive", labelKey: "inactive" },
  ];

  function statusHref(next: PackageStatus): string {
    const p = new URLSearchParams();
    if (next !== "all") p.set("status", next);
    if (range.preset !== "all") p.set("preset", range.preset);
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    const qs = p.toString();
    return qs ? `${patientPath}/packages?${qs}` : `${patientPath}/packages`;
  }

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName={t("packages")}
        generatedAt={generatedAt}
      />
      <PatientReportHeader
        patientHref={patientHref}
        patientName={patient.full_name}
        fileNumber={patient.file_number}
        phone={patient.phone}
        title={t("packages")}
        countLabel={`${t("packageRecordCount", { count: filteredPackages.length })}${
          filtered ? ` · ${t("filtered")}` : ""
        }`}
        documentHref={`/documents/patient-history/package-history?${buildDocumentQuery(id, range)}`}
        showPrint={false}
      />

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {statusOptions.map((option) => (
          <Button
            key={option.value}
            asChild
            size="sm"
            variant={status === option.value ? "default" : "outline"}
            className="h-8"
          >
            <Link href={statusHref(option.value)}>{t(option.labelKey)}</Link>
          </Button>
        ))}
      </div>

      <HistoryDateFilter preset={range.preset} from={range.from} to={range.to} />

      <PatientPackagesSection
        patientId={id}
        packages={filteredPackages}
        departments={(packageDepartments ?? []) as PatientPackageDepartment[]}
        services={(packageServices ?? []) as PatientPackageService[]}
        packageTemplates={(packageTemplates ?? []) as PatientPackageTemplate[]}
        patientDepartmentId={patient.department_id}
        canManage={canManage}
      />
    </div>
  );
}
