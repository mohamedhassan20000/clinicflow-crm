import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess, reportScopeLockedToSelf } from "@/lib/reports/access";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getCancellationReportData,
  getClinicPrintMeta,
  getDoctorOptions,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { CancellationReport } from "@/components/reports/cancellation-report";
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
  return { title: t("metadataCancellationReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function CancellationReportPage({ searchParams }: PageProps) {
  const [t, tDocuments, locale] = await Promise.all([
    getTranslations("protected"),
    getTranslations("documentPlatform.ui"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("cancellations");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  // Doctors/assistants are locked to their own scope (RLS): ignore any doctor
  // filter and never load the clinic-wide doctor list for them.
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
    getCancellationReportData(user, range, doctorId),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "cancellations",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("cancellationReport")}
        description={t("cancelledAppointmentsByDoctorAndReason")}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/cancellations/document?${documentQuery.toString()}`}>
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
      <CancellationReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
