"use client";

import type { ClinicPrintMeta, ReceptionistPerformanceReportResponse, ReportDateRange } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import { formatDateRangeLabel, formatNumber, formatPercent } from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

export function ReceptionistPerformanceReport({
  data,
  range,
  clinic,
}: {
  data: ReceptionistPerformanceReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
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
      title={t("receptionistPerformance")}
      description={t("bookingsAndFollowUpsHandledBy")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: t("receptionists"), value: formatNumber(data.receptionists.length, locale) },
          { label: t("appointmentsBooked2"), value: formatNumber(totals.appointments, locale) },
          { label: t("followUpsHandled2"), value: formatNumber(totals.followups, locale) },
        ]}
      />

      {data.receptionists.length === 0 ? (
        <EmptyReportState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>{t("receptionist")}</TableHead>
                <TableHead className="text-end">{t("appointmentsBooked")}</TableHead>
                <TableHead className="text-end">{t("appointmentShare")}</TableHead>
                <TableHead className="text-end">{t("followUpsHandled")}</TableHead>
                <TableHead className="text-end">{t("followUpShare")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.receptionists.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name || t("unknownReceptionist")}</TableCell>
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
