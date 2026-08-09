import type { PermissionUserRole } from "@/lib/page-permissions";
import {
  DOCUMENT_CATALOG,
  type DocumentArchetype,
  type DocumentFilterKey,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";

/**
 * P7-8 — Central Document Factory shared helpers.
 *
 * Pure, dependency-free routing/grouping/filter derivations used by the module
 * pages (server), the list filter bar + table (client), and the tests. Every
 * mapping is derived from the frozen `DOCUMENT_CATALOG`, so a new document type
 * participates in the module by registering its catalog entry alone — the hub
 * never hardcodes a per-type list of its own.
 */

export const REGISTERED_DOCUMENT_TYPE_CODES = Object.keys(
  DOCUMENT_CATALOG,
) as RegisteredDocumentTypeCode[];

/** Display + grouping order for archetypes in the factory. */
export const DOCUMENT_ARCHETYPE_ORDER = [
  "financial",
  "clinical",
  "analytical",
  "roster",
  "profile",
  "history",
  // P7 Phase 4 — "Create document from scratch" always renders last on the hub.
  "generic",
] as const satisfies readonly DocumentArchetype[];

export const DOCUMENT_STATUS_VALUES = ["not_issued", "issued", "cancelled"] as const;
export type DocumentModuleStatus = (typeof DOCUMENT_STATUS_VALUES)[number];

/** The catalog codes a role may see/issue (subject-scope still enforced by RLS). */
export function getAccessibleDocumentTypeCodes(
  role: PermissionUserRole,
): RegisteredDocumentTypeCode[] {
  return REGISTERED_DOCUMENT_TYPE_CODES.filter((code) =>
    (DOCUMENT_CATALOG[code].pageRoles as readonly PermissionUserRole[]).includes(role),
  );
}

export function canRoleAccessDocumentType(
  role: PermissionUserRole,
  code: RegisteredDocumentTypeCode,
): boolean {
  return (DOCUMENT_CATALOG[code].pageRoles as readonly PermissionUserRole[]).includes(
    role,
  );
}

export type ArchetypeGroup = {
  archetype: DocumentArchetype;
  codes: RegisteredDocumentTypeCode[];
};

/** Group a set of codes by archetype in the fixed display order. */
export function groupDocumentTypesByArchetype(
  codes: readonly RegisteredDocumentTypeCode[],
): ArchetypeGroup[] {
  const set = new Set(codes);
  return DOCUMENT_ARCHETYPE_ORDER.map((archetype) => ({
    archetype,
    codes: REGISTERED_DOCUMENT_TYPE_CODES.filter(
      (code) => set.has(code) && DOCUMENT_CATALOG[code].archetype === archetype,
    ),
  })).filter((group) => group.codes.length > 0);
}

/**
 * The URL slug a doc type's issued-document rendering surface uses. These are
 * the already-built P7-3…P7-7 surfaces; the module reuses them, never
 * re-rendering a template of its own.
 */
const ANALYTICAL_SURFACE_SLUG: Partial<Record<RegisteredDocumentTypeCode, string>> = {
  FOLLOW_UP_PAGE_REPORT: "follow-ups",
  CANCELLATION_REPORT: "cancellations",
  NO_SHOW_REPORT: "no-shows",
  SALES_REPORT: "sales",
  FOLLOW_UP_ANALYTICS_REPORT: "follow-up-analytics",
  DOCTOR_PERFORMANCE_REPORT: "doctors",
  RECEPTIONIST_PERFORMANCE_REPORT: "receptionists",
};

const ROSTER_PROFILE_SURFACE_SLUG: Partial<Record<RegisteredDocumentTypeCode, string>> = {
  PATIENT_LIST_REPORT: "patient-list",
  PATIENT_FILE: "patient-file",
  SYSTEM_MEMBERS_REPORT: "system-members",
  STAFF_FILE: "staff-file",
};

const CLINICAL_SURFACE_SLUG: Partial<Record<RegisteredDocumentTypeCode, string>> = {
  PRESCRIPTION: "prescription",
  LAB_REQUEST: "lab-request",
  SICK_LEAVE_CERTIFICATE: "sick-leave",
};

export const CLINICAL_MODULE_SLUGS = CLINICAL_SURFACE_SLUG;

/** P7-12 — patient history/financial document rendering surfaces. */
export const PATIENT_HISTORY_MODULE_SLUGS = {
  APPOINTMENT_HISTORY_REPORT: "appointment-history",
  PACKAGE_HISTORY_REPORT: "package-history",
  DEPOSIT_STATEMENT: "deposit-statement",
  PATIENT_FINANCIAL_SUMMARY: "financial-summary",
} as const satisfies Partial<Record<RegisteredDocumentTypeCode, string>>;

/** Canonical module detail page for a newly issued document. */
export function issuedDocumentDetailHref(documentId: string): string {
  return `/documents/${encodeURIComponent(documentId)}`;
}

/**
 * Status-aware PDF endpoint. Reprint actions return this stable URL instead of
 * exposing the immutable canonical object directly, so a later cancellation is
 * respected at request time.
 */
export function documentPdfHref(documentId: string): string {
  return `/documents/${encodeURIComponent(documentId)}/pdf`;
}

/**
 * Deep-link to the existing rendering surface that displays an issued document
 * (its template + PDF + verification + reprint + history). Returns `null` for a
 * type without a dedicated surface (should not happen for a registered code).
 */
export function renderedDocumentHref(
  code: RegisteredDocumentTypeCode,
  documentId: string,
): string | null {
  const query = `?documentId=${encodeURIComponent(documentId)}`;
  if (code === "REVENUE_REPORT") return `/reports/revenue/document${query}`;
  if (code === "INVOICE") return `/appointments/invoice/document${query}`;
  const analytical = ANALYTICAL_SURFACE_SLUG[code];
  if (analytical) return `/reports/${analytical}/document${query}`;
  const rosterProfile = ROSTER_PROFILE_SURFACE_SLUG[code];
  if (rosterProfile) return `/documents/roster-profile/${rosterProfile}${query}`;
  const clinical = CLINICAL_SURFACE_SLUG[code];
  if (clinical) return `/documents/clinical/${clinical}${query}`;
  const patientHistory = PATIENT_HISTORY_MODULE_SLUGS[code as keyof typeof PATIENT_HISTORY_MODULE_SLUGS];
  if (patientHistory) return `/documents/patient-history/${patientHistory}${query}`;
  if (code === "GENERIC_DOCUMENT") return `/documents/generic${query}`;
  return null;
}

/**
 * The document-preview surface a direct (data-generated) type resolves and
 * issues from. This is where the setup/filter popup Saves into, and where the
 * editable Preview toolbar lives. Clinical/subject-bound types are not direct
 * and are not represented here (they authored/pick a subject elsewhere).
 */
export function documentPreviewSurfaceHref(code: RegisteredDocumentTypeCode): string {
  if (code === "REVENUE_REPORT") return "/reports/revenue/document";
  const analytical = ANALYTICAL_SURFACE_SLUG[code];
  if (analytical) return `/reports/${analytical}/document`;
  if (code === "PATIENT_LIST_REPORT") return "/documents/roster-profile/patient-list";
  if (code === "SYSTEM_MEMBERS_REPORT") return "/documents/roster-profile/system-members";
  return DOCUMENT_CATALOG[code].issuanceTrigger.href;
}

type DraftParams = Record<string, unknown>;

function draftString(params: DraftParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Canonical preview/edit links reconstructed from a persisted draft payload. */
export function documentDraftHrefs(
  code: RegisteredDocumentTypeCode,
  draftId: string,
  params: DraftParams,
  locale: "ar" | "en",
): { previewHref: string; editHref: string } {
  const common = new URLSearchParams({ locale, origin: "documents", draftId });
  const append = (key: string, value: string | null) => {
    if (value) common.set(key, value);
  };

  if (code === "GENERIC_DOCUMENT") {
    return {
      previewHref: `/documents/new/scratch?draftId=${encodeURIComponent(draftId)}`,
      editHref: `/documents/new/scratch?draftId=${encodeURIComponent(draftId)}`,
    };
  }

  const clinical = CLINICAL_SURFACE_SLUG[code];
  if (clinical) {
    append("recordId", draftString(params, "recordId"));
    return {
      previewHref: `/documents/clinical/${clinical}?${common}`,
      editHref: `/documents/new/clinical/${clinical}?draftId=${encodeURIComponent(draftId)}`,
    };
  }

  if (code === "INVOICE") {
    append("appointmentId", draftString(params, "appointmentId"));
    return {
      previewHref: `/appointments/invoice/document?${common}`,
      editHref: `/documents/new/invoice?draftId=${encodeURIComponent(draftId)}`,
    };
  }

  const history = PATIENT_HISTORY_MODULE_SLUGS[
    code as keyof typeof PATIENT_HISTORY_MODULE_SLUGS
  ];
  if (history) {
    for (const key of ["patientId", "preset", "from", "to"]) {
      append(key, draftString(params, key));
    }
    return {
      previewHref: `/documents/patient-history/${history}?${common}`,
      editHref: `/documents/new/patient-history/${history}?draftId=${encodeURIComponent(draftId)}`,
    };
  }

  for (const key of [
    "preset", "from", "to", "doctor", "department", "receptionist", "outcome", "q",
    "patientId", "staffId", "role",
  ]) {
    append(key, draftString(params, key));
  }
  return {
    previewHref: `${documentPreviewSurfaceHref(code)}?${common}`,
    editHref: documentNeedsSetup(code)
      ? `/documents/new/setup/${code}?draftId=${encodeURIComponent(draftId)}`
      : createDocumentHref(code),
  };
}

/**
 * The create/authoring entry point for a doc type from `/documents/new`.
 *
 * P7 Phase 4 — data-generated (Type A) types with a filter schema route through
 * the setup/filter popup first (`/documents/new/setup/[code]`), which Saves into
 * the preview surface. Clinical types dispatch to the shared authoring form;
 * the generic type opens its empty authoring form; subject-bound types route to
 * the contextual source surface where the subject is naturally selected.
 */
export function createDocumentHref(code: RegisteredDocumentTypeCode): string {
  if (documentNeedsSetup(code)) return `/documents/new/setup/${code}`;
  const clinical = CLINICAL_SURFACE_SLUG[code];
  if (clinical) return `/documents/new/clinical/${clinical}`;
  if (code === "PATIENT_FILE") return "/patients";
  if (code === "STAFF_FILE") return "/settings/staff";
  if (code === "INVOICE") return "/documents/new/invoice";
  const patientHistory = PATIENT_HISTORY_MODULE_SLUGS[code as keyof typeof PATIENT_HISTORY_MODULE_SLUGS];
  if (patientHistory) return `/documents/new/patient-history/${patientHistory}`;
  return DOCUMENT_CATALOG[code].issuanceTrigger.href;
}

/** Which document-preview surface family a direct type resolves through. */
export function documentSurfaceKind(
  code: RegisteredDocumentTypeCode,
): "analytical" | "roster" | "other" {
  if (code === "REVENUE_REPORT" || ANALYTICAL_SURFACE_SLUG[code]) return "analytical";
  if (code === "PATIENT_LIST_REPORT" || code === "SYSTEM_MEMBERS_REPORT") return "roster";
  return "other";
}

/**
 * The setup/filter fields a data-generated type collects before Preview, derived
 * from its catalog `filterSchema` mapped onto the params its preview surface
 * actually resolves. `date` carries the shared Phase 2 pattern (`preset=custom` +
 * `from`/`to`); the rest are single-value selects/search bound to one canonical
 * query param each.
 */
export type DocumentSetupField =
  | { key: "dateRange" }
  | { key: "doctor"; param: "doctor" }
  | { key: "department"; param: "department" }
  | { key: "receptionist"; param: "receptionist" }
  | { key: "search"; param: "q" };

export function documentSetupFields(
  code: RegisteredDocumentTypeCode,
): DocumentSetupField[] {
  const schema = new Set(DOCUMENT_CATALOG[code].filterSchema);
  const kind = documentSurfaceKind(code);
  const fields: DocumentSetupField[] = [];
  if (schema.has("dateRange")) fields.push({ key: "dateRange" });
  if (schema.has("doctor")) fields.push({ key: "doctor", param: "doctor" });
  if (schema.has("department")) fields.push({ key: "department", param: "department" });
  // `employee` maps to the analytical receptionist filter only (roster surfaces
  // do not filter generation by a single employee).
  if (schema.has("employee") && kind === "analytical") {
    fields.push({ key: "receptionist", param: "receptionist" });
  }
  if (schema.has("search") && kind === "roster") fields.push({ key: "search", param: "q" });
  return fields;
}

/**
 * A data-generated (Type A) type opens the setup/filter popup first when it is a
 * direct type that resolves through a preview surface AND has at least one setup
 * field. The generic free-form type is direct but has no fields, so it opens its
 * authoring form directly instead.
 */
export function documentNeedsSetup(code: RegisteredDocumentTypeCode): boolean {
  return (
    documentSurfaceKind(code) !== "other"
    && documentSetupFields(code).length > 0
  );
}

/**
 * Whether the create entry point stays inside the document authoring workflow
 * (true) or hands off to a contextual profile source (false). Drives the hint
 * shown on the picker card.
 */
export function createFlowIsDirect(code: RegisteredDocumentTypeCode): boolean {
  return (
    code !== "PATIENT_FILE"
    && code !== "STAFF_FILE"
  );
}

/** Shared filters shown when no single type is selected (doc 08 §3). */
export const SHARED_FILTER_KEYS = [
  "documentType",
  "date",
  "documentNumber",
  "creator",
  "search",
  "status",
] as const;

/**
 * The filter keys relevant to the current type selection: the type's own
 * `filterSchema` (plus always-present shared keys) when one type is chosen,
 * otherwise the shared set.
 */
export function documentFilterKeysFor(
  code: RegisteredDocumentTypeCode | null,
): DocumentFilterKey[] {
  if (!code) {
    return ["date", "documentNumber", "creator", "status", "search"];
  }
  const schema = DOCUMENT_CATALOG[code].filterSchema;
  const keys = new Set<DocumentFilterKey>([
    "date",
    "documentNumber",
    "creator",
    ...schema,
  ]);
  return Array.from(keys);
}
