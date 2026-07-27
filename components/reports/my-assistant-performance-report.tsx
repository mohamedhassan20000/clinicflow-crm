"use client";

import type {
  ClinicPrintMeta,
  MyAssistantPerformanceReportResponse,
  ReportDateRange,
} from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber } from "@/components/reports/report-formatters";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

/**
 * Phase 8C — "My Assistant Performance", a section within the doctor's My
 * Performance page. Each assistant assigned to the viewing doctor is shown
 * separately with factual actor-level activity counts (drawn from the Phase 8D
 * trail, scoped to this doctor's own entities). There is no composite score.
 *
 * The parent page only renders this when the doctor has at least one assigned
 * assistant, so `assistants` is expected non-empty; the empty state is a
 * defensive fallback.
 */
export function MyAssistantPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: MyAssistantPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
  const { locale } = useClinicSettings();

  return (
    <ReportSectionShell
      section="my-assistant-performance"
      title={t("myAssistantPerformanceSummary")}
      description={t("operationalActivityOfYourAssistants")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      {data.assistants.length === 0 ? (
        <EmptyReportState message={t("noAssistantsAssignedToYou")} />
      ) : (
        <div className="space-y-6">
          {data.assistants.map((assistant) => (
            <div
              key={assistant.assistantId}
              className="space-y-3 rounded-lg border border-border/50 p-4 print:border-black"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{assistant.assistantName}</h3>
                <span className="text-xs text-muted-foreground print:text-black">
                  {t("totalActionsCount", { count: assistant.totalActions })}
                </span>
              </div>
              <MetricGrid
                mobileColumns={2}
                items={[
                  { label: t("appointmentsBooked"), value: formatNumber(assistant.appointmentsBooked, locale) },
                  { label: t("confirmations"), value: formatNumber(assistant.confirmations, locale) },
                  { label: t("checkIns"), value: formatNumber(assistant.checkIns, locale) },
                  { label: t("completions"), value: formatNumber(assistant.completions, locale) },
                  { label: t("cancellations"), value: formatNumber(assistant.cancellations, locale) },
                  { label: t("noShows2"), value: formatNumber(assistant.noShows, locale) },
                  { label: t("reschedules"), value: formatNumber(assistant.reschedules, locale) },
                  { label: t("replaced2"), value: formatNumber(assistant.replacements, locale) },
                  { label: t("statusChanges"), value: formatNumber(assistant.statusChanges, locale) },
                  { label: t("followUpsRecorded"), value: formatNumber(assistant.followUpsRecorded, locale) },
                  { label: t("followUpUpdates"), value: formatNumber(assistant.followUpUpdates, locale) },
                ]}
              />
            </div>
          ))}
        </div>
      )}
    </ReportSectionShell>
  );
}
