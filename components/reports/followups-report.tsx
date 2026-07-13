"use client";

import type { ClinicPrintMeta, FollowupsReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function FollowupsReport({
  data,
  range,
  clinic,
}: {
  data: FollowupsReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale } = useClinicSettings();
  const total = data.completedCount;
  const allFineRate = total === 0 ? 0 : (data.allFineCount / total) * 100;
  const hasProblemRate = total === 0 ? 0 : (data.hasProblemCount / total) * 100;
  const noResponseRate = total === 0 ? 0 : Math.max(0, 100 - allFineRate - hasProblemRate);
  const rows = [
    { label: "All fine", count: data.allFineCount, rate: allFineRate },
    { label: "Has problem", count: data.hasProblemCount, rate: hasProblemRate },
    { label: "No response", count: data.noResponseCount, rate: noResponseRate },
  ];

  return (
    <ReportSectionShell
      section="followups"
      title="Follow-ups Report"
      description="Completed follow-up outcomes."
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Completed follow-ups", value: formatNumber(data.completedCount, locale) },
          { label: "All fine", value: formatNumber(data.allFineCount, locale) },
          { label: "Has problem", value: formatNumber(data.hasProblemCount, locale) },
          { label: "No response", value: formatNumber(data.noResponseCount, locale) },
        ]}
      />

      {total === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-end">Count</TableHead>
                <TableHead className="text-end">Rate</TableHead>
                <TableHead className="print:hidden">Share</TableHead>
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
