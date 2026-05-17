"use client";

import type { ClinicPrintMeta, NoShowReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";

export function NoShowReport({
  data,
  range,
  clinic,
}: {
  data: NoShowReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const hasRows = data.totalAppointments > 0 || data.byDoctor.length > 0;

  return (
    <ReportSectionShell
      section="no-show"
      title="No-show Report"
      description="No-show appointments by doctor."
      rangeLabel={formatDateRangeLabel(range.from, range.to)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Appointments", value: formatNumber(data.totalAppointments) },
          { label: "No-shows", value: formatNumber(data.noShowCount) },
          { label: "No-show rate", value: formatPercent(data.noShowRate) },
        ]}
      />

      {!hasRows ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Doctor</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">No-shows</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.byDoctor.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-muted-foreground" colSpan={4}>
                    No doctor breakdown available.
                  </td>
                </tr>
              ) : (
                data.byDoctor.map((row) => (
                  <tr key={row.doctorId} className="border-t border-border/50">
                    <td className="px-3 py-2 font-medium">{row.doctorName || "Unknown doctor"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.noShow)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.rate)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </ReportSectionShell>
  );
}
