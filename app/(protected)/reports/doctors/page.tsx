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

export const metadata: Metadata = { title: "Doctor Performance Report" };

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function DoctorPerformanceReportPage({ searchParams }: PageProps) {
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
        title="Doctor Performance Report"
        description="Doctor sessions, outcomes, revenue, and clinic share."
      />
      <ReportsDateFilter range={range} />
      <ReportSelectFilter
        name="doctor"
        label="Doctor"
        value={doctorId ?? ALL_FILTER_VALUE}
        allLabel="All doctors"
        options={doctors}
      />
      <DoctorPerformanceReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
