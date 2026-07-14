import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getClinicPrintMeta,
  getDepartmentOptions,
  getDoctorOptions,
  getRevenueSummaryData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportSelectFilter } from "@/components/reports/report-select-filter";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { RevenueSummaryReport } from "@/components/reports/revenue-summary-report";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataRevenueSalesReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function RevenueReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager", "receptionist"]);
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const doctorId = cleanFilter(sp.doctor);
  const departmentId = cleanFilter(sp.department);

  const [clinic, doctors, departments, data] = await Promise.all([
    getClinicPrintMeta(user),
    getDoctorOptions(user),
    getDepartmentOptions(user),
    getRevenueSummaryData(range, doctorId, departmentId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ReportPageHeader
        title={t("revenueSalesReport")}
        description={t("collectedPaymentsDepositsSettlementsAndOutstanding")}
      />
      <div className="order-2 space-y-6 md:order-1" data-testid="revenue-report-filters">
        <ReportsDateFilter range={range} />
        <div className="grid gap-4 lg:grid-cols-2">
          <ReportSelectFilter
            name="doctor"
            label={t("doctor")}
            value={doctorId ?? ALL_FILTER_VALUE}
            allLabel={t("allDoctors")}
            options={doctors}
          />
          <ReportSelectFilter
            name="department"
            label={t("department")}
            value={departmentId ?? ALL_FILTER_VALUE}
            allLabel={t("allDepartments")}
            options={departments}
          />
        </div>
      </div>
      <div className="order-1 md:order-2" data-testid="revenue-report-results">
        <RevenueSummaryReport data={data} range={range} clinic={clinic} />
      </div>
    </div>
  );
}
