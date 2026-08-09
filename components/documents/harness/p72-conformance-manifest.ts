import type { Locale } from "@/lib/i18n/config";
import type {
  DocumentArchetype,
  DocumentTypeCode,
} from "@/lib/documents/catalog";

export const P72_FROZEN_PRIMITIVES = [
  "SectionHeader",
  "IdentityHero",
  "FieldGrid",
  "StatCardRow",
  "StatusBadge",
  "DataTable",
  "GroupedTables",
  "TotalsSummary",
  "ChecklistPanel",
  "CertifyingProse",
  "NotesCallout",
  "VerificationBlock",
  "SignatureBlock",
] as const;

export type P72BodyPrimitive = (typeof P72_FROZEN_PRIMITIVES)[number];
export type P72EvidenceStatus =
  | "verified_from_figma"
  | "blocked_missing_reference"
  | "blocked_figma_quota";

export type P72VariantEvidence = {
  locale: Locale;
  figmaNodeId: string | null;
  referencePath: string;
  screenshotPath: string;
  status: P72EvidenceStatus;
};

export type P72ConformanceEntry = {
  ordinal: number;
  code: DocumentTypeCode;
  slug: string;
  title: string;
  archetype: DocumentArchetype;
  primitives: readonly P72BodyPrimitive[];
  cleanup: readonly string[];
  uncoveredRegions: readonly string[];
  engineConflicts: readonly string[];
  requiresNewPrimitive: false;
  variants: readonly [P72VariantEvidence, P72VariantEvidence];
};

const FILE_KEY = "nUzeFkN6Yn7m7knTzwmDHq";

function variant(
  folder: string,
  locale: Locale,
  nodeId: string | null,
  status: P72EvidenceStatus,
): P72VariantEvidence {
  return {
    locale,
    figmaNodeId: nodeId,
    referencePath: `docs/designs/document-platform/${folder}/${locale}/stitch-export/FIGMA_REFERENCE.md`,
    screenshotPath: `docs/designs/document-platform/${folder}/${locale}/screenshot/image.png`,
    status,
  };
}

const COMMON_CLEANUP = [
  "Remove non-printable canvas/background and browser-frame chrome.",
  "Replace placeholder QR artwork with a generated, inlined verification QR.",
  "Treat sample branding, identifiers, dates, signatures, and stamps as dynamic slots.",
] as const;

function entry(
  ordinal: number,
  code: DocumentTypeCode,
  slug: string,
  title: string,
  archetype: DocumentArchetype,
  primitives: readonly P72BodyPrimitive[],
  arNode: string | null,
  enNode: string | null,
  evidence: "verified" | "quota" | "missing",
  cleanup: readonly string[] = [],
  engineConflicts: readonly string[] = [],
): P72ConformanceEntry {
  const folder = `${String(ordinal).padStart(2, "0")}-${slug}`;
  const status: P72EvidenceStatus = evidence === "verified"
    ? "verified_from_figma"
    : evidence === "missing"
      ? "blocked_missing_reference"
      : "blocked_figma_quota";
  return {
    ordinal,
    code,
    slug,
    title,
    archetype,
    primitives,
    cleanup: [...COMMON_CLEANUP, ...cleanup],
    uncoveredRegions: [],
    engineConflicts,
    requiresNewPrimitive: false,
    variants: [variant(folder, "ar", arNode, status), variant(folder, "en", enNode, status)],
  };
}

/**
 * P7-2 evidence manifest. A screenshot is only a visual cross-check; a variant
 * reaches verified_from_figma only after its Figma node was inspected through
 * MCP. Missing or quota-blocked evidence deliberately keeps the gate closed.
 */
export const P72_CONFORMANCE_MANIFEST = [
  entry(1, "REVENUE_REPORT", "revenue-report", "Revenue Report", "analytical", ["StatCardRow", "SectionHeader", "DataTable", "TotalsSummary", "NotesCallout", "VerificationBlock", "SignatureBlock"], "8:262", "8:18", "verified"),
  entry(2, "FOLLOW_UP_PAGE_REPORT", "follow-up-page-report", "Follow-up Page Report", "analytical", ["SectionHeader", "StatCardRow", "DataTable", "StatusBadge", "VerificationBlock", "SignatureBlock"], "11:638", "11:507", "verified"),
  entry(3, "PATIENT_LIST_REPORT", "patient-list-report", "Patient List Report", "roster", ["GroupedTables", "StatusBadge", "VerificationBlock", "SignatureBlock"], "11:1121", "11:814", "verified"),
  entry(4, "PATIENT_FILE", "patient-file", "Patient File", "profile", ["IdentityHero", "SectionHeader", "FieldGrid", "StatusBadge", "VerificationBlock", "SignatureBlock"], "12:19", "12:192", "verified"),
  entry(5, "PRESCRIPTION", "prescription", "Prescription", "clinical", ["FieldGrid", "SectionHeader", "DataTable", "NotesCallout", "VerificationBlock", "SignatureBlock"], "12:367", "12:521", "verified", ["Normalize both inconsistent A5 source frames to the shared A4 portrait geometry while preserving hierarchy, spacing, content structure, and RTL/LTR balance."]),
  entry(6, "SICK_LEAVE_CERTIFICATE", "sick-leave-certificate", "Sick Leave Certificate", "clinical", ["SectionHeader", "FieldGrid", "CertifyingProse", "NotesCallout", "VerificationBlock", "SignatureBlock"], "16:335", "14:187", "verified"),
  entry(7, "LAB_REQUEST", "lab-request", "Lab Request", "clinical", ["FieldGrid", "SectionHeader", "ChecklistPanel", "NotesCallout", "VerificationBlock", "SignatureBlock"], "17:496", "17:736", "verified"),
  entry(8, "CANCELLATION_REPORT", "cancellation-report", "Cancellation Report", "analytical", ["NotesCallout", "StatCardRow", "SectionHeader", "DataTable", "TotalsSummary", "VerificationBlock", "SignatureBlock"], "18:1168", "18:956", "verified", ["Remove the Arabic Stitch application header, preview navigation, action buttons, and floating controls."]),
  entry(9, "NO_SHOW_REPORT", "no-show-report", "No-show Report", "analytical", ["StatCardRow", "SectionHeader", "DataTable", "TotalsSummary", "NotesCallout", "VerificationBlock", "SignatureBlock"], "19:1381", "19:1552", "verified"),
  entry(10, "SALES_REPORT", "sales-report", "Sales Report", "financial", ["SectionHeader", "StatCardRow", "DataTable", "TotalsSummary", "NotesCallout", "VerificationBlock", "SignatureBlock"], "19:1718", "19:1882", "verified"),
  entry(11, "FOLLOW_UP_ANALYTICS_REPORT", "follow-up-analytics-report", "Follow-up Analytics Report", "analytical", ["SectionHeader", "NotesCallout", "StatCardRow", "DataTable", "VerificationBlock", "SignatureBlock"], "20:2232", "20:2074", "verified", ["Render share/progress values as table-cell content; they do not introduce an engine primitive."]),
  entry(12, "DOCTOR_PERFORMANCE_REPORT", "doctor-performance-report", "Doctor Performance Report", "analytical", ["StatCardRow", "SectionHeader", "DataTable", "NotesCallout", "VerificationBlock", "SignatureBlock"], "20:2398", "20:2595", "verified"),
  entry(13, "RECEPTIONIST_PERFORMANCE_REPORT", "receptionist-performance-report", "Receptionist Performance Report", "analytical", ["SectionHeader", "NotesCallout", "StatCardRow", "DataTable", "VerificationBlock", "SignatureBlock"], "21:2783", "21:2934", "verified", ["Remove captured print action controls that Figma explicitly marks as non-document content."]),
  entry(14, "SYSTEM_MEMBERS_REPORT", "system-members-report", "System Members Report", "roster", ["FieldGrid", "GroupedTables", "StatusBadge", "NotesCallout", "VerificationBlock"], "22:3305", "22:3081", "verified"),
  entry(15, "STAFF_FILE", "staff-file", "Staff File", "profile", ["SectionHeader", "IdentityHero", "FieldGrid", "StatusBadge", "DataTable", "TotalsSummary", "NotesCallout", "SignatureBlock", "VerificationBlock"], "23:3517", "23:3734", "verified"),
  entry(16, "INVOICE", "invoice", "Invoice", "financial", ["IdentityHero", "StatusBadge", "TotalsSummary", "DataTable", "NotesCallout", "FieldGrid", "VerificationBlock", "SignatureBlock"], "24:3936", "24:4133", "verified"),
] as const satisfies readonly P72ConformanceEntry[];

export const P72_FIGMA_FILE_KEY = FILE_KEY;

export function isP72VariantVerified(variantEvidence: P72VariantEvidence): boolean {
  return variantEvidence.status === "verified_from_figma";
}

export function isP72DocumentConformant(entryValue: P72ConformanceEntry): boolean {
  return entryValue.variants.every(isP72VariantVerified)
    && entryValue.uncoveredRegions.length === 0
    && entryValue.engineConflicts.length === 0
    && !entryValue.requiresNewPrimitive;
}

export function getP72ConformanceSummary() {
  const variants = P72_CONFORMANCE_MANIFEST.flatMap((item) => item.variants);
  return {
    documents: P72_CONFORMANCE_MANIFEST.length,
    variants: variants.length,
    verifiedVariants: variants.filter(isP72VariantVerified).length,
    missingReferenceVariants: variants.filter((item) => item.status === "blocked_missing_reference").length,
    quotaBlockedVariants: variants.filter((item) => item.status === "blocked_figma_quota").length,
    engineConflictDocuments: P72_CONFORMANCE_MANIFEST.filter((item) => item.engineConflicts.length > 0).length,
    conformantDocuments: P72_CONFORMANCE_MANIFEST.filter(isP72DocumentConformant).length,
    gatePassed: P72_CONFORMANCE_MANIFEST.every(isP72DocumentConformant),
  } as const;
}
