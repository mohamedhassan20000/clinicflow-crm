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
import { useTranslations } from "next-intl";

export function RevenueSummaryReport({
  data,
  range,
  clinic,
}: {
  data: RevenueSummaryReportResponse;
  range: ReportDateRange;
  clinic: ClinicPrintMeta;
}) {
  const t = useTranslations("reports");
  const { locale, formatCurrency } = useClinicSettings();
  const hasData =
    data.transactionCount > 0 ||
    data.settlementCount > 0 ||
    data.grossTotal > 0 ||
    data.methodBreakdown.length > 0;

  return (
    <ReportSectionShell
      section="revenue"
      title={t("revenueSalesSummary")}
      description={t("collectedPaymentsDepositsSettlementsAndOutstanding")}
      rangeLabel={formatDateRangeLabel(range.from, range.to, locale)}
      clinic={clinic}
    >
      <MetricGrid
        mobileColumns={2}
        items={[
          { label: t("grossTotal"), value: formatCurrency(data.grossTotal) },
          { label: t("serviceTotal"), value: formatCurrency(data.totalAmount) },
          { label: t("primaryPayments"), value: formatCurrency(data.primaryTotal) },
          { label: t("secondaryPayments"), value: formatCurrency(data.secondaryTotal) },
          { label: t("insurance"), value: formatCurrency(data.insuranceTotal) },
          { label: t("deposits"), value: formatCurrency(data.depositTotal) },
          { label: t("settlements"), value: formatCurrency(data.settlementsTotal) },
          { label: t("outstanding"), value: formatCurrency(data.outstandingTotal) },
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
                  <TableHead>{t("metric")}</TableHead>
                  <TableHead className="text-end">{t("value")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <RevenueRow label={t("transactions")} value={formatNumber(data.transactionCount, locale)} />
                <RevenueRow label={t("settlementPayments")} value={formatNumber(data.settlementCount, locale)} />
                <RevenueRow label={t("collectedRevenue")} value={formatCurrency(data.grossTotal)} />
                <RevenueRow label={t("outstandingBalance")} value={formatCurrency(data.outstandingTotal)} />
              </TableBody>
            </Table>
          </div>

          <div className="overflow-hidden rounded-lg border border-border/50 print:overflow-visible print:border-black">
            <Table dense>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("paymentMethod")}</TableHead>
                  <TableHead className="text-end">{t("amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.methodBreakdown.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-4 text-center text-muted-foreground" colSpan={2}>
                      {t("noPaymentMethodBreakdownAvailable")}</TableCell>
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
