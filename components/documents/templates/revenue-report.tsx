import {
  DocumentPage,
  type DocumentLifecycle,
  type DocumentRenderContextBoundary,
} from "@/components/documents/engine";
import {
  DataTable,
  NotesCallout,
  SectionHeader,
  SignatureBlock,
  StatCardRow,
  TotalsSummary,
  VerificationBlock,
  type DocumentTableColumn,
  type DocumentTableRow,
} from "@/components/documents/primitives";
import {
  formatDocDate,
  formatDocMoney,
  formatDocNumber,
  formatDocTime,
} from "@/lib/documents/format";
import type { RevenueDocumentSnapshot } from "@/lib/documents/resolvers/revenue-report";
import type { Locale } from "@/lib/i18n/config";

export type RevenueReportCopy = {
  title: string;
  labels: {
    documentNumber: string;
    issueDate: string;
    issueTime: string;
    period: string;
  };
  stats: {
    totalRevenue: string;
    primary: string;
    secondary: string;
    insurance: string;
    deposit: string;
    settlements: string;
    sessionsAndDeposits: string;
  };
  sectionTitle: string;
  columns: {
    paidAt: string;
    patient: string;
    doctorDepartment: string;
    total: string;
    primary: string;
    secondary: string;
    insurance: string;
    deposit: string;
    outstanding: string;
  };
  emptyTransactions: string;
  totals: {
    patientCollected: string;
    grossAllocated: string;
    outstanding: string;
  };
  reportContext: string;
  scope: string;
  consolidatedScope: string;
  filteredScope: string;
  accountingBasis: string;
  accrualPaidAtDate: string;
  currency: string;
  legalNote: string;
  verificationTitle: string;
  verificationCaption: string;
  accountingApproval: string;
  clinicStamp: string;
  footerAttribution: string;
  copyright: string;
  page: string;
  of: string;
  paymentMethods: Record<string, string>;
};

export type RevenueReportDocumentProps = {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: RevenueDocumentSnapshot;
  copy: RevenueReportCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  pageCount?: number;
  renderContextBoundary?: DocumentRenderContextBoundary;
};

export function RevenueReportDocument({
  locale,
  lifecycle,
  snapshot,
  copy,
  documentNumber,
  qrDataUrl,
  pageCount,
  renderContextBoundary,
}: RevenueReportDocumentProps) {
  const formatLocale = {
    locale,
    timeZone: snapshot.format.timeZone,
    currency: snapshot.format.currency,
    timeFormat: snapshot.format.timeFormat,
  };
  const money = (value: number) => formatDocMoney(value, formatLocale, {
    currencyDisplay: "code",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const period = [snapshot.range.start, snapshot.range.end]
    .map((value) => formatDocDate(value, formatLocale, { dateStyle: "medium" }))
    .join(" — ");

  const columns: readonly DocumentTableColumn[] = [
    { key: "paidAt", label: copy.columns.paidAt, width: "11%", direction: "ltr" },
    { key: "patient", label: copy.columns.patient, width: "16%" },
    { key: "doctor", label: copy.columns.doctorDepartment, width: "14%" },
    { key: "total", label: copy.columns.total, width: "11%", align: "end", direction: "ltr" },
    { key: "primary", label: copy.columns.primary, width: "10%", align: "end", direction: "ltr" },
    { key: "secondary", label: copy.columns.secondary, width: "10%", align: "end", direction: "ltr" },
    { key: "insurance", label: copy.columns.insurance, width: "10%", align: "end", direction: "ltr" },
    { key: "deposit", label: copy.columns.deposit, width: "9%", align: "end", direction: "ltr" },
    { key: "outstanding", label: copy.columns.outstanding, width: "9%", align: "end", direction: "ltr" },
  ];
  const rows: readonly DocumentTableRow[] = snapshot.transactions.map((row) => ({
    id: row.id,
    cells: {
      paidAt: (
        <>
          {formatDocDate(row.paidAt, formatLocale, { dateStyle: "medium" })}
          <br />
          {formatDocTime(row.paidAt, formatLocale)}
        </>
      ),
      patient: row.patientName,
      doctor: (
        <>
          {row.doctorName}
          {row.departmentName && <><br /><small>{row.departmentName}</small></>}
        </>
      ),
      total: money(row.totalAmount),
      primary: money(row.primaryAmount),
      secondary: money(row.secondaryAmount),
      insurance: money(row.insuranceAmount),
      deposit: money(row.depositAmount),
      outstanding: money(row.outstandingAmount),
    },
  }));
  const methodItems = snapshot.summary.methodBreakdown.length > 0
    ? snapshot.summary.methodBreakdown.map((row) => ({
      label: copy.paymentMethods[row.method] ?? copy.paymentMethods.other,
      value: money(row.amount),
    }))
    : [
      { label: copy.totals.patientCollected, value: money(snapshot.summary.patientCollectedTotal) },
      { label: copy.totals.outstanding, value: money(snapshot.summary.outstandingTotal) },
    ];
  const hasFilters = Boolean(snapshot.filters.doctorId || snapshot.filters.departmentId);
  const verification = lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl ? (
    <VerificationBlock
      qrDataUrl={qrDataUrl}
      title={copy.verificationTitle}
      caption={copy.verificationCaption}
    />
  ) : null;

  return (
    <DocumentPage
      locale={locale}
      lifecycle={lifecycle}
      branding={snapshot.branding}
      identity={{
        title: copy.title,
        documentNumber: lifecycle !== "preview" ? documentNumber : null,
        issueDate: formatDocDate(snapshot.generatedAt, formatLocale, { dateStyle: "medium" }),
        issueTime: formatDocTime(snapshot.generatedAt, formatLocale),
        period,
        labels: copy.labels,
      }}
      watermark={{
        enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
        text: snapshot.settings.watermark,
      }}
      footer={{
        verificationSlot: verification,
        attribution: snapshot.branding.footerText || copy.footerAttribution,
        copyright: copy.copyright,
      }}
      pageNumber={pageCount ? 1 : undefined}
      pageCount={pageCount}
      pageLabels={{ page: copy.page, of: copy.of }}
      renderContextBoundary={renderContextBoundary}
    >
      <StatCardRow items={[
        {
          label: copy.stats.totalRevenue,
          value: money(snapshot.summary.grossTotal),
          detail: copy.stats.sessionsAndDeposits,
        },
        { label: copy.stats.primary, value: money(snapshot.summary.primaryTotal) },
        { label: copy.stats.secondary, value: money(snapshot.summary.secondaryTotal) },
        { label: copy.stats.insurance, value: money(snapshot.summary.insuranceTotal) },
        { label: copy.stats.deposit, value: money(snapshot.summary.depositTotal) },
        { label: copy.stats.settlements, value: money(snapshot.summary.settlementsTotal) },
      ]} />

      <SectionHeader title={copy.sectionTitle} />

      <DataTable
        columns={columns}
        rows={rows}
        emptyLabel={copy.emptyTransactions}
        totals={{
          patient: copy.totals.grossAllocated,
          total: money(snapshot.summary.grossTotal),
          primary: money(snapshot.summary.primaryTotal),
          secondary: money(snapshot.summary.secondaryTotal),
          insurance: money(snapshot.summary.insuranceTotal),
          deposit: money(snapshot.summary.depositTotal),
          outstanding: money(snapshot.summary.outstandingTotal),
        }}
      />

      <TotalsSummary items={methodItems} />

      <NotesCallout label={copy.reportContext}>
        <p><strong>{copy.scope}:</strong> {hasFilters ? copy.filteredScope : copy.consolidatedScope}</p>
        <p><strong>{copy.accountingBasis}:</strong> {copy.accrualPaidAtDate}</p>
        <p><strong>{copy.currency}:</strong> {snapshot.format.currency}</p>
        <p>{copy.legalNote}</p>
        <p>{formatDocNumber(snapshot.summary.transactionCount, formatLocale)} · {formatDocNumber(snapshot.summary.settlementCount, formatLocale)}</p>
      </NotesCallout>

      <SignatureBlock signatures={[
        { id: "accounting-approval", label: copy.accountingApproval },
      ]} stampLabel={copy.clinicStamp} />
    </DocumentPage>
  );
}
