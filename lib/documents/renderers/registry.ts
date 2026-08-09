import "server-only";

import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";
import type { DocumentIssueRenderer } from "@/lib/documents/issuance";
import { renderIssuedAnalyticalReportPdf } from "@/lib/documents/renderers/analytical-report";
import { renderIssuedClinicalDocumentPdf } from "@/lib/documents/renderers/clinical-document";
import { renderIssuedGenericDocumentPdf } from "@/lib/documents/renderers/generic-document";
import { renderIssuedInvoicePdf } from "@/lib/documents/renderers/invoice";
import { renderIssuedPatientHistoryPdf } from "@/lib/documents/renderers/patient-history";
import { renderIssuedRevenueReportPdf } from "@/lib/documents/renderers/revenue-report";
import { renderIssuedRosterProfilePdf } from "@/lib/documents/renderers/roster-profile";

/**
 * Catalog-complete PDF dispatch. Every registered type must resolve through
 * this map, so adding a catalog entry without a server-safe issued renderer is
 * a TypeScript error instead of a production-only issuance failure.
 */
export const DOCUMENT_PDF_RENDERERS = {
  REVENUE_REPORT: renderIssuedRevenueReportPdf,
  FOLLOW_UP_PAGE_REPORT: renderIssuedAnalyticalReportPdf,
  PATIENT_LIST_REPORT: renderIssuedRosterProfilePdf,
  PATIENT_FILE: renderIssuedRosterProfilePdf,
  PRESCRIPTION: renderIssuedClinicalDocumentPdf,
  SICK_LEAVE_CERTIFICATE: renderIssuedClinicalDocumentPdf,
  LAB_REQUEST: renderIssuedClinicalDocumentPdf,
  CANCELLATION_REPORT: renderIssuedAnalyticalReportPdf,
  NO_SHOW_REPORT: renderIssuedAnalyticalReportPdf,
  SALES_REPORT: renderIssuedAnalyticalReportPdf,
  FOLLOW_UP_ANALYTICS_REPORT: renderIssuedAnalyticalReportPdf,
  DOCTOR_PERFORMANCE_REPORT: renderIssuedAnalyticalReportPdf,
  RECEPTIONIST_PERFORMANCE_REPORT: renderIssuedAnalyticalReportPdf,
  SYSTEM_MEMBERS_REPORT: renderIssuedRosterProfilePdf,
  STAFF_FILE: renderIssuedRosterProfilePdf,
  INVOICE: renderIssuedInvoicePdf,
  APPOINTMENT_HISTORY_REPORT: renderIssuedPatientHistoryPdf,
  PACKAGE_HISTORY_REPORT: renderIssuedPatientHistoryPdf,
  DEPOSIT_STATEMENT: renderIssuedPatientHistoryPdf,
  PATIENT_FINANCIAL_SUMMARY: renderIssuedPatientHistoryPdf,
  GENERIC_DOCUMENT: renderIssuedGenericDocumentPdf,
} as const satisfies Record<RegisteredDocumentTypeCode, DocumentIssueRenderer>;

export function getDocumentPdfRenderer(
  documentType: RegisteredDocumentTypeCode,
): DocumentIssueRenderer {
  return DOCUMENT_PDF_RENDERERS[documentType];
}
