"use client";

import type { ClinicPrintMeta, ReceptionistPerformanceReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";

export function ReceptionistPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: ReceptionistPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const totals = data.receptionists.reduce(
    (acc, row) => ({
      appointments: acc.appointments + row.appointmentsBooked,
      followups: acc.followups + row.followupsHandled,
    }),
    { appointments: 0, followups: 0 },
  );

  return (
    <ReportSectionShell
      section="receptionist-performance"
      title="Receptionist Performance"
      description="Bookings and follow-ups handled by receptionist."
      rangeLabel={formatDateRangeLabel(range.from, range.to)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Receptionists", value: formatNumber(data.receptionists.length) },
          { label: "Appointments booked", value: formatNumber(totals.appointments) },
          { label: "Follow-ups handled", value: formatNumber(totals.followups) },
        ]}
      />

      {data.receptionists.length === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Receptionist</th>
                <th className="px-3 py-2 text-right font-medium">Appointments booked</th>
                <th className="px-3 py-2 text-right font-medium">Appointment share</th>
                <th className="px-3 py-2 text-right font-medium">Follow-ups handled</th>
                <th className="px-3 py-2 text-right font-medium">Follow-up share</th>
              </tr>
            </thead>
            <tbody>
              {data.receptionists.map((row) => (
                <tr key={row.id} className="border-t border-border/50">
                  <td className="px-3 py-2 font-medium">{row.name || "Unknown receptionist"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.appointmentsBooked)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPercent(row.appointmentShare)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.followupsHandled)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPercent(row.followupShare)}
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
