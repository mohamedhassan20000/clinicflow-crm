import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { DocumentTypeCode } from "@/lib/documents/catalog";

/**
 * P7-10 — the public verification page must name every issued document type. This
 * `Record<DocumentTypeCode, …>` is exhaustive by construction: adding a new
 * document code without a label here is a TypeScript compile error, so no type can
 * ever silently fall back to the generic "Document" label again (the P7-12 types
 * previously did). Values are keys into the `documentPlatform.verification`
 * message namespace (AR/EN parity enforced by `check-messages`).
 */
export const VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS: Record<DocumentTypeCode, string> = {
  REVENUE_REPORT: "revenueReport",
  FOLLOW_UP_PAGE_REPORT: "followUpPageReport",
  PATIENT_LIST_REPORT: "patientListReport",
  PATIENT_FILE: "patientFile",
  PRESCRIPTION: "prescription",
  SICK_LEAVE_CERTIFICATE: "sickLeaveCertificate",
  LAB_REQUEST: "labRequest",
  CANCELLATION_REPORT: "cancellationReport",
  NO_SHOW_REPORT: "noShowReport",
  SALES_REPORT: "salesReport",
  FOLLOW_UP_ANALYTICS_REPORT: "followUpAnalyticsReport",
  DOCTOR_PERFORMANCE_REPORT: "doctorPerformanceReport",
  RECEPTIONIST_PERFORMANCE_REPORT: "receptionistPerformanceReport",
  SYSTEM_MEMBERS_REPORT: "systemMembersReport",
  STAFF_FILE: "staffFile",
  INVOICE: "invoice",
  APPOINTMENT_HISTORY_REPORT: "appointmentHistoryReport",
  PACKAGE_HISTORY_REPORT: "packageHistoryReport",
  DEPOSIT_STATEMENT: "depositStatement",
  PATIENT_FINANCIAL_SUMMARY: "patientFinancialSummary",
  GENERIC_DOCUMENT: "genericDocument",
};

/**
 * Resolve a document type's public verification-label message key, falling back to
 * the generic "document" label for any value that is not a known type code (a
 * defensive guard for legacy or corrupt rows — the record above covers every
 * live type).
 */
export function verificationDocumentTypeLabelKey(documentType: string | null): string {
  // `Object.hasOwn` (not `in`) so inherited keys like `__proto__` cannot resolve to
  // a non-label value from the prototype chain.
  if (documentType && Object.hasOwn(VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS, documentType)) {
    return VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS[documentType as DocumentTypeCode];
  }
  return "document";
}

export type PublicDocumentVerification = {
  status: "valid" | "void" | "cancelled" | "unavailable";
  documentNumber: string | null;
  documentType: string | null;
  issueDate: string | null;
  clinicName: string | null;
};

const UNAVAILABLE: PublicDocumentVerification = {
  status: "unavailable",
  documentNumber: null,
  documentType: null,
  issueDate: null,
  clinicName: null,
};

export async function lookupPublicDocumentVerification(
  token: string,
): Promise<PublicDocumentVerification> {
  if (!/^[0-9a-f]{32}$/.test(token)) return UNAVAILABLE;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("verify_document_token", {
    p_token: token,
  });
  if (error || !data?.[0]) return UNAVAILABLE;
  const row = data[0];
  if (
    row.verification_status !== "valid"
    && row.verification_status !== "void"
    && row.verification_status !== "cancelled"
  ) return UNAVAILABLE;
  return {
    status: row.verification_status,
    documentNumber: row.document_number,
    documentType: row.document_type,
    issueDate: row.issue_date,
    clinicName: row.clinic_name,
  };
}
