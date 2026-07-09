"use client";

import type { CancellationReportResponse, ClinicPrintMeta, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function CancellationReport({
  data,
  range,
  clinic,
}: {
  data: CancellationReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale } = useClinicSettings();
  const hasRows = data.totalAppointments > 0 || data.byDoctor.length > 0 || data.byReason.length > 0;

  return (
    <ReportSectionShell
      section="cancellation"
      title="Cancellation Report"
      description="Cancelled appointments by doctor and reason."
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Appointments", value: formatNumber(data.totalAppointments, locale) },
          { label: "Cancelled", value: formatNumber(data.cancelledCount, locale) },
          { label: "Cancellation rate", value: formatPercent(data.cancellationRate, locale) },
        ]}
      />

      {!hasRows ? (
        <EmptyReportState />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
          <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Doctor</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Cancelled</th>
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
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.total, locale)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.cancelled, locale)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.rate, locale)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border/50 print:border-black">
            <div className="border-b border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground print:border-black print:text-black">
              Top cancellation reasons
            </div>
            {data.byReason.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground print:text-black">
                No reasons recorded.
              </div>
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
