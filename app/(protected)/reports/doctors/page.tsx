import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getClinicPrintMeta,
  getDoctorOptions,
  getDoctorPerformanceData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { DoctorPerformanceReport } from "@/components/reports/doctor-performance-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportSelectFilter } from "@/components/reports/report-select-filter";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataDoctorPerformanceReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function DoctorPerformanceReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const doctorId = cleanFilter(sp.doctor);

  const [clinic, doctors, data] = await Promise.all([
    getClinicPrintMeta(user),
    getDoctorOptions(user),
    getDoctorPerformanceData(range, doctorId),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("doctorPerformanceReport")}
        description={t("doctorSessionsOutcomesRevenueAndClinic")}
      />
      <ReportsDateFilter range={range} />
      <ReportSelectFilter
        name="doctor"
        label={t("doctor")}
        value={doctorId ?? ALL_FILTER_VALUE}
        allLabel={t("allDoctors")}
        options={doctors}
      />
      <DoctorPerformanceReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
