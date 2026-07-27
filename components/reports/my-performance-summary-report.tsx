"use client";

import type {
  ClinicPrintMeta,
  MyPerformanceSummaryReportResponse,
  ReportDateRange,
} from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import {
  formatDateRangeLabel,
  formatNumber,
  formatPercent,
} from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

export function MyPerformanceSummaryReport({
  data,
  range,
  clinic,
}: {
  data: MyPerformanceSummaryReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
  const { locale } = useClinicSettings();
  const hasData = data.appointmentCount > 0 || data.replacedCount > 0;

  // Trend copy: no prior baseline → neutral placeholder; otherwise a signed %.
  const trendLabel =
    data.completedTrendPct === null
      ? "—"
      : `${data.completedTrendPct > 0 ? "+" : ""}${formatPercent(data.completedTrendPct, locale)}`;

  return (
    <ReportSectionShell
      section="my-performance"
      title={t("myPerformanceSummary")}
      description={t("yourOwnOperationalPerformance")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        mobileColumns={2}
        items={[
          { label: t("appointments"), value: formatNumber(data.appointmentCount, locale) },
          { label: t("completed"), value: formatNumber(data.completedCount, locale) },
          { label: t("cancellations"), value: formatNumber(data.cancelledCount, locale) },
          { label: t("cancellationRate"), value: formatPercent(data.cancellationRate, locale) },
          { label: t("noShows2"), value: formatNumber(data.noShowCount, locale) },
          { label: t("noShowRate"), value: formatPercent(data.noShowRate, locale) },
          { label: t("replaced2"), value: formatNumber(data.replacedCount, locale) },
          { label: t("replacementRate"), value: formatPercent(data.replacementRate, locale) },
        ]}
      />

      {!hasData ? (
        <EmptyReportState />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("metric")}</TableHead>
                  <TableHead className="text-end">{t("value")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <PerformanceRow label={t("uniquePatients")} value={formatNumber(data.uniquePatients, locale)} />
                <PerformanceRow label={t("activeDays")} value={formatNumber(data.activeDays, locale)} />
                <PerformanceRow
                  label={t("averagePatientsPerDay")}
                  value={formatNumber(data.averagePatientsPerDay, locale)}
                />
                <PerformanceRow
                  label={t("completedVsPreviousPeriod")}
                  value={`${formatNumber(data.completedCount, locale)} · ${trendLabel}`}
                />
              </TableBody>
            </Table>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("followUps")}</TableHead>
                  <TableHead className="text-end">{t("value")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <PerformanceRow
                  label={t("followUpsDue")}
                  value={formatNumber(data.followupsEligible, locale)}
                />
                <PerformanceRow
                  label={t("followUpsCompleted")}
                  value={formatNumber(data.followupsCompleted, locale)}
                />
                <PerformanceRow
                  label={t("followUpCompletionRate")}
                  value={formatPercent(data.followupCompletionRate, locale)}
                />
                <PerformanceRow
                  label={t("overdueFollowUps")}
                  value={formatNumber(data.overdueFollowups, locale)}
                />
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </ReportSectionShell>
  );
}

function PerformanceRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-end tabular-nums">{value}</TableCell>
    </TableRow>
  );
}
