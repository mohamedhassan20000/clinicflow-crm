"use client";

import type { ClinicPrintMeta, FollowupsReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";

export function FollowupsReport({
  data,
  range,
  clinic,
}: {
  data: FollowupsReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
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
      rangeLabel={formatDateRangeLabel(range.from, range.to)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Completed follow-ups", value: formatNumber(data.completedCount) },
          { label: "All fine", value: formatNumber(data.allFineCount) },
          { label: "Has problem", value: formatNumber(data.hasProblemCount) },
          { label: "No response", value: formatNumber(data.noResponseCount) },
        ]}
      />

      {total === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 text-right font-medium">Count</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 font-medium print:hidden">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-border/50">
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.count)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.rate)}</td>
                  <td className="px-3 py-2 print:hidden">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, row.rate))}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportSectionShell>
  );
}
