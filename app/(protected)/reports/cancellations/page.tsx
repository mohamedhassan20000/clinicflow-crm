import type { Metadata } from "next";
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
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataCancellationReport") };
}

type PageProps = {
  searchParams: Promise<ReportsSearchParams>;
};

export default async function CancellationReportPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const user = await requireReportAccess("cancellations");
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  // Doctors/assistants are locked to their own scope (RLS): ignore any doctor
  // filter and never load the clinic-wide doctor list for them.
  const scopeLocked = reportScopeLockedToSelf(user.role);
  const doctorId = scopeLocked ? null : cleanFilter(sp.doctor);

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
        actions={<AssistantLauncherEntry resolution={assistant} role={user.role} />}
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
