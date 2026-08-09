import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess } from "@/lib/reports/access";
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
import { getLocale, getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataRevenueSalesReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function RevenueReportPage({ searchParams }: PageProps) {
  const tDocuments = await getTranslations("documentPlatform.ui");
  const [t, locale] = await Promise.all([
    getTranslations("protected"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("revenue");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const doctorId = cleanFilter(sp.doctor);
  const departmentId = cleanFilter(sp.department);
  const documentQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    locale,
  });
  if (doctorId) documentQuery.set("doctor", doctorId);
  if (departmentId) documentQuery.set("department", departmentId);

  const [clinic, doctors, departments, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    getDoctorOptions(user),
    getDepartmentOptions(user),
    getRevenueSummaryData(range, doctorId, departmentId),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "revenue",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ReportPageHeader
        title={t("revenueSalesReport")}
        description={t("collectedPaymentsDepositsSettlementsAndOutstanding")}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/revenue/document?${documentQuery.toString()}`}>
                <FileText data-icon="inline-start" />
                {tDocuments("previewRevenueDocument")}
              </Link>
            </Button>
            <AssistantLauncherEntry resolution={assistant} role={user.role} />
          </div>
        )}
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
