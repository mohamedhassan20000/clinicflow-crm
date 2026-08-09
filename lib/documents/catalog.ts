import type { PermissionUserRole } from "@/lib/page-permissions";

export const DOCUMENT_TYPE_CODES = [
  "REVENUE_REPORT",
  "FOLLOW_UP_PAGE_REPORT",
  "PATIENT_LIST_REPORT",
  "PATIENT_FILE",
  "PRESCRIPTION",
  "SICK_LEAVE_CERTIFICATE",
  "LAB_REQUEST",
  "CANCELLATION_REPORT",
  "NO_SHOW_REPORT",
  "SALES_REPORT",
  "FOLLOW_UP_ANALYTICS_REPORT",
  "DOCTOR_PERFORMANCE_REPORT",
  "RECEPTIONIST_PERFORMANCE_REPORT",
  "SYSTEM_MEMBERS_REPORT",
  "STAFF_FILE",
  "INVOICE",
  // P7-12 — patient history & financial document types (doc 16 §9).
  "APPOINTMENT_HISTORY_REPORT",
  "PACKAGE_HISTORY_REPORT",
  "DEPOSIT_STATEMENT",
  "PATIENT_FINANCIAL_SUMMARY",
  // P7 Phase 4 — the single approved generic free-form ("from scratch") type.
  "GENERIC_DOCUMENT",
] as const;

export type DocumentTypeCode = (typeof DOCUMENT_TYPE_CODES)[number];
export type DocumentArchetype =
  | "analytical"
  | "roster"
  | "profile"
  | "clinical"
  | "financial"
  | "history"
  | "generic";
export type DocumentSubject =
  | "clinic"
  | "patient"
  | "staff"
  | "doctor"
  | "appointment";
export type DocumentFilterKey =
  | "date"
  | "dateRange"
  | "patient"
  | "employee"
  | "doctor"
  | "department"
  | "creator"
  | "documentNumber"
  | "status"
  | "search";
export type VerificationField =
  | "status"
  | "documentNumber"
  | "documentType"
  | "issueDate"
  | "clinicName";

export type DocumentResolverRef =
  | { kind: "report"; reportId: string }
  | { kind: "document"; resolverId: string };

export type DocumentCatalogEntry = {
  code: DocumentTypeCode;
  archetype: DocumentArchetype;
  titleKey: string;
  numbering: {
    prefix: string;
    yearlyReset: boolean;
    sequencePadding: number;
  };
  pageRoles: readonly PermissionUserRole[];
  subject: DocumentSubject;
  filterSchema: readonly DocumentFilterKey[];
  resolver: DocumentResolverRef;
  template: string;
  verificationDisclosure: readonly VerificationField[];
  supportsAttachments?: boolean;
  /**
   * P7-8 — whether the Central Document Factory may prepare this document for a
   * non-registered person via external-subject snapshot fields (no `patient_id`).
   * Default (absent) is `false`; doc 14 open decision #4 must confirm any type
   * before it is flipped on. Kept conservative here so no type widens silently.
   */
  allowsExternalSubject?: boolean;
  issuanceTrigger: { href: string; contextual: boolean };
};

export const SAFE_VERIFICATION_DISCLOSURE = [
  "status",
  "documentNumber",
  "documentType",
  "issueDate",
  "clinicName",
] as const satisfies readonly VerificationField[];

const OPERATIONAL_ROLES = [
  "admin",
  "manager",
  "receptionist",
] as const satisfies readonly PermissionUserRole[];

const SCOPED_OPERATIONAL_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const satisfies readonly PermissionUserRole[];

const PERFORMANCE_ROLES = [
  "admin",
  "manager",
] as const satisfies readonly PermissionUserRole[];

/**
 * P7-0 intentionally registers only the next vertical slice and the tax-
 * branding reference. Later archetype phases add the remaining entries.
 */
export const DOCUMENT_CATALOG = {
  REVENUE_REPORT: {
    code: "REVENUE_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.revenueReport",
    numbering: { prefix: "REV", yearlyReset: true, sequencePadding: 4 },
    pageRoles: OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "doctor", "department", "creator"],
    resolver: { kind: "report", reportId: "revenue" },
    template: "RevenueReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/revenue", contextual: true },
  },
  FOLLOW_UP_PAGE_REPORT: {
    code: "FOLLOW_UP_PAGE_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.followUpPageReport",
    numbering: { prefix: "FU", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "doctor", "creator"],
    resolver: { kind: "report", reportId: "followups" },
    template: "FollowUpPageReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/follow-ups", contextual: true },
  },
  CANCELLATION_REPORT: {
    code: "CANCELLATION_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.cancellationReport",
    numbering: { prefix: "CR", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "doctor", "creator"],
    resolver: { kind: "report", reportId: "cancellations" },
    template: "CancellationReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/cancellations", contextual: true },
  },
  NO_SHOW_REPORT: {
    code: "NO_SHOW_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.noShowReport",
    numbering: { prefix: "NS", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "doctor", "creator"],
    resolver: { kind: "report", reportId: "no_shows" },
    template: "NoShowReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/no-shows", contextual: true },
  },
  SALES_REPORT: {
    code: "SALES_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.salesReport",
    numbering: { prefix: "SAL", yearlyReset: true, sequencePadding: 4 },
    pageRoles: OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "creator"],
    resolver: { kind: "document", resolverId: "sales-report" },
    template: "SalesReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/sales/document", contextual: true },
  },
  FOLLOW_UP_ANALYTICS_REPORT: {
    code: "FOLLOW_UP_ANALYTICS_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.followUpAnalyticsReport",
    numbering: { prefix: "FUA", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: ["dateRange", "doctor", "creator"],
    resolver: { kind: "document", resolverId: "follow-up-analytics-report" },
    template: "FollowUpAnalyticsReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/follow-up-analytics/document", contextual: true },
  },
  DOCTOR_PERFORMANCE_REPORT: {
    code: "DOCTOR_PERFORMANCE_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.doctorPerformanceReport",
    numbering: { prefix: "DPF", yearlyReset: true, sequencePadding: 4 },
    pageRoles: PERFORMANCE_ROLES,
    subject: "doctor",
    filterSchema: ["dateRange", "doctor", "department", "creator"],
    resolver: { kind: "report", reportId: "doctor_performance" },
    template: "DoctorPerformanceReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/doctors", contextual: true },
  },
  RECEPTIONIST_PERFORMANCE_REPORT: {
    code: "RECEPTIONIST_PERFORMANCE_REPORT",
    archetype: "analytical",
    titleKey: "documents.catalog.receptionistPerformanceReport",
    numbering: { prefix: "RPF", yearlyReset: true, sequencePadding: 4 },
    pageRoles: PERFORMANCE_ROLES,
    subject: "staff",
    filterSchema: ["dateRange", "employee", "creator"],
    resolver: { kind: "report", reportId: "receptionist_performance" },
    template: "ReceptionistPerformanceReportTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/reports/receptionists", contextual: true },
  },
  PATIENT_LIST_REPORT: {
    code: "PATIENT_LIST_REPORT",
    archetype: "roster",
    titleKey: "documents.catalog.patientListReport",
    numbering: { prefix: "PL", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "doctor", "department", "search"],
    resolver: { kind: "document", resolverId: "patient-list-report" },
    template: "PatientListDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  PATIENT_FILE: {
    code: "PATIENT_FILE",
    archetype: "profile",
    titleKey: "documents.catalog.patientFile",
    numbering: { prefix: "PF", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient"],
    resolver: { kind: "document", resolverId: "patient-file" },
    template: "PatientFileDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    supportsAttachments: true,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  PRESCRIPTION: {
    code: "PRESCRIPTION",
    archetype: "clinical",
    titleKey: "documents.catalog.prescription",
    numbering: { prefix: "RX", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "doctor", "date", "documentNumber", "status"],
    resolver: { kind: "document", resolverId: "prescription" },
    template: "PrescriptionDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    allowsExternalSubject: true,
    issuanceTrigger: { href: "/documents/clinical/prescription", contextual: true },
  },
  SICK_LEAVE_CERTIFICATE: {
    code: "SICK_LEAVE_CERTIFICATE",
    archetype: "clinical",
    titleKey: "documents.catalog.sickLeaveCertificate",
    numbering: { prefix: "SL", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "doctor", "date", "documentNumber", "status"],
    resolver: { kind: "document", resolverId: "sick-leave-certificate" },
    template: "SickLeaveCertificateDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    allowsExternalSubject: true,
    issuanceTrigger: { href: "/documents/clinical/sick-leave", contextual: true },
  },
  LAB_REQUEST: {
    code: "LAB_REQUEST",
    archetype: "clinical",
    titleKey: "documents.catalog.labRequest",
    numbering: { prefix: "LAB", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "doctor", "date", "documentNumber", "status"],
    resolver: { kind: "document", resolverId: "lab-request" },
    template: "LabRequestDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    allowsExternalSubject: true,
    issuanceTrigger: { href: "/documents/clinical/lab-request", contextual: true },
  },
  SYSTEM_MEMBERS_REPORT: {
    code: "SYSTEM_MEMBERS_REPORT",
    archetype: "roster",
    titleKey: "documents.catalog.systemMembersReport",
    numbering: { prefix: "SM", yearlyReset: true, sequencePadding: 4 },
    pageRoles: PERFORMANCE_ROLES,
    subject: "staff",
    filterSchema: ["employee", "department", "status", "search"],
    resolver: { kind: "document", resolverId: "system-members-report" },
    template: "SystemMembersDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/settings/staff", contextual: true },
  },
  STAFF_FILE: {
    code: "STAFF_FILE",
    archetype: "profile",
    titleKey: "documents.catalog.staffFile",
    numbering: { prefix: "SF", yearlyReset: true, sequencePadding: 4 },
    pageRoles: PERFORMANCE_ROLES,
    subject: "staff",
    filterSchema: ["employee"],
    resolver: { kind: "document", resolverId: "staff-file" },
    template: "StaffFileDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    supportsAttachments: true,
    issuanceTrigger: { href: "/settings/staff", contextual: true },
  },
  INVOICE: {
    code: "INVOICE",
    archetype: "financial",
    titleKey: "documents.catalog.invoice",
    numbering: { prefix: "INV", yearlyReset: true, sequencePadding: 4 },
    pageRoles: OPERATIONAL_ROLES,
    subject: "appointment",
    filterSchema: ["patient", "date", "dateRange", "status", "creator"],
    resolver: { kind: "document", resolverId: "invoice" },
    template: "InvoiceTemplate",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/appointments", contextual: true },
  },
  // P7-12 — patient history & financial documents. All patient-subject, resolved
  // from the shared P7-11 patient-file data layer (no new financial schema). The
  // two financial statements exclude scoped clinical roles (doctor/assistant);
  // the two history reports include them but omit financial data for those roles.
  APPOINTMENT_HISTORY_REPORT: {
    code: "APPOINTMENT_HISTORY_REPORT",
    archetype: "history",
    titleKey: "documents.catalog.appointmentHistoryReport",
    numbering: { prefix: "APH", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "dateRange"],
    resolver: { kind: "document", resolverId: "appointment-history-report" },
    template: "PatientHistoryDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  PACKAGE_HISTORY_REPORT: {
    code: "PACKAGE_HISTORY_REPORT",
    archetype: "history",
    titleKey: "documents.catalog.packageHistoryReport",
    numbering: { prefix: "PKH", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "dateRange", "status"],
    resolver: { kind: "document", resolverId: "package-history-report" },
    template: "PatientHistoryDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  DEPOSIT_STATEMENT: {
    code: "DEPOSIT_STATEMENT",
    archetype: "history",
    titleKey: "documents.catalog.depositStatement",
    numbering: { prefix: "DEP", yearlyReset: true, sequencePadding: 4 },
    pageRoles: OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "dateRange"],
    resolver: { kind: "document", resolverId: "deposit-statement" },
    template: "PatientHistoryDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  PATIENT_FINANCIAL_SUMMARY: {
    code: "PATIENT_FINANCIAL_SUMMARY",
    archetype: "history",
    titleKey: "documents.catalog.patientFinancialSummary",
    numbering: { prefix: "PFS", yearlyReset: true, sequencePadding: 4 },
    pageRoles: OPERATIONAL_ROLES,
    subject: "patient",
    filterSchema: ["patient", "dateRange"],
    resolver: { kind: "document", resolverId: "patient-financial-summary" },
    template: "PatientHistoryDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/patients", contextual: true },
  },
  // P7 Phase 4 — "Create document from scratch". Authored free-form: the user
  // supplies a title + rich-text body; the standard engine layout (branding,
  // header/footer, signature/stamp, QR after issue) frames it. No source table
  // and no data filters — authoring is the whole input, so `filterSchema` is
  // empty and the create flow lands on an empty authoring form.
  GENERIC_DOCUMENT: {
    code: "GENERIC_DOCUMENT",
    archetype: "generic",
    titleKey: "documents.catalog.genericDocument",
    numbering: { prefix: "DOC", yearlyReset: true, sequencePadding: 4 },
    pageRoles: SCOPED_OPERATIONAL_ROLES,
    subject: "clinic",
    filterSchema: [],
    resolver: { kind: "document", resolverId: "generic-document" },
    template: "GenericDocument",
    verificationDisclosure: SAFE_VERIFICATION_DISCLOSURE,
    issuanceTrigger: { href: "/documents/new/scratch", contextual: false },
  },
} as const satisfies Partial<Record<DocumentTypeCode, DocumentCatalogEntry>>;

export type RegisteredDocumentTypeCode = keyof typeof DOCUMENT_CATALOG;

export function isDocumentTypeCode(value: string): value is DocumentTypeCode {
  return (DOCUMENT_TYPE_CODES as readonly string[]).includes(value);
}

export function isRegisteredDocumentType(
  value: string,
): value is RegisteredDocumentTypeCode {
  return Object.hasOwn(DOCUMENT_CATALOG, value);
}

export function getDocumentCatalogEntry(
  code: RegisteredDocumentTypeCode,
): DocumentCatalogEntry {
  return DOCUMENT_CATALOG[code];
}
