import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess, reportScopeLockedToSelf } from "@/lib/reports/access";
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
import { getLocale, getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataNoShowReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function NoShowReportPage({ searchParams }: PageProps) {
  const [t, tDocuments, locale] = await Promise.all([
    getTranslations("protected"),
    getTranslations("documentPlatform.ui"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("no_shows");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const scopeLocked = reportScopeLockedToSelf(user.role);
  const doctorId = scopeLocked ? null : cleanFilter(sp.doctor);
  const documentQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    locale,
  });
  if (doctorId) documentQuery.set("doctor", doctorId);

  const [clinic, doctors, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    scopeLocked ? Promise.resolve([]) : getDoctorOptions(user),
    getNoShowReportData(range, doctorId),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "no_shows",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("noShowReport")}
        description={t("noShowAppointmentsByDoctor")}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/no-shows/document?${documentQuery.toString()}`}>
                <FileText data-icon="inline-start" />
                {tDocuments("previewDocument")}
              </Link>
            </Button>
            <AssistantLauncherEntry resolution={assistant} role={user.role} />
          </div>
        )}
      />
      <ReportsDateFilter range={range} />
      {scopeLocked ? null : (
        <ReportSelectFilter
          name="doctor"
          label={t("doctor")}
          value={doctorId ?? ALL_FILTER_VALUE}
          allLabel={t("allDoctors")}
          options={doctors}
        />
      )}
      <NoShowReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
