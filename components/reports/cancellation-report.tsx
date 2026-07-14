"use client";

import type { CancellationReportResponse, ClinicPrintMeta, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

export function CancellationReport({
  data,
  range,
  clinic,
}: {
  data: CancellationReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
  const { locale } = useClinicSettings();
  const hasRows = data.totalAppointments > 0 || data.byDoctor.length > 0 || data.byReason.length > 0;

  return (
    <ReportSectionShell
      section="cancellation"
      title={t("cancellationReport")}
      description={t("cancelledAppointmentsByDoctorAndReason")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: t("appointments"), value: formatNumber(data.totalAppointments, locale) },
          { label: t("cancelled2"), value: formatNumber(data.cancelledCount, locale) },
          { label: t("cancellationRate"), value: formatPercent(data.cancellationRate, locale) },
        ]}
      />

      {!hasRows ? (
        <EmptyReportState />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("doctor")}</TableHead>
                  <TableHead className="text-end">{t("total")}</TableHead>
                  <TableHead className="text-end">{t("cancelled")}</TableHead>
                  <TableHead className="text-end">{t("rate")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byDoctor.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-4 text-center text-muted-foreground" colSpan={4}>
                      {t("noDoctorBreakdownAvailable")}</TableCell>
                  </TableRow>
                ) : (
                  data.byDoctor.map((row) => (
                    <TableRow key={row.doctorId}>
                      <TableCell className="font-medium">{row.doctorName || t("unknownDoctor")}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatNumber(row.total, locale)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatNumber(row.cancelled, locale)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatPercent(row.rate, locale)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="rounded-lg border border-border/50 print:border-black">
            <div className="border-b border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground print:border-black print:text-black">
              {t("topCancellationReasons")}</div>
            {data.byReason.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground print:text-black">
                {t("noReasonsRecorded")}</div>
            ) : (
              <ul className="divide-y divide-border/50 print:divide-black">
                {data.byReason.map((row) => (
                  <li key={row.reason} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{row.reason}</span>
                    <span className="tabular-nums text-muted-foreground print:text-black">
                      {formatNumber(row.count, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </ReportSectionShell>
  );
}
