import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireReportAccess } from "@/lib/reports/access";
import {
  ALL_FILTER_VALUE,
  cleanFilter,
  getClinicPrintMeta,
  getDoctorOptions,
  getDoctorPerformanceData,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { DoctorPerformanceReport } from "@/components/reports/doctor-performance-report";
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
  return { title: t("metadataDoctorPerformanceReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function DoctorPerformanceReportPage({ searchParams }: PageProps) {
  const [t, tDocuments, locale] = await Promise.all([
    getTranslations("protected"),
    getTranslations("documentPlatform.ui"),
    getLocale() as Promise<Locale>,
  ]);
  const user = await requireReportAccess("doctor_performance");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  const doctorId = cleanFilter(sp.doctor);
  const documentQuery = new URLSearchParams({
    from: range.from,
    to: range.to,
    locale,
  });
  if (doctorId) documentQuery.set("doctor", doctorId);

  const [clinic, doctors, data, assistant] = await Promise.all([
    getClinicPrintMeta(user),
    getDoctorOptions(user),
    getDoctorPerformanceData(range, doctorId),
    resolveAssistantLauncher({
      user,
      context: {
        type: "reports",
        report: "doctor_performance",
        range: { from: range.from, to: range.to },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <ReportPageHeader
        title={t("doctorPerformanceReport")}
        description={t("doctorSessionsOutcomesRevenueAndClinic")}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/reports/doctors/document?${documentQuery.toString()}`}>
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
        name="doctor"
        label={t("doctor")}
        value={doctorId ?? ALL_FILTER_VALUE}
        allLabel={t("allDoctors")}
        options={doctors}
      />
      <DoctorPerformanceReport data={data} range={range} clinic={clinic} />
    </div>
  );
}
