"use client";

import type { ClinicPrintMeta, FollowupsReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

export function FollowupsReport({
  data,
  range,
  clinic,
}: {
  data: FollowupsReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
  const { locale } = useClinicSettings();
  const total = data.completedCount;
  const allFineRate = total === 0 ? 0 : (data.allFineCount / total) * 100;
  const hasProblemRate = total === 0 ? 0 : (data.hasProblemCount / total) * 100;
  const noResponseRate = total === 0 ? 0 : Math.max(0, 100 - allFineRate - hasProblemRate);
  const rows = [
    { label: t("allFine"), count: data.allFineCount, rate: allFineRate },
    { label: t("hasProblem"), count: data.hasProblemCount, rate: hasProblemRate },
    { label: t("noResponse"), count: data.noResponseCount, rate: noResponseRate },
  ];

  return (
    <ReportSectionShell
      section="followups"
      title={t("followUpsReport")}
      description={t("completedFollowUpOutcomes")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: t("completedFollowUps"), value: formatNumber(data.completedCount, locale) },
          { label: t("allFine"), value: formatNumber(data.allFineCount, locale) },
          { label: t("hasProblem"), value: formatNumber(data.hasProblemCount, locale) },
          { label: t("noResponse"), value: formatNumber(data.noResponseCount, locale) },
        ]}
      />

      {total === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>{t("outcome")}</TableHead>
                <TableHead className="text-end">{t("count")}</TableHead>
                <TableHead className="text-end">{t("rate")}</TableHead>
                <TableHead className="print:hidden">{t("share")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.count, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.rate, locale)}</TableCell>
                  <TableCell className="print:hidden">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, row.rate))}%` }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ReportSectionShell>
  );
}
