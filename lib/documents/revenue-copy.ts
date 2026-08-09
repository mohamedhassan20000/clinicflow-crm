import "server-only";

import { getTranslations } from "next-intl/server";
import type { RevenueReportCopy } from "@/components/documents/templates/revenue-report";
import type { Locale } from "@/lib/i18n/config";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

export async function getRevenueReportCopy(locale: Locale): Promise<RevenueReportCopy> {
  const t = await getTranslations({ locale, namespace: "documentPlatform.revenue" });
  const shared = getSharedDocumentSectionCopy(locale);
  return {
    title: t("title"),
    labels: {
      documentNumber: t("labels.documentNumber"),
      issueDate: t("labels.issueDate"),
      issueTime: t("labels.issueTime"),
      period: t("labels.period"),
    },
    stats: {
      totalRevenue: t("stats.totalRevenue"),
      primary: t("stats.primary"),
      secondary: t("stats.secondary"),
      insurance: t("stats.insurance"),
      deposit: t("stats.deposit"),
      settlements: t("stats.settlements"),
      sessionsAndDeposits: t("stats.sessionsAndDeposits"),
    },
    sectionTitle: t("sectionTitle"),
    columns: {
      paidAt: t("columns.paidAt"),
      patient: t("columns.patient"),
      doctorDepartment: t("columns.doctorDepartment"),
      total: t("columns.total"),
      primary: t("columns.primary"),
      secondary: t("columns.secondary"),
      insurance: t("columns.insurance"),
      deposit: t("columns.deposit"),
      outstanding: t("columns.outstanding"),
    },
    emptyTransactions: t("emptyTransactions"),
    totals: {
      patientCollected: t("totals.patientCollected"),
      grossAllocated: t("totals.grossAllocated"),
      outstanding: t("totals.outstanding"),
    },
    reportContext: t("reportContext"),
    scope: t("scope"),
    consolidatedScope: t("consolidatedScope"),
    filteredScope: t("filteredScope"),
    accountingBasis: t("accountingBasis"),
    accrualPaidAtDate: t("accrualPaidAtDate"),
    currency: t("currency"),
    legalNote: t("legalNote"),
    verificationTitle: shared.verification.recordTitle,
    verificationCaption: shared.verification.genericCaption,
    accountingApproval: shared.signatures.accountingApproval,
    clinicStamp: shared.stamps.clinic,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights,
    page: t("page"),
    of: t("of"),
    paymentMethods: {
      cash: t("paymentMethods.cash"),
      card: t("paymentMethods.card"),
      bank_transfer: t("paymentMethods.bankTransfer"),
      insurance: t("paymentMethods.insurance"),
      other: t("paymentMethods.other"),
    },
  };
}
