"use client";

import type { ClinicPrintMeta, ReportDateRange, RevenueSummaryReportResponse } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import {
  formatDateRangeLabel,
  formatNumber,
  humanizeKey,
} from "@/components/reports/report-formatters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export function RevenueSummaryReport({
  data,
  range,
  clinic,
}: {
  data: RevenueSummaryReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const { locale, formatCurrency } = useClinicSettings();
  const hasData =
    data.transactionCount > 0 ||
    data.settlementCount > 0 ||
    data.grossTotal > 0 ||
    data.methodBreakdown.length > 0;

  return (
    <ReportSectionShell
      section="revenue"
      title="Revenue / Sales Summary"
      description="Collected payments, deposits, settlements, and outstanding balances."
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        items={[
          { label: "Gross total", value: formatCurrency(data.grossTotal) },
          { label: "Service total", value: formatCurrency(data.totalAmount) },
          { label: "Primary payments", value: formatCurrency(data.primaryTotal) },
          { label: "Secondary payments", value: formatCurrency(data.secondaryTotal) },
          { label: "Insurance", value: formatCurrency(data.insuranceTotal) },
          { label: "Deposits", value: formatCurrency(data.depositTotal) },
          { label: "Settlements", value: formatCurrency(data.settlementsTotal) },
          { label: "Outstanding", value: formatCurrency(data.outstandingTotal) },
        ]}
      />

      {!hasData ? (
        <EmptyReportState />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-end">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <RevenueRow label="Transactions" value={formatNumber(data.transactionCount, locale)} />
                <RevenueRow label="Settlement payments" value={formatNumber(data.settlementCount, locale)} />
                <RevenueRow label="Collected revenue" value={formatCurrency(data.grossTotal)} />
                <RevenueRow label="Outstanding balance" value={formatCurrency(data.outstandingTotal)} />
              </TableBody>
            </Table>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment method</TableHead>
                  <TableHead className="text-end">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.methodBreakdown.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-4 text-center text-muted-foreground" colSpan={2}>
                      No payment method breakdown available.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.methodBreakdown.map((row) => (
                    <TableRow key={row.method}>
                      <TableCell className="font-medium">{humanizeKey(row.method)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(row.amount)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </ReportSectionShell>
  );
}

function RevenueRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-end tabular-nums">{value}</TableCell>
    </TableRow>
  );
}
