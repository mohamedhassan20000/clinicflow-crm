import "server-only";

import { getTranslations } from "next-intl/server";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";

/**
 * P7-8 — resolves the display label for every registered document type from the
 * `documents.catalog` namespace with literal keys (so the i18n gate can prove
 * each is referenced). One source of truth for the module list, the create hub,
 * and the detail page.
 */
export async function getDocumentTypeLabels(): Promise<
  Record<RegisteredDocumentTypeCode, string>
> {
  const t = await getTranslations("documents.catalog");
  return {
    REVENUE_REPORT: t("revenueReport"),
    FOLLOW_UP_PAGE_REPORT: t("followUpPageReport"),
    CANCELLATION_REPORT: t("cancellationReport"),
    NO_SHOW_REPORT: t("noShowReport"),
    SALES_REPORT: t("salesReport"),
    FOLLOW_UP_ANALYTICS_REPORT: t("followUpAnalyticsReport"),
    DOCTOR_PERFORMANCE_REPORT: t("doctorPerformanceReport"),
    RECEPTIONIST_PERFORMANCE_REPORT: t("receptionistPerformanceReport"),
    PATIENT_LIST_REPORT: t("patientListReport"),
    PATIENT_FILE: t("patientFile"),
    PRESCRIPTION: t("prescription"),
    SICK_LEAVE_CERTIFICATE: t("sickLeaveCertificate"),
    LAB_REQUEST: t("labRequest"),
    SYSTEM_MEMBERS_REPORT: t("systemMembersReport"),
    STAFF_FILE: t("staffFile"),
    INVOICE: t("invoice"),
    APPOINTMENT_HISTORY_REPORT: t("appointmentHistoryReport"),
    PACKAGE_HISTORY_REPORT: t("packageHistoryReport"),
    DEPOSIT_STATEMENT: t("depositStatement"),
    PATIENT_FINANCIAL_SUMMARY: t("patientFinancialSummary"),
    GENERIC_DOCUMENT: t("genericDocument"),
  };
}
