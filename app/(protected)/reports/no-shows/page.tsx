import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getClinicPrintMeta,
  getDoctorOptions,
  getNoShowReportData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { NoShowReport } from "@/components/reports/no-show-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportSelectFilter } from "@/components/reports/report-select-filter";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";

export const metadata: Metadata = { title: "No-show Report" };

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function NoShowReportPage({ searchParams }: PageProps) {
  const user = await requireRole(["admin", "manager", "receptionist"]);
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const doctorId = cleanFilter(sp.doctor);

  const [clinic, doctors, data] = await Promise.all([
    getClinicPrintMeta(user),
    getDoctorOptions(user),
    getNoShowReportData(range, doctorId),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader title="No-show Report" description="No-show appointments by doctor." />
      <ReportsDateFilter range={range} />
      <ReportSelectFilter
        name="doctor"
        label="Doctor"
        value={doctorId ?? ALL_FILTER_VALUE}
        allLabel="All doctors"
        options={doctors}
      />
      <NoShowReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
