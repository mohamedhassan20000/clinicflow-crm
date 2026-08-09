import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess } from "@/lib/reports/access";
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
import { getLocale, getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataReceptionistPerformanceReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function ReceptionistPerformanceReportPage({ searchParams }: PageProps) {
  const [t, tDocuments, locale] = await Promise.all([
    getTranslations("protected"),
    getTranslations("documentPlatform.ui"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("receptionist_performance");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const receptionistId = cleanFilter(sp.receptionist);
  const documentQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    locale,
  });
  if (receptionistId) documentQuery.set("receptionist", receptionistId);

  const [clinic, receptionists, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    getReceptionistOptions(user),
    getReceptionistPerformanceData(range, receptionistId),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "receptionist_performance",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("receptionistPerformanceReport")}
        description={t("bookingsAndFollowUpsHandledBy")}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/receptionists/document?${documentQuery.toString()}`}>
                <FileText data-icon="inline-start" />
                {tDocuments("previewDocument")}
              </Link>
            </Button>
            <AssistantLauncherEntry resolution={assistant} role={user.role} />
          </div>
        )}
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
