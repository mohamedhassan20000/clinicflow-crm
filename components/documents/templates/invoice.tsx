import {
  DocumentPage,
  type DocumentLifecycle,
  type DocumentRenderContextBoundary,
} from "@/components/documents/engine";
import {
  DataTable,
  FieldGrid,
  IdentityHero,
  NotesCallout,
  SignatureBlock,
  StatusBadge,
  TotalsSummary,
  VerificationBlock,
  type DocumentTableColumn,
  type DocumentTableRow,
  type StatusBadgeTone,
} from "@/components/documents/primitives";
import {
  formatDocDate,
  formatDocIdentifier,
  formatDocMoney,
  formatDocNumber,
  formatDocTime,
} from "@/lib/documents/format";
import type {
  InvoiceDocumentSnapshot,
  InvoiceStatus,
} from "@/lib/documents/resolvers/invoice";
import type { Locale } from "@/lib/i18n/config";

export type InvoiceCopy = {
  title: string;
  labels: {
    documentNumber: string;
    issueDate: string;
    issueTime: string;
  };
  billTo: string;
  patientId: string;
  status: string;
  statuses: Record<InvoiceStatus, string>;
  cards: {
    invoiceTotal: string;
    insuranceCoverage: string;
    amountDue: string;
  };
  columns: {
    service: string;
    reference: string;
    unitPrice: string;
    quantity: string;
    total: string;
  };
  emptyLineItems: string;
  billingNotes: string;
  summary: {
    subtotal: string;
    insuranceShare: string;
    paymentBreakdown: string;
    totalPaid: string;
    outstandingBalance: string;
  };
  paymentMethods: Record<string, string>;
  verificationTitle: string;
  verificationCaption: string;
  taxInvoiceNote: string;
  authorizedSignature: string;
  patientSignature: string;
  clinicStamp: string;
  footerAttribution: string;
  copyright: string;
  page: string;
  of: string;
};

export type InvoiceDocumentProps = {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: InvoiceDocumentSnapshot;
  copy: InvoiceCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
};

const STATUS_TONE: Record<InvoiceStatus, StatusBadgeTone> = {
  paid: "success",
  partially_paid: "warning",
  unpaid: "danger",
};

export function InvoiceDocument({
  locale,
  lifecycle,
  snapshot,
  copy,
  documentNumber,
  qrDataUrl,
  renderContextBoundary,
}: InvoiceDocumentProps) {
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
  const plainMoney = (value: number) => formatDocNumber(value, formatLocale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const columns: readonly DocumentTableColumn[] = [
    { key: "service", label: copy.columns.service, width: "46%" },
    { key: "unitPrice", label: copy.columns.unitPrice, width: "22%", align: "end", direction: "ltr" },
    { key: "quantity", label: copy.columns.quantity, width: "10%", align: "end", direction: "ltr" },
    { key: "total", label: copy.columns.total, width: "22%", align: "end", direction: "ltr" },
  ];
  const rows: readonly DocumentTableRow[] = snapshot.lineItems.map((item) => ({
    id: item.id,
    cells: {
      service: (
        <>
          {item.name}
          {item.reference && (
            <>
              <br />
              {/* i18n-allow: document CSS class tokens, not user-facing copy */}
              <small className="cf-doc-ltr">
                {copy.columns.reference}: {formatDocIdentifier(item.reference)}
              </small>
            </>
          )}
        </>
      ),
      unitPrice: plainMoney(item.unitPrice),
      quantity: formatDocNumber(item.quantity, formatLocale),
      total: money(item.lineTotal),
    },
  }));

  const paymentItems = snapshot.payments.map((entry) => ({
    label: copy.paymentMethods[entry.method] ?? copy.paymentMethods.other,
    value: money(entry.amount),
  }));

  const summaryItems = [
    { label: copy.summary.subtotal, value: money(snapshot.totals.subtotal) },
    ...(snapshot.totals.insuranceCoverage > 0.001
      ? [{
        label: copy.summary.insuranceShare,
        value: `- ${money(snapshot.totals.insuranceCoverage)}`,
      }]
      : []),
    { label: copy.summary.totalPaid, value: money(snapshot.totals.paidTotal) },
    ...paymentItems,
    {
      label: copy.summary.outstandingBalance,
      value: money(snapshot.totals.outstanding),
      direction: "ltr" as const,
    },
  ];

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
        labels: copy.labels,
      }}
      watermark={{
        enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
        text: snapshot.settings.watermark,
      }}
      footer={{
        attribution: snapshot.branding.footerText || copy.footerAttribution,
        copyright: copy.copyright,
      }}
      pageLabels={{ page: copy.page, of: copy.of }}
      renderContextBoundary={renderContextBoundary}
    >
      <IdentityHero
        name={snapshot.patient.fullName}
        initials={snapshot.patient.fullName.slice(0, 1).toUpperCase()}
        detail={(
          <>
            {/* i18n-allow: document CSS class tokens, not user-facing copy */}
            <span className="cf-doc-label">{copy.billTo}</span>
            {snapshot.patient.fileNumber && (
              <div>
                {copy.patientId}: <bdi className="cf-doc-ltr">{formatDocIdentifier(snapshot.patient.fileNumber)}</bdi>
              </div>
            )}
            {snapshot.patient.departmentName && <div>{snapshot.patient.departmentName}</div>}
          </>
        )}
        status={<StatusBadge label={copy.statuses[snapshot.status]} tone={STATUS_TONE[snapshot.status]} />}
      />

      <TotalsSummary items={[
        { label: copy.cards.invoiceTotal, value: money(snapshot.totals.subtotal) },
        { label: copy.cards.insuranceCoverage, value: money(snapshot.totals.insuranceCoverage) },
        { label: copy.cards.amountDue, value: money(snapshot.totals.amountDue), emphasis: "strong" },
      ]} />

      <DataTable
        columns={columns}
        rows={rows}
        emptyLabel={copy.emptyLineItems}
      />

      {snapshot.billingNotes && (
        <NotesCallout label={copy.billingNotes}>
          <p>{snapshot.billingNotes}</p>
        </NotesCallout>
      )}

      <FieldGrid
        columns={2}
        items={summaryItems.map((item) => ({
          label: item.label,
          value: item.value,
          direction: "direction" in item ? item.direction : "ltr",
        }))}
      />

      {snapshot.branding.taxId && (
        <NotesCallout label={copy.title} tone="neutral">
          <p>
            {copy.taxInvoiceNote} <bdi className="cf-doc-ltr">{formatDocIdentifier(snapshot.branding.taxId)}</bdi>
          </p>
        </NotesCallout>
      )}

      {lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl && (
        <VerificationBlock
          qrDataUrl={qrDataUrl}
          title={copy.verificationTitle}
          caption={copy.verificationCaption}
        />
      )}

      <SignatureBlock signatures={[
        { id: "authorized-signature", label: copy.authorizedSignature },
        { id: "patient-signature", label: copy.patientSignature },
      ]} stampLabel={copy.clinicStamp} />
    </DocumentPage>
  );
}
