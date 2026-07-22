import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import {
  getClinicPrintMeta,
  getFollowupsReportData,
  parseFollowupOutcome,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { FollowupsOutcomeFilter } from "@/components/reports/followups-outcome-filter";
import { FollowupsReport } from "@/components/reports/followups-report";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataFollowUpsReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function FollowupsReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager", "receptionist"]);
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const outcome = parseFollowupOutcome(sp.outcome);

  const [clinic, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    getFollowupsReportData(range, outcome),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "followups",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("followUpsReport")}
        description={t("completedFollowUpOutcomes")}
        actions={<AssistantLauncherEntry resolution={assistant} role={user.role} />}
      />
      <ReportsDateFilter range={range} />
      <FollowupsOutcomeFilter value={outcome ?? "all"} />
      <FollowupsReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
