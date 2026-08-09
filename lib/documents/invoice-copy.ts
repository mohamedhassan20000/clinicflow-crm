import "server-only";

import { getTranslations } from "next-intl/server";
import type { InvoiceCopy } from "@/components/documents/templates/invoice";
import type { Locale } from "@/lib/i18n/config";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

export async function getInvoiceCopy(locale: Locale): Promise<InvoiceCopy> {
  const t = await getTranslations({ locale, namespace: "documentPlatform.invoice" });
  const shared = getSharedDocumentSectionCopy(locale);
  return {
    title: t("title"),
    labels: {
      documentNumber: t("labels.documentNumber"),
      issueDate: t("labels.issueDate"),
      issueTime: t("labels.issueTime"),
    },
    billTo: t("billTo"),
    patientId: t("patientId"),
    status: t("status"),
    statuses: {
      paid: t("statuses.paid"),
      partially_paid: t("statuses.partiallyPaid"),
      unpaid: t("statuses.unpaid"),
    },
    cards: {
      invoiceTotal: t("cards.invoiceTotal"),
      insuranceCoverage: t("cards.insuranceCoverage"),
      amountDue: t("cards.amountDue"),
    },
    columns: {
      service: t("columns.service"),
      reference: t("columns.reference"),
      unitPrice: t("columns.unitPrice"),
      quantity: t("columns.quantity"),
      total: t("columns.total"),
    },
    emptyLineItems: t("emptyLineItems"),
    billingNotes: t("billingNotes"),
    summary: {
      subtotal: t("summary.subtotal"),
      insuranceShare: t("summary.insuranceShare"),
      paymentBreakdown: t("summary.paymentBreakdown"),
      totalPaid: t("summary.totalPaid"),
      outstandingBalance: t("summary.outstandingBalance"),
    },
    paymentMethods: {
      cash: t("paymentMethods.cash"),
      credit_card: t("paymentMethods.creditCard"),
      paypal: t("paymentMethods.paypal"),
      bank_transfer: t("paymentMethods.bankTransfer"),
      insurance: t("paymentMethods.insurance"),
      other: t("paymentMethods.other"),
    },
    verificationTitle: shared.verification.recordTitle,
    verificationCaption: shared.verification.financialCaption,
    taxInvoiceNote: t("taxInvoiceNote"),
    authorizedSignature: shared.signatures.authorized,
    patientSignature: shared.signatures.patient,
    clinicStamp: shared.stamps.clinic,
    footerAttribution: shared.footer.confidentialFinancial,
    copyright: shared.footer.generatedBy,
    page: t("page"),
    of: t("of"),
  };
}
