"use client";

import type { ClinicPrintMeta, ReportDateRange, RevenueSummaryReportResponse } from "@/types/reports";
import { EmptyReportState, MetricGrid, ReportSectionShell } from "@/components/reports/report-section-shell";
import {
  formatCurrency,
  formatDateRangeLabel,
  formatNumber,
  humanizeKey,
} from "@/components/reports/report-formatters";

export function RevenueSummaryReport({
  data,
  range,
  clinic,
}: {
  data: RevenueSummaryReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
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
      rangeLabel={formatDateRangeLabel(range.from, range.to)}
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
          <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                <RevenueRow label="Transactions" value={formatNumber(data.transactionCount)} />
                <RevenueRow label="Settlement payments" value={formatNumber(data.settlementCount)} />
                <RevenueRow label="Collected revenue" value={formatCurrency(data.grossTotal)} />
                <RevenueRow label="Outstanding balance" value={formatCurrency(data.outstandingTotal)} />
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Payment method</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.methodBreakdown.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-center text-muted-foreground" colSpan={2}>
                      No payment method breakdown available.
                    </td>
                  </tr>
                ) : (
                  data.methodBreakdown.map((row) => (
                    <tr key={row.method} className="border-t border-border/50">
                      <td className="px-3 py-2 font-medium">{humanizeKey(row.method)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(row.amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ReportSectionShell>
  );
}

function RevenueRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-t border-border/50">
      <td className="px-3 py-2 font-medium">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">{value}</td>
    </tr>
  );
}
