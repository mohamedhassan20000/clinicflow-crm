import "server-only";

import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/i18n/config";
import type { P74AnalyticalDocumentCode } from "@/lib/documents/resolvers/analytical-report";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

export type AnalyticalReportCopy = {
  title: string;
  sectionTitle: string;
  description: string;
  notesTitle: string;
  notesBody: string;
  empty: string;
  labels: {
    documentNumber: string;
    issueDate: string;
    issueTime: string;
    period: string;
  };
  terms: Record<
    | "appointments" | "cancelled" | "cancellationRate" | "replaced"
    | "doctor" | "doctorPerformance" | "total" | "rate" | "replacementRate"
    | "topCancellationReasons" | "noReasons" | "auditTrail" | "dataAccuracy"
    | "verified" | "noShows" | "noShowRate" | "medicalDirectorReview"
    | "signatureDate" | "internalNotes" | "serviceTotal" | "primaryPayments"
    | "secondaryPayments" | "insurance" | "deposits" | "settlements"
    | "outstanding" | "collectedRevenue" | "transactions" | "settlementPayments"
    | "metric" | "value" | "paymentMethod" | "amount" | "grandTotal"
    | "completedFollowups" | "allFine" | "hasProblem" | "noResponse"
    | "outcome" | "count" | "share" | "doctors" | "sessions" | "completed"
    | "totalRevenue" | "patients" | "revenue" | "completionRate"
    | "cancellationShort" | "noShowShort" | "departmentRevenueShare"
    | "departmentImpact" | "clinicPatientContribution" | "clinicRevenueContribution"
    | "departmentRevenueContribution" | "receptionists" | "appointmentsBooked"
    | "appointmentShare" | "followupsHandled" | "followupShare"
    | "awaitingFollowup" | "completedFollowupDetails" | "recorded"
    | "patient" | "notes" | "status" | "dailyFollowup" | "finalReview",
    string
  >;
  outcomes: Record<"all_fine" | "has_problem" | "no_response", string>;
  paymentMethods: Record<string, string>;
  verificationTitle: string;
  verificationCaption: string;
  signatureLabel: string;
  signatureRole: string;
  footerAttribution: string;
  copyright: string;
  page: string;
  of: string;
};

export async function getAnalyticalReportCopy(
  locale: Locale,
  documentType: P74AnalyticalDocumentCode,
): Promise<AnalyticalReportCopy> {
  const t = await getTranslations({ locale, namespace: "documentPlatform.analytical" });
  const shared = getSharedDocumentSectionCopy(locale);
  const report = (() => {
    switch (documentType) {
      case "FOLLOW_UP_PAGE_REPORT":
        return {
          title: t("reports.followUpPage.title"),
          sectionTitle: t("reports.followUpPage.sectionTitle"),
          description: t("reports.followUpPage.description"),
          notesTitle: t("reports.followUpPage.notesTitle"),
          notesBody: t("reports.followUpPage.notesBody"),
          empty: t("reports.followUpPage.empty"),
        };
      case "CANCELLATION_REPORT":
        return {
          title: t("reports.cancellation.title"),
          sectionTitle: t("reports.cancellation.sectionTitle"),
          description: t("reports.cancellation.description"),
          notesTitle: t("reports.cancellation.notesTitle"),
          notesBody: t("reports.cancellation.notesBody"),
          empty: t("reports.cancellation.empty"),
        };
      case "NO_SHOW_REPORT":
        return {
          title: t("reports.noShow.title"),
          sectionTitle: t("reports.noShow.sectionTitle"),
          description: t("reports.noShow.description"),
          notesTitle: t("reports.noShow.notesTitle"),
          notesBody: t("reports.noShow.notesBody"),
          empty: t("reports.noShow.empty"),
        };
      case "SALES_REPORT":
        return {
          title: t("reports.sales.title"),
          sectionTitle: t("reports.sales.sectionTitle"),
          description: t("reports.sales.description"),
          notesTitle: t("reports.sales.notesTitle"),
          notesBody: t("reports.sales.notesBody"),
          empty: t("reports.sales.empty"),
        };
      case "FOLLOW_UP_ANALYTICS_REPORT":
        return {
          title: t("reports.followUpAnalytics.title"),
          sectionTitle: t("reports.followUpAnalytics.sectionTitle"),
          description: t("reports.followUpAnalytics.description"),
          notesTitle: t("reports.followUpAnalytics.notesTitle"),
          notesBody: t("reports.followUpAnalytics.notesBody"),
          empty: t("reports.followUpAnalytics.empty"),
        };
      case "DOCTOR_PERFORMANCE_REPORT":
        return {
          title: t("reports.doctorPerformance.title"),
          sectionTitle: t("reports.doctorPerformance.sectionTitle"),
          description: t("reports.doctorPerformance.description"),
          notesTitle: t("reports.doctorPerformance.notesTitle"),
          notesBody: t("reports.doctorPerformance.notesBody"),
          empty: t("reports.doctorPerformance.empty"),
        };
      case "RECEPTIONIST_PERFORMANCE_REPORT":
        return {
          title: t("reports.receptionistPerformance.title"),
          sectionTitle: t("reports.receptionistPerformance.sectionTitle"),
          description: t("reports.receptionistPerformance.description"),
          notesTitle: t("reports.receptionistPerformance.notesTitle"),
          notesBody: t("reports.receptionistPerformance.notesBody"),
          empty: t("reports.receptionistPerformance.empty"),
        };
    }
  })();

  return {
    ...report,
    labels: {
      documentNumber: t("labels.documentNumber"),
      issueDate: t("labels.issueDate"),
      issueTime: t("labels.issueTime"),
      period: t("labels.period"),
    },
    terms: {
      appointments: t("terms.appointments"),
      cancelled: t("terms.cancelled"),
      cancellationRate: t("terms.cancellationRate"),
      replaced: t("terms.replaced"),
      doctor: t("terms.doctor"),
      doctorPerformance: t("terms.doctorPerformance"),
      total: t("terms.total"),
      rate: t("terms.rate"),
      replacementRate: t("terms.replacementRate"),
      topCancellationReasons: t("terms.topCancellationReasons"),
      noReasons: t("terms.noReasons"),
      auditTrail: t("terms.auditTrail"),
      dataAccuracy: t("terms.dataAccuracy"),
      verified: t("terms.verified"),
      noShows: t("terms.noShows"),
      noShowRate: t("terms.noShowRate"),
      medicalDirectorReview: t("terms.medicalDirectorReview"),
      signatureDate: t("terms.signatureDate"),
      internalNotes: t("terms.internalNotes"),
      serviceTotal: t("terms.serviceTotal"),
      primaryPayments: t("terms.primaryPayments"),
      secondaryPayments: t("terms.secondaryPayments"),
      insurance: t("terms.insurance"),
      deposits: t("terms.deposits"),
      settlements: t("terms.settlements"),
      outstanding: t("terms.outstanding"),
      collectedRevenue: t("terms.collectedRevenue"),
      transactions: t("terms.transactions"),
      settlementPayments: t("terms.settlementPayments"),
      metric: t("terms.metric"),
      value: t("terms.value"),
      paymentMethod: t("terms.paymentMethod"),
      amount: t("terms.amount"),
      grandTotal: t("terms.grandTotal"),
      completedFollowups: t("terms.completedFollowups"),
      allFine: t("terms.allFine"),
      hasProblem: t("terms.hasProblem"),
      noResponse: t("terms.noResponse"),
      outcome: t("terms.outcome"),
      count: t("terms.count"),
      share: t("terms.share"),
      doctors: t("terms.doctors"),
      sessions: t("terms.sessions"),
      completed: t("terms.completed"),
      totalRevenue: t("terms.totalRevenue"),
      patients: t("terms.patients"),
      revenue: t("terms.revenue"),
      completionRate: t("terms.completionRate"),
      cancellationShort: t("terms.cancellationShort"),
      noShowShort: t("terms.noShowShort"),
      departmentRevenueShare: t("terms.departmentRevenueShare"),
      departmentImpact: t("terms.departmentImpact"),
      clinicPatientContribution: t("terms.clinicPatientContribution"),
      clinicRevenueContribution: t("terms.clinicRevenueContribution"),
      departmentRevenueContribution: t("terms.departmentRevenueContribution"),
      receptionists: t("terms.receptionists"),
      appointmentsBooked: t("terms.appointmentsBooked"),
      appointmentShare: t("terms.appointmentShare"),
      followupsHandled: t("terms.followupsHandled"),
      followupShare: t("terms.followupShare"),
      awaitingFollowup: t("terms.awaitingFollowup"),
      completedFollowupDetails: t("terms.completedFollowupDetails"),
      recorded: t("terms.recorded"),
      patient: t("terms.patient"),
      notes: t("terms.notes"),
      status: t("terms.status"),
      dailyFollowup: t("terms.dailyFollowup"),
      finalReview: t("terms.finalReview"),
    },
    outcomes: {
      all_fine: t("outcomes.allFine"),
      has_problem: t("outcomes.hasProblem"),
      no_response: t("outcomes.noResponse"),
    },
    paymentMethods: {
      cash: t("paymentMethods.cash"),
      card: t("paymentMethods.card"),
      credit_card: t("paymentMethods.card"),
      bank_transfer: t("paymentMethods.bankTransfer"),
      paypal: t("paymentMethods.paypal"),
      insurance: t("paymentMethods.insurance"),
      other: t("paymentMethods.other"),
    },
    verificationTitle: shared.verification.genericTitle,
    verificationCaption: shared.verification.genericCaption,
    signatureLabel: shared.signatures.authorized,
    signatureRole: shared.signatures.clinicAdministrator,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights,
    page: t("page"),
    of: t("of"),
  };
}
