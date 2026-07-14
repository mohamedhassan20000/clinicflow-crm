import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getClinicPrintMeta,
  getReceptionistOptions,
  getReceptionistPerformanceData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { ReceptionistPerformanceReport } from "@/components/reports/receptionist-performance-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportSelectFilter } from "@/components/reports/report-select-filter";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataReceptionistPerformanceReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function ReceptionistPerformanceReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const receptionistId = cleanFilter(sp.receptionist);

  const [clinic, receptionists, data] = await Promise.all([
    getClinicPrintMeta(user),
    getReceptionistOptions(user),
    getReceptionistPerformanceData(range, receptionistId),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("receptionistPerformanceReport")}
        description={t("bookingsAndFollowUpsHandledBy")}
      />
      <ReportsDateFilter range={range} />
      <ReportSelectFilter
        name="receptionist"
        label={t("receptionist")}
        value={receptionistId ?? ALL_FILTER_VALUE}
        allLabel={t("allReceptionists")}
        options={receptionists}
      />
      <ReceptionistPerformanceReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
