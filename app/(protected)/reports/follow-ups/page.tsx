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

  const [clinic, data] = await Promise.all([
    getClinicPrintMeta(user),
    getFollowupsReportData(range, outcome),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader title={t("followUpsReport")} description={t("completedFollowUpOutcomes")} />
      <ReportsDateFilter range={range} />
      <FollowupsOutcomeFilter value={outcome ?? "all"} />
      <FollowupsReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
