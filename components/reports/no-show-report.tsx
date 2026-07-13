"use client";

import type { ClinicPrintMeta, NoShowReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function NoShowReport({
  data,
  range,
  clinic,
}: {
  data: NoShowReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale } = useClinicSettings();
  const hasRows = data.totalAppointments > 0 || data.byDoctor.length > 0;

  return (
    <ReportSectionShell
      section="no-show"
      title="No-show Report"
      description="No-show appointments by doctor."
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Appointments", value: formatNumber(data.totalAppointments, locale) },
          { label: "No-shows", value: formatNumber(data.noShowCount, locale) },
          { label: "No-show rate", value: formatPercent(data.noShowRate, locale) },
        ]}
      />

      {!hasRows ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead className="text-end">Total</TableHead>
                <TableHead className="text-end">No-shows</TableHead>
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
                    <TableCell className="text-end tabular-nums">{formatNumber(row.noShow, locale)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatPercent(row.rate, locale)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </ReportSectionShell>
  );
}
