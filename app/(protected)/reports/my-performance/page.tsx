import type { Metadata } from "next";
import { requireReportAccess } from "@/lib/reports/access";
import {
  getClinicPrintMeta,
  getMyAssistantPerformanceData,
  getMyPerformanceSummaryData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { MyPerformanceSummaryReport } from "@/components/reports/my-performance-summary-report";
import { MyAssistantPerformanceReport } from "@/components/reports/my-assistant-performance-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataMyPerformanceReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function MyPerformanceReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  // Enforces BOTH gates: doctor page authorization AND per-user report
  // visibility (default OFF). A hidden report 404s on direct URL.
  const user = await requireReportAccess("my_performance");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);

  const [clinic, data, assistantPerformance, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    // No doctor filter: the RLS-scoped RPC already returns the caller's own
    // operational KPIs.
    getMyPerformanceSummaryData(range),
    // Phase 8C — the operational activity of the assistants assigned to this
    // doctor. The RPC is doctor-only and scoped to the caller's own entities; it
    // returns an empty list when the doctor has no assigned assistants, in which
    // case the section is omitted entirely.
    getMyAssistantPerformanceData(range),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "my_performance",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ReportPageHeader
        title={t("myPerformanceReport")}
        description={t("yourOwnOperationalPerformance")}
        actions={<AssistantLauncherEntry resolution={assistant} role={user.role} />}
      />
      <div className="order-2 space-y-6 md:order-1" data-testid="my-performance-report-filters">
        <ReportsDateFilter range={range} />
      </div>
      <div className="order-1 space-y-6 md:order-2" data-testid="my-performance-report-results">
        <MyPerformanceSummaryReport data={data} range={range} clinic={clinic} />
        {assistantPerformance.assistants.length > 0 && (
          <MyAssistantPerformanceReport
            data={assistantPerformance}
            range={range}
            clinic={clinic}
          />
        )}
      </div>
    </div>
  );
}
