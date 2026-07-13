"use client";

import type { CancellationReportResponse, ClinicPrintMeta, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="text-end">Total</TableHead>
                  <TableHead className="text-end">Cancelled</TableHead>
                  <TableHead className="text-end">Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byDoctor.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-4 text-center text-muted-foreground" colSpan={4}>
                      No doctor breakdown available.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.byDoctor.map((row) => (
                    <TableRow key={row.doctorId}>
                      <TableCell className="font-medium">{row.doctorName || "Unknown doctor"}</TableCell>
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
