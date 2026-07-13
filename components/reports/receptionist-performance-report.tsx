"use client";

import type { ClinicPrintMeta, ReceptionistPerformanceReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function ReceptionistPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: ReceptionistPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale } = useClinicSettings();
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
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Receptionists", value: formatNumber(data.receptionists.length, locale) },
          { label: "Appointments booked", value: formatNumber(totals.appointments, locale) },
          { label: "Follow-ups handled", value: formatNumber(totals.followups, locale) },
        ]}
      />

      {data.receptionists.length === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Receptionist</TableHead>
                <TableHead className="text-end">Appointments booked</TableHead>
                <TableHead className="text-end">Appointment share</TableHead>
                <TableHead className="text-end">Follow-ups handled</TableHead>
                <TableHead className="text-end">Follow-up share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.receptionists.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name || "Unknown receptionist"}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatNumber(row.appointmentsBooked, locale)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatPercent(row.appointmentShare, locale)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatNumber(row.followupsHandled, locale)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatPercent(row.followupShare, locale)}
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
