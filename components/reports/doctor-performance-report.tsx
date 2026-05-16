"use client";

import type { ClinicPrintMeta, DoctorPerformanceReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import {
  formatCurrency,
  formatDateRangeLabel,
  formatNumber,
  formatPercent,
} from "@/components/reports/report-formatters";

export function DoctorPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: DoctorPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
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
      rangeLabel={formatDateRangeLabel(range.from, range.to)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Doctors", value: formatNumber(data.doctors.length) },
          { label: "Sessions", value: formatNumber(totals.sessions) },
          { label: "Completed", value: formatNumber(totals.completed) },
          { label: "Revenue", value: formatCurrency(totals.revenue) },
        ]}
      />

      {data.doctors.length === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <table className="min-w-[1120px] text-sm print:min-w-0">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Doctor</th>
                <th className="px-3 py-2 text-right font-medium">Sessions</th>
                <th className="px-3 py-2 text-right font-medium">Completed</th>
                <th className="px-3 py-2 text-right font-medium">Cancelled</th>
                <th className="px-3 py-2 text-right font-medium">No-show</th>
                <th className="px-3 py-2 text-right font-medium">Patients</th>
                <th className="px-3 py-2 text-right font-medium">Revenue</th>
                <th className="px-3 py-2 text-right font-medium">Complete</th>
                <th className="px-3 py-2 text-right font-medium">Cancel</th>
                <th className="px-3 py-2 text-right font-medium">No-show</th>
                <th className="px-3 py-2 text-right font-medium">Dept patients</th>
                <th className="px-3 py-2 text-right font-medium">Clinic patients</th>
                <th className="px-3 py-2 text-right font-medium">Dept revenue</th>
                <th className="px-3 py-2 text-right font-medium">Clinic revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.doctors.map((row) => (
                <tr key={row.doctorId} className="border-t border-border/50">
                  <td className="px-3 py-2 font-medium">{row.doctorName || "Unknown doctor"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.sessions)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.completed)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.cancelled)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.noShow)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.uniquePatients)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.completionRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.cancellationRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.noShowRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.deptPatientShare)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.clinicPatientShare)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.deptRevenueShare)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.clinicRevenueShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportSectionShell>
  );
}
