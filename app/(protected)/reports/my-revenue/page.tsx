import type { Metadata } from "next";
import { requireReportAccess } from "@/lib/reports/access";
import {
  getClinicPrintMeta,
  getMyRevenueSummaryData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { MyRevenueSummaryReport } from "@/components/reports/my-revenue-summary-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataMyRevenueReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function MyRevenueReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  // Enforces BOTH gates: doctor/assistant page authorization AND per-user
  // report visibility (default OFF). A hidden report 404s on direct URL.
  const user = await requireReportAccess("my_revenue");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);

  const [clinic, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    // No doctor filter: the RLS-scoped RPC already returns the caller's own /
    // supervised-doctor union revenue.
    getMyRevenueSummaryData(range),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "my_revenue",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ReportPageHeader
        title={t("myRevenueReport")}
        description={t("yourCollectedRevenueFromCompletedAppointments")}
        actions={<AssistantLauncherEntry resolution={assistant} role={user.role} />}
      />
      <div className="order-2 space-y-6 md:order-1" data-testid="my-revenue-report-filters">
        <ReportsDateFilter range={range} />
      </div>
      <div className="order-1 md:order-2" data-testid="my-revenue-report-results">
        <MyRevenueSummaryReport data={data} range={range} clinic={clinic} />
      </div>
    </div>
  );
}
