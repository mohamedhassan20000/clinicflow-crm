"use client";

import type { ClinicPrintMeta, DoctorPerformanceReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import {
  formatDateRangeLabel,
  formatNumber,
  formatPercent,
} from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function DoctorPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: DoctorPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale, formatCurrency } = useClinicSettings();
  const totals = data.doctors.reduce(
    (acc, row) => ({
      sessions: acc.sessions + row.sessions,
      completed: acc.completed + row.completed,
      revenue: acc.revenue + row.revenue,
      uniquePatients: acc.uniquePatients + row.uniquePatients,
    }),
    { sessions: 0, completed: 0, revenue: 0, uniquePatients: 0 },
  );

  return (
    <ReportSectionShell
      section="doctor-performance"
      title="Doctor Performance"
      description="Doctor sessions, outcomes, revenue, and clinic share."
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Doctors", value: formatNumber(data.doctors.length, locale) },
          { label: "Sessions", value: formatNumber(totals.sessions, locale) },
          { label: "Completed", value: formatNumber(totals.completed, locale) },
          { label: "Revenue", value: formatCurrency(totals.revenue) },
        ]}
      />

      {data.doctors.length === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense className="min-w-[1120px] print:min-w-0">
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead className="text-end">Sessions</TableHead>
                <TableHead className="text-end">Completed</TableHead>
                <TableHead className="text-end">Cancelled</TableHead>
                <TableHead className="text-end">No-show</TableHead>
                <TableHead className="text-end">Patients</TableHead>
                <TableHead className="text-end">Revenue</TableHead>
                <TableHead className="text-end">Complete</TableHead>
                <TableHead className="text-end">Cancel</TableHead>
                <TableHead className="text-end">No-show</TableHead>
                <TableHead className="text-end">Dept patients</TableHead>
                <TableHead className="text-end">Clinic patients</TableHead>
                <TableHead className="text-end">Dept revenue</TableHead>
                <TableHead className="text-end">Clinic revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.doctors.map((row) => (
                <TableRow key={row.doctorId}>
                  <TableCell className="font-medium">{row.doctorName || "Unknown doctor"}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.sessions, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.completed, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.cancelled, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.noShow, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatNumber(row.uniquePatients, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCurrency(row.revenue)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.completionRate, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.cancellationRate, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.noShowRate, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.deptPatientShare, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.clinicPatientShare, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.deptRevenueShare, locale)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPercent(row.clinicRevenueShare, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ReportSectionShell>
  );
}
