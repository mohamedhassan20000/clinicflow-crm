import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";

/**
 * P7-8 — resolves the display label for every registered document type from the
 * `documents.catalog` namespace with literal keys (so the i18n gate can prove
 * each is referenced). One source of truth for the module list, the create hub,
 * and the detail page.
 *
 * The locale is resolved *before* the translator is bound, rather than choosing
 * between two `getTranslations` forms in a ternary initializer. That keeps the
 * binding a single literal `const t = await getTranslations({ locale, namespace:
 * "documents.catalog" })`, which is the shape `scripts/check-messages.mjs`
 * recognises — so the 21 literal-key lookups below stay provable by the
 * unused-key gate instead of silently falling out of it (final review B-1).
 * Omitting the argument resolves the request locale, which is exactly what
 * `getLocale()` returns, so rendered EN/AR output is unchanged.
 *
 * Note for future editors: the checker's call scan is lexical and does not skip
 * comments, so never write an illustrative translator call with a placeholder
 * key in this file — it would be recorded as a reference to a key that does not
 * exist and turn the `missing` half of the same gate red.
 */
async function documentTypeLabels(
  locale?: "ar" | "en",
): Promise<Record<RegisteredDocumentTypeCode, string>> {
  const resolvedLocale = locale ?? (await getLocale());
  const t = await getTranslations({
    locale: resolvedLocale,
    namespace: "documents.catalog",
  });
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

export async function getDocumentTypeLabels(): Promise<
  Record<RegisteredDocumentTypeCode, string>
> {
  return documentTypeLabels();
}

/**
 * P6-09 — one type's label in an explicitly chosen language. The Assistant's
 * confirmation card must never render a raw `documents.catalog.*` key, and the
 * language it resolves in is the conversation's, not the request's.
 */
export async function getDocumentTypeLabel(
  code: RegisteredDocumentTypeCode,
  locale: "ar" | "en",
): Promise<string> {
  return (await documentTypeLabels(locale))[code];
}
