import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess } from "@/lib/reports/access";
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
import { getLocale, getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataFollowUpsReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function FollowupsReportPage({ searchParams }: PageProps) {
  const [t, tDocuments, locale] = await Promise.all([
    getTranslations("protected"),
    getTranslations("documentPlatform.ui"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("followups");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const outcome = parseFollowupOutcome(sp.outcome);
  const documentQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    locale,
  });
  if (outcome) documentQuery.set("outcome", outcome);

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
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/follow-ups/document?${documentQuery.toString()}`}>
                <FileText data-icon="inline-start" />
                {tDocuments("previewDocument")}
              </Link>
            </Button>
            <AssistantLauncherEntry resolution={assistant} role={user.role} />
          </div>
        )}
      />
      <ReportsDateFilter range={range} />
      <FollowupsOutcomeFilter value={outcome ?? "all"} />
      <FollowupsReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
