import "server-only";

import type { z } from "zod";
import {
  DOCUMENT_CATALOG,
  getDocumentCatalogEntry,
  isRegisteredDocumentType,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import {
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import {
  describeDocumentIssueFailure,
  issueDocumentFoundation,
} from "@/lib/documents/issuance";
import { issueInvoiceDocument } from "@/lib/documents/invoice-issuance";
import { documentPdfHref, issuedDocumentDetailHref } from "@/lib/documents/module";
import { getDocumentTypeLabel } from "@/lib/documents/module-labels";
import { getDocumentPdfRenderer } from "@/lib/documents/renderers/registry";
import {
  analyticalDocumentParamsSchema,
  resolveAnalyticalDocumentSnapshot,
  type AnalyticalDocumentParams,
  type P74AnalyticalDocumentCode,
} from "@/lib/documents/resolvers/analytical-report";
import {
  clinicalDocumentParamsSchema,
  resolveClinicalDocumentSnapshot,
  type ClinicalDocumentParams,
} from "@/lib/documents/resolvers/clinical-document";
import {
  genericDocumentParamsSchema,
  resolveGenericDocumentSnapshot,
  GENERIC_DOCUMENT_CODE,
  type GenericDocumentParams,
} from "@/lib/documents/resolvers/generic-document";
import { isDocumentSubjectNotFoundError } from "@/lib/documents/resolvers/errors";
import {
  invoiceDocumentParamsSchema,
  resolveInvoiceDocumentSnapshot,
  type InvoiceDocumentParams,
} from "@/lib/documents/resolvers/invoice";
import {
  patientHistoryDocumentParamsSchema,
  resolvePatientHistoryDocumentSnapshot,
  type PatientHistoryDocumentParams,
  type P712PatientHistoryDocumentCode,
} from "@/lib/documents/resolvers/patient-history";
import {
  resolveRevenueDocumentSnapshot,
  revenueDocumentParamsSchema,
  type RevenueDocumentParams,
} from "@/lib/documents/resolvers/revenue-report";
import {
  resolveRosterProfileDocumentSnapshot,
  rosterProfileDocumentParamsSchema,
  type P75RosterProfileDocumentCode,
  type RosterProfileDocumentParams,
} from "@/lib/documents/resolvers/roster-profile";
import {
  transitionClinicalRecordMutation,
  type ClinicalTable,
} from "@/lib/clinical/mutations";
import type { PermissionUserRole } from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  getPageVisibilityState,
  type PageVisibilityState,
} from "@/lib/server-page-permissions";
import { getReportVisibilityState } from "@/lib/server-report-permissions";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import type { Json } from "@/types/database";

/**
 * Phase 6 — session-free document issuance cores (§8.1 extraction rule).
 *
 * The `actions/documents*.ts` server actions are UI-shaped: they resolve the
 * session, `notFound()` on a role miss, and map failures onto UI error codes.
 * Everything *after* the session guard — the params schema, the snapshot
 * resolution, the catalog-derived numbering, the idempotency key shape, and the
 * `issueDocumentFoundation` call — now lives here and is called by both the
 * server action and the assistant's `documents.issue` action, so the UI and the
 * Assistant issue byte-identical documents through byte-identical code.
 *
 * These cores are callable without a request context, so they fail closed on
 * their own: role, reports-page visibility, and per-user report visibility are
 * asserted here rather than inherited from the caller.
 */

export type DocumentIssueFamily =
  | "revenue"
  | "analytical"
  | "roster_profile"
  | "invoice"
  | "patient_history"
  | "clinical"
  | "generic";

export type DocumentCoreFailureCode =
  | "documentTypeUnknown"
  | "documentTypeNotAvailable"
  | "reportNotVisible"
  | "invalidInput"
  /**
   * P6-12 — the document's subject resolved to nothing: the record does not
   * exist, or it is outside this caller's RLS/application scope. Permanent, and
   * deliberately the same code for both so it cannot be used to enumerate ids.
   * Distinct from `previewFailed`, which now means only a genuine transient or
   * infrastructure failure.
   */
  | "documentSubjectNotFound"
  | "previewFailed"
  | "issueFailed"
  | "controlledMedicineBlocked"
  | "clinicalRecordNotFinalized"
  | "documentNotFound"
  | "documentNotReprintable"
  | "reprintFailed";

export type DocumentIssueCoreData = {
  documentId: string;
  documentNumber: string;
  reused: boolean;
  detailHref: string;
  pdfHref: string;
};

const FAMILY_BY_CODE: Record<RegisteredDocumentTypeCode, DocumentIssueFamily> = {
  REVENUE_REPORT: "revenue",
  FOLLOW_UP_PAGE_REPORT: "analytical",
  CANCELLATION_REPORT: "analytical",
  NO_SHOW_REPORT: "analytical",
  SALES_REPORT: "analytical",
  FOLLOW_UP_ANALYTICS_REPORT: "analytical",
  DOCTOR_PERFORMANCE_REPORT: "analytical",
  RECEPTIONIST_PERFORMANCE_REPORT: "analytical",
  PATIENT_LIST_REPORT: "roster_profile",
  PATIENT_FILE: "roster_profile",
  SYSTEM_MEMBERS_REPORT: "roster_profile",
  STAFF_FILE: "roster_profile",
  PRESCRIPTION: "clinical",
  SICK_LEAVE_CERTIFICATE: "clinical",
  LAB_REQUEST: "clinical",
  INVOICE: "invoice",
  APPOINTMENT_HISTORY_REPORT: "patient_history",
  PACKAGE_HISTORY_REPORT: "patient_history",
  DEPOSIT_STATEMENT: "patient_history",
  PATIENT_FINANCIAL_SUMMARY: "patient_history",
  GENERIC_DOCUMENT: "generic",
};

export function documentIssueFamily(
  code: RegisteredDocumentTypeCode,
): DocumentIssueFamily {
  return FAMILY_BY_CODE[code];
}

/**
 * The params schema a type's preview/issue input is validated against. The
 * Assistant never invents a schema of its own: a slot the model fills is a key
 * of exactly this object, and a zod failure becomes a question rather than a
 * refusal (§10 step 5).
 */
export function documentParamsSchema(
  code: RegisteredDocumentTypeCode,
): z.ZodType<unknown> {
  switch (documentIssueFamily(code)) {
    case "revenue":
      return revenueDocumentParamsSchema;
    case "analytical":
      return analyticalDocumentParamsSchema;
    case "roster_profile":
      return rosterProfileDocumentParamsSchema;
    case "invoice":
      return invoiceDocumentParamsSchema;
    case "patient_history":
      return patientHistoryDocumentParamsSchema;
    case "clinical":
      return clinicalDocumentParamsSchema;
    case "generic":
      return genericDocumentParamsSchema;
  }
}

/** Reports-backed types inherit the report catalog's own visibility gate. */
function reportIdFor(code: RegisteredDocumentTypeCode): ClinicReportId | null {
  const resolver = DOCUMENT_CATALOG[code].resolver;
  return resolver.kind === "report" ? (resolver.reportId as ClinicReportId) : null;
}

/**
 * P6-02 — which types the UI issues from behind the Reports index guard.
 *
 * `requireAnalyticalDocumentAccess` in `actions/documents.ts` routes the six
 * report-backed analytical types through `requireReportAccess` (page + per-user
 * report grant) and the remaining two — `SALES_REPORT` and
 * `FOLLOW_UP_ANALYTICS_REPORT`, which declare `resolver.kind === "document"` —
 * through `requireReportsIndexAccess()`, which `notFound()`s when the Reports
 * page is hidden for that user. Keying only on `resolver.kind === "report"`
 * therefore dropped the page gate for exactly those two, letting the Assistant
 * issue a report the UI 404s. Every analytical type (and every report-backed
 * one) is issued from `/reports`, so the page gate applies to all of them.
 */
function requiresReportsPageVisibility(code: RegisteredDocumentTypeCode): boolean {
  return (
    reportIdFor(code) !== null ||
    documentIssueFamily(code) === "analytical" ||
    getDocumentCatalogEntry(code).issuanceTrigger.href.startsWith("/reports")
  );
}

/**
 * The whole application authorization stack for one document type, minus the
 * session lookup: catalog role, Reports page visibility, and the per-user
 * report grant. Mirrors `requireReportAccess` / `requireReportsIndexAccess`
 * exactly, but returns a value instead of calling `notFound()`.
 */
export async function assertDocumentTypeAccess(
  user: AuthedUser,
  code: RegisteredDocumentTypeCode,
  options: {
    /**
     * P6-10 — the caller's already-resolved `reports` page visibility.
     *
     * `describeIssuableDocuments` calls this once per candidate type inside a
     * `Promise.all`, which for an admin meant six identical
     * `user_page_permissions` round-trips on a latency-sensitive streaming path.
     * `getPageVisibilityState` is memoized per request, but React `cache()` only
     * dedupes inside a request scope, so the loop also hoists the single lookup
     * and passes it here. Purely a read the caller already performed for the
     * same `(user, "reports")` pair — it can never widen access.
     */
    reportsPageVisibility?: PageVisibilityState;
  } = {},
): Promise<DomainMutationResult<{ code: RegisteredDocumentTypeCode }>> {
  const catalog = getDocumentCatalogEntry(code);
  if (!catalog.pageRoles.includes(user.role as PermissionUserRole)) {
    return domainFailure("documentTypeNotAvailable");
  }
  const reportId = reportIdFor(code);
  if (requiresReportsPageVisibility(code)) {
    const [pageVisibility, reportVisibility] = await Promise.all([
      options.reportsPageVisibility ?? getPageVisibilityState(user, "reports"),
      reportId
        ? getReportVisibilityState(user, reportId)
        : Promise.resolve("visible" as const),
    ]);
    if (pageVisibility !== "visible" || reportVisibility !== "visible") {
      return domainFailure("reportNotVisible");
    }
  }
  return domainSuccess({ code }, { targetTable: "documents" });
}

function periodKeyFor(
  settings: { numberingYearlyReset: boolean },
  generatedAt: string,
): string {
  return settings.numberingYearlyReset
    ? new Date(generatedAt).getFullYear().toString()
    : "";
}

function issuedData(result: {
  documentId: string;
  documentNumber: string;
  reused: boolean;
}): DocumentIssueCoreData {
  return {
    documentId: result.documentId,
    documentNumber: result.documentNumber,
    reused: result.reused,
    detailHref: issuedDocumentDetailHref(result.documentId),
    pdfHref: documentPdfHref(result.documentId),
  };
}

export type DocumentIssueCommonInput = {
  locale: "ar" | "en";
  /** Stable per-request key. Retrying with the same key reuses the document. */
  idempotencyKey: string;
  draftId?: string | null;
};

type CoreResult = DomainMutationResult<DocumentIssueCoreData>;

function issueFailure(
  scope: string,
  code: RegisteredDocumentTypeCode,
  clinicId: string,
  error: unknown,
): CoreResult {
  console.error(`${scope}_document_issue_failed`, {
    clinicId,
    documentType: code,
    stage:
      error && typeof error === "object" && "stage" in error
        ? String((error as { stage: unknown }).stage)
        : "unknown",
    message: error instanceof Error ? error.message : "unknown",
  });
  return domainFailure("issueFailed");
}

function issueAudit(
  code: RegisteredDocumentTypeCode,
  documentId: string,
  /**
   * P6-03 — records this issuance also mutated. Clinical issuance transitions
   * the source record `draft → finalized`, so the §12 ledger must be able to
   * answer "which prescription did the Assistant finalize", not only "which
   * document did it create".
   */
  sideEffect?: { table: string; recordId: string; before: string; after: string },
) {
  return {
    targetTable: "documents",
    targetRecordIds: sideEffect ? [documentId, sideEffect.recordId] : [documentId],
    before: {
      document_id: null,
      doc_type: code,
      status: "not_issued",
      ...(sideEffect
        ? {
            [`${sideEffect.table}.${sideEffect.recordId}`]: sideEffect.before,
          }
        : {}),
    },
    after: {
      document_id: documentId,
      doc_type: code,
      status: "issued",
      ...(sideEffect
        ? {
            [`${sideEffect.table}.${sideEffect.recordId}`]: sideEffect.after,
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-family issuance cores
// ---------------------------------------------------------------------------

export async function issueRevenueDocumentCore(
  user: AuthedUser,
  input: RevenueDocumentParams & DocumentIssueCommonInput,
): Promise<CoreResult> {
  const parsed = revenueDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  try {
    const snapshot = await resolveRevenueDocumentSnapshot(user, parsed.data);
    const catalog = getDocumentCatalogEntry("REVENUE_REPORT");
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: catalog.code,
      idempotencyKey: `revenue:${input.idempotencyKey}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        from: parsed.data.from,
        to: parsed.data.to,
        doctorId: parsed.data.doctorId ?? null,
        departmentId: parsed.data.departmentId ?? null,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      render: getDocumentPdfRenderer(catalog.code),
    });
    return domainSuccess(issuedData(result), issueAudit("REVENUE_REPORT", result.documentId));
  } catch (error) {
    return issueFailure("revenue", "REVENUE_REPORT", user.clinicId, error);
  }
}

export async function issueAnalyticalDocumentCore(
  user: AuthedUser,
  input: AnalyticalDocumentParams & DocumentIssueCommonInput,
): Promise<CoreResult> {
  const parsed = analyticalDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  const code = parsed.data.documentType as P74AnalyticalDocumentCode;
  try {
    const snapshot = await resolveAnalyticalDocumentSnapshot(user, parsed.data);
    const catalog = getDocumentCatalogEntry(code);
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: catalog.code,
      idempotencyKey: `analytical:${catalog.code.toLowerCase()}:${input.idempotencyKey}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        documentType: parsed.data.documentType,
        from: parsed.data.from,
        to: parsed.data.to,
        doctorId: parsed.data.doctorId ?? null,
        departmentId: parsed.data.departmentId ?? null,
        receptionistId: parsed.data.receptionistId ?? null,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      doctorId:
        code === "DOCTOR_PERFORMANCE_REPORT" ? parsed.data.doctorId ?? null : null,
      staffId:
        code === "RECEPTIONIST_PERFORMANCE_REPORT"
          ? parsed.data.receptionistId ?? null
          : null,
      render: getDocumentPdfRenderer(code),
    });
    return domainSuccess(issuedData(result), issueAudit(code, result.documentId));
  } catch (error) {
    return issueFailure("analytical", code, user.clinicId, error);
  }
}

export async function issueRosterProfileDocumentCore(
  user: AuthedUser,
  input: RosterProfileDocumentParams &
    DocumentIssueCommonInput & { attachmentKeys?: string[] },
): Promise<CoreResult> {
  const parsed = rosterProfileDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  const code = parsed.data.documentType as P75RosterProfileDocumentCode;
  const attachmentKeys = input.attachmentKeys ?? [];
  try {
    const snapshot = await resolveRosterProfileDocumentSnapshot(user, parsed.data, {
      attachmentKeys,
    });
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: code,
      idempotencyKey: `roster-profile:${code.toLowerCase()}:${input.idempotencyKey}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        documentType: code,
        patientId: parsed.data.patientId ?? null,
        staffId: parsed.data.staffId ?? null,
        departmentId: parsed.data.departmentId ?? null,
        doctorId: parsed.data.doctorId ?? null,
        role: parsed.data.role ?? null,
        search: parsed.data.search ?? null,
        attachmentKeys,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      patientId: code === "PATIENT_FILE" ? parsed.data.patientId ?? null : null,
      staffId: code === "STAFF_FILE" ? parsed.data.staffId ?? null : null,
      render: getDocumentPdfRenderer(code),
    });
    return domainSuccess(issuedData(result), issueAudit(code, result.documentId));
  } catch (error) {
    return issueFailure("roster_profile", code, user.clinicId, error);
  }
}

export async function issueInvoiceDocumentCore(
  user: AuthedUser,
  input: InvoiceDocumentParams & Omit<DocumentIssueCommonInput, "idempotencyKey">,
): Promise<CoreResult> {
  const parsed = invoiceDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  try {
    // Invoice issuance is already a session-free `(ids, locale)` core and owns
    // its own idempotency through the appointment id, so it is reused as-is.
    const result = await issueInvoiceDocument({
      clinicId: user.clinicId,
      actorId: user.id,
      appointmentId: parsed.data.appointmentId,
      locale: input.locale,
      draftId: input.draftId ?? undefined,
    });
    return domainSuccess(issuedData(result), issueAudit("INVOICE", result.documentId));
  } catch (error) {
    // Invoice issuance keeps its structured Postgres-field logging (P7-7): the
    // generic stage-only shape would drop `code`/`details`/`hint`.
    const failure = describeDocumentIssueFailure(error, "invoice-action");
    console.error("invoice_document_issue_failed", {
      clinicId: user.clinicId,
      ...failure,
    });
    return domainFailure("issueFailed");
  }
}

export async function issuePatientHistoryDocumentCore(
  user: AuthedUser,
  input: PatientHistoryDocumentParams & DocumentIssueCommonInput,
): Promise<CoreResult> {
  const parsed = patientHistoryDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  const code = parsed.data.documentType as P712PatientHistoryDocumentCode;
  try {
    const snapshot = await resolvePatientHistoryDocumentSnapshot(user, parsed.data);
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: code,
      idempotencyKey: `patient-history:${code.toLowerCase()}:${input.idempotencyKey}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        documentType: code,
        patientId: parsed.data.patientId,
        preset: snapshot.range.preset,
        from: snapshot.range.from,
        to: snapshot.range.to,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      patientId: parsed.data.patientId,
      render: getDocumentPdfRenderer(code),
    });
    return domainSuccess(issuedData(result), issueAudit(code, result.documentId));
  } catch (error) {
    return issueFailure("patient_history", code, user.clinicId, error);
  }
}

export type ClinicalRecordFinalizer = (
  table: ClinicalTable,
  recordId: string,
) => Promise<{ success: boolean }>;

/** The clinical table each clinical document type is issued from. */
export function clinicalTableForDocumentType(
  code: RegisteredDocumentTypeCode,
): ClinicalTable | null {
  if (code === "PRESCRIPTION") return "prescriptions";
  if (code === "LAB_REQUEST") return "lab_requests";
  if (code === "SICK_LEAVE_CERTIFICATE") return "sick_leaves";
  return null;
}

export type ClinicalRecordIssueState = {
  table: ClinicalTable;
  recordId: string;
  status: string;
  /** Whether issuing will transition this record, i.e. it is still a draft. */
  willFinalize: boolean;
};

/**
 * P6-03 — read (never write) the source record's current lifecycle state so the
 * confirmation card can disclose the finalization that issuance performs.
 *
 * §11 lists "finalize a prescription" as its own sensitive write; a user
 * confirming "issue a document" is also confirming an irreversible clinical
 * state change, and the preview is the only human checkpoint for it. Returns
 * `null` when the record is not visible to this caller under RLS, which the
 * caller reports identically to "not found".
 */
export async function resolveClinicalRecordIssueState(
  user: AuthedUser,
  code: RegisteredDocumentTypeCode,
  recordId: string,
): Promise<ClinicalRecordIssueState | null> {
  const table = clinicalTableForDocumentType(code);
  if (!table) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .select("id, status")
    .eq("id", recordId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    table,
    recordId,
    status: data.status,
    willFinalize: data.status === "draft",
  };
}

/**
 * Issue-time finalization for the Assistant path, built on the same Phase 5c
 * domain core the clinical UI calls. Already-finalized is a success (issuing a
 * finalized record twice is the idempotent reprint case); a voided or missing
 * record is not.
 */
export async function finalizeClinicalRecordForIssue(
  user: AuthedUser,
  table: ClinicalTable,
  recordId: string,
): Promise<{ success: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .select("id, status")
    .eq("id", recordId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (error || !data) return { success: false };
  if (data.status === "finalized") return { success: true };
  if (data.status !== "draft") return { success: false };
  const transitioned = await transitionClinicalRecordMutation(
    user,
    table,
    { id: recordId },
    "finalize",
  );
  return { success: transitioned.ok };
}

export async function issueClinicalDocumentCore(
  user: AuthedUser,
  input: ClinicalDocumentParams & Omit<DocumentIssueCommonInput, "idempotencyKey">,
  finalizeRecord: ClinicalRecordFinalizer,
): Promise<CoreResult> {
  const parsed = clinicalDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  const code = parsed.data.documentType;
  try {
    const draftSnapshot = await resolveClinicalDocumentSnapshot(user, parsed.data, {
      allowDraft: true,
    });
    if (
      draftSnapshot.data.kind === "prescription" &&
      draftSnapshot.data.medications.some((item) => item.isControlled)
    ) {
      return domainFailure("controlledMedicineBlocked");
    }
    const table = clinicalTableForDocumentType(code) ?? "prescriptions";
    // P6-03 — captured before the transition so the receipt records the real
    // `before` state rather than the post-finalize one.
    const stateBefore = await resolveClinicalRecordIssueState(
      user,
      code,
      parsed.data.recordId,
    );
    const finalized = await finalizeRecord(table, parsed.data.recordId);
    if (!finalized.success) return domainFailure("clinicalRecordNotFinalized");
    const snapshot = await resolveClinicalDocumentSnapshot(user, parsed.data);
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: code,
      // Clinical issuance is keyed by the finalized record, not by the caller:
      // the same prescription can never produce two documents in one locale.
      idempotencyKey: `clinical:${code.toLowerCase()}:${parsed.data.recordId}:${input.locale}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        documentType: code,
        recordId: parsed.data.recordId,
      } as unknown as Json,
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      patientId: snapshot.subject.patientId,
      doctorId: snapshot.physician.id,
      appointmentId: snapshot.data.appointmentId,
      render: getDocumentPdfRenderer(code),
    });
    return domainSuccess(
      issuedData(result),
      issueAudit(code, result.documentId, {
        table,
        recordId: parsed.data.recordId,
        before: stateBefore?.status ?? "unknown",
        after: "finalized",
      }),
    );
  } catch (error) {
    return issueFailure("clinical", code, user.clinicId, error);
  }
}

export async function issueGenericDocumentCore(
  user: AuthedUser,
  input: GenericDocumentParams & DocumentIssueCommonInput,
): Promise<CoreResult> {
  const parsed = genericDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return domainFailure("invalidInput", { validationError: parsed.error });
  try {
    const snapshot = await resolveGenericDocumentSnapshot(user, parsed.data);
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: input.draftId ?? undefined,
      documentType: GENERIC_DOCUMENT_CODE,
      idempotencyKey: `generic-document:${input.idempotencyKey}`,
      locale: input.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: periodKeyFor(snapshot.settings, snapshot.generatedAt),
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1,
        documentType: GENERIC_DOCUMENT_CODE,
        title: parsed.data.title,
        blocks: parsed.data.blocks,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      render: getDocumentPdfRenderer(GENERIC_DOCUMENT_CODE),
    });
    return domainSuccess(
      issuedData(result),
      issueAudit(GENERIC_DOCUMENT_CODE, result.documentId),
    );
  } catch (error) {
    return issueFailure("generic", GENERIC_DOCUMENT_CODE, user.clinicId, error);
  }
}

// ---------------------------------------------------------------------------
// Reprint
// ---------------------------------------------------------------------------

/**
 * The append-only reprint RPC each archetype already owns. Every one re-serves
 * the stored canonical PDF, bumps `print_count`, and records a `reprinted`
 * document event; none of them renders or renumbers anything.
 */
export const DOCUMENT_REPRINT_RPC = {
  revenue: "record_revenue_document_reprint",
  analytical: "record_analytical_document_reprint",
  roster_profile: "record_roster_profile_document_reprint",
  invoice: "record_invoice_document_reprint",
  patient_history: "record_patient_history_document_reprint",
  clinical: "record_clinical_document_reprint",
  generic: "record_generic_document_reprint",
} as const satisfies Record<DocumentIssueFamily, string>;

export type DocumentReprintCoreData = {
  documentId: string;
  documentType: RegisteredDocumentTypeCode;
  documentNumber: string;
  printCount: number;
  pdfHref: string;
};

/**
 * Session-free reprint. Resolves the type through the caller's own RLS client
 * first, then re-applies the catalog/report authorization for that type, so an
 * id outside the caller's scope and an id of a type the caller may not see are
 * reported identically ("not found") and never distinguishable.
 */
export async function reprintDocumentCore(
  user: AuthedUser,
  documentId: string,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<DocumentReprintCoreData>> {
  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select("id, doc_type, document_number, status, print_count, issued_at")
    .eq("clinic_id", user.clinicId)
    .eq("id", documentId)
    .maybeSingle();
  if (error || !document || !document.issued_at) {
    return domainFailure("documentNotFound");
  }
  if (!isRegisteredDocumentType(document.doc_type)) {
    return domainFailure("documentNotFound");
  }
  const code = document.doc_type;
  const access = await assertDocumentTypeAccess(user, code);
  if (!access.ok) return domainFailure("documentNotFound");
  if (document.status !== "issued") return domainFailure("documentNotReprintable");

  const audit = {
    targetTable: "documents",
    targetRecordIds: [document.id],
    before: {
      document_id: document.id,
      document_number: document.document_number,
      print_count: document.print_count,
    },
    after: {
      document_id: document.id,
      document_number: document.document_number,
      print_count: document.print_count + 1,
    },
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        documentId: document.id,
        documentType: code,
        documentNumber: document.document_number,
        printCount: document.print_count,
        pdfHref: documentPdfHref(document.id),
      },
      audit,
    );
  }

  try {
    const rpc = DOCUMENT_REPRINT_RPC[documentIssueFamily(code)];
    const { data, error: rpcError } = await supabase.rpc(rpc, {
      p_document_id: document.id,
    });
    const row = data?.[0];
    if (rpcError || !row) throw rpcError ?? new Error("Reprint did not return a document");
    return domainSuccess(
      {
        documentId: document.id,
        documentType: code,
        documentNumber: row.document_number,
        printCount: row.print_count,
        pdfHref: documentPdfHref(document.id),
      },
      {
        ...audit,
        after: {
          document_id: document.id,
          document_number: row.document_number,
          print_count: row.print_count,
        },
      },
    );
  } catch (reprintError) {
    console.error("document_reprint_core_failed", {
      clinicId: user.clinicId,
      documentId,
      documentType: code,
      message: reprintError instanceof Error ? reprintError.message : "unknown",
    });
    return domainFailure("reprintFailed");
  }
}

// ---------------------------------------------------------------------------
// Generic dispatch used by the Assistant
// ---------------------------------------------------------------------------

export type DocumentSnapshotSummary = {
  documentType: RegisteredDocumentTypeCode;
  /**
   * P6-09 — the *localized* catalog label. Never the raw `documents.catalog.*`
   * key: the confirmation card renders this verbatim, and an untranslated
   * identifier degrades the only human checkpoint a sensitive write has.
   */
  title: string;
  /** The catalog key `title` was resolved from, for tests and logging. */
  titleKey: string;
  /** The language the issued PDF will be rendered in. */
  locale: "ar" | "en";
  generatedAt: string;
  /** Short, structured, non-narrative facts the confirmation card can show. */
  highlights: { label: string; value: string }[];
  /**
   * P6-01 — the complete patient-visible / legally-binding authored content of
   * the document, verbatim and untruncated.
   *
   * §11 requires a sensitive write's preview to show "the exact patient-visible
   * or legally-binding content". For every data-derived type the body is a
   * rendering of clinic records the user can already inspect elsewhere, so the
   * structured highlights are the honest summary. `GENERIC_DOCUMENT` is the
   * exception: its whole body is free text the *model* composed, which is then
   * stamped with clinic branding, permanently numbered, and made externally
   * verifiable. Approving that blind is precisely what §11 legislates against,
   * so every authored block is projected here and rendered on the card.
   */
  body: { label: string; text: string }[];
};

/**
 * P6-01 — the ceiling on authored body text the Assistant will issue in one
 * document. The schema itself permits 60 blocks × 4 000 chars (240 KB), which no
 * confirmation card can meaningfully display. Rather than truncate silently —
 * which would put unshown text on a legally-framed artefact — the Assistant path
 * refuses above this cap and tells the user to author the document in the UI,
 * where they can read the whole body themselves before issuing.
 */
export const MAX_ASSISTANT_AUTHORED_BODY_CHARS = 20_000;

/**
 * Projects the authored, patient-visible body of a resolved snapshot. Empty for
 * every type whose content is derived from clinic records rather than composed.
 */
function snapshotBody(
  code: RegisteredDocumentTypeCode,
  snapshot: unknown,
): { label: string; text: string }[] {
  if (code !== GENERIC_DOCUMENT_CODE) return [];
  const row = (snapshot ?? {}) as { title?: unknown; blocks?: unknown };
  const body: { label: string; text: string }[] = [];
  if (typeof row.title === "string") {
    body.push({ label: "document title", text: row.title });
  }
  if (Array.isArray(row.blocks)) {
    row.blocks.forEach((block, index) => {
      const entry = block as { kind?: unknown; text?: unknown };
      if (typeof entry.text !== "string") return;
      const kind = entry.kind === "heading" ? "heading" : "paragraph";
      body.push({ label: `body ${index + 1} (${kind})`, text: entry.text });
    });
  }
  return body;
}

export function authoredBodyLength(
  body: readonly { text: string }[] | undefined,
): number {
  return (body ?? []).reduce((total, entry) => total + entry.text.length, 0);
}

function snapshotHighlights(snapshot: unknown): { label: string; value: string }[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const row = snapshot as Record<string, unknown>;
  const highlights: { label: string; value: string }[] = [];
  const range = row.range as Record<string, unknown> | undefined;
  if (range && typeof range === "object") {
    if (typeof range.from === "string") highlights.push({ label: "from", value: range.from });
    if (typeof range.to === "string") highlights.push({ label: "to", value: range.to });
  }
  if (typeof row.from === "string") highlights.push({ label: "from", value: row.from });
  if (typeof row.to === "string") highlights.push({ label: "to", value: row.to });
  const subject = row.subject as Record<string, unknown> | undefined;
  if (subject && typeof subject.fullName === "string") {
    highlights.push({ label: "subject", value: subject.fullName });
  }
  const patient = row.patient as Record<string, unknown> | undefined;
  if (patient && typeof patient.fullName === "string") {
    highlights.push({ label: "patient", value: patient.fullName });
  }
  if (typeof row.title === "string") highlights.push({ label: "title", value: row.title });
  return highlights.slice(0, 6);
}

/**
 * Resolve (but never issue) a document snapshot for a validated params object.
 * This is the read half of the §10 slot-filling loop: it proves the document can
 * be produced and returns a structured summary for the preview card.
 */
export async function previewDocumentCore(
  user: AuthedUser,
  code: RegisteredDocumentTypeCode,
  params: unknown,
  options: { locale?: "ar" | "en" } = {},
): Promise<DomainMutationResult<DocumentSnapshotSummary>> {
  const locale = options.locale ?? "en";
  const access = await assertDocumentTypeAccess(user, code);
  if (!access.ok) return access;
  const parsed = documentParamsSchema(code).safeParse(params);
  if (!parsed.success) {
    return domainFailure("invalidInput", {
      validationError: parsed.error,
    });
  }
  try {
    const family = documentIssueFamily(code);
    const snapshot =
      family === "revenue"
        ? await resolveRevenueDocumentSnapshot(user, parsed.data as RevenueDocumentParams)
        : family === "analytical"
          ? await resolveAnalyticalDocumentSnapshot(
              user,
              parsed.data as AnalyticalDocumentParams,
            )
          : family === "roster_profile"
            ? await resolveRosterProfileDocumentSnapshot(
                user,
                parsed.data as RosterProfileDocumentParams,
              )
            : family === "invoice"
              ? await resolveInvoiceDocumentSnapshot(
                  user.clinicId,
                  parsed.data as InvoiceDocumentParams,
                )
              : family === "patient_history"
                ? await resolvePatientHistoryDocumentSnapshot(
                    user,
                    parsed.data as PatientHistoryDocumentParams,
                  )
                : family === "clinical"
                  ? await resolveClinicalDocumentSnapshot(
                      user,
                      parsed.data as ClinicalDocumentParams,
                      { allowDraft: true },
                    )
                  : await resolveGenericDocumentSnapshot(
                      user,
                      parsed.data as GenericDocumentParams,
                    );
    const generatedAt =
      typeof (snapshot as { generatedAt?: unknown }).generatedAt === "string"
        ? (snapshot as { generatedAt: string }).generatedAt
        : new Date().toISOString();
    const titleKey = getDocumentCatalogEntry(code).titleKey;
    return domainSuccess(
      {
        documentType: code,
        title: await getDocumentTypeLabel(code, locale),
        titleKey,
        locale,
        generatedAt,
        highlights: snapshotHighlights(snapshot),
        body: snapshotBody(code, snapshot),
      },
      { targetTable: "documents" },
    );
  } catch (error) {
    // P6-12 — separate "resolved to nothing" from "the resolution failed".
    // Collapsing both into `previewFailed` told a user who named a patient the
    // Assistant cannot see that the problem was temporary, burned a retry on a
    // permanently failing call, and recorded `transient_failure` on the receipt
    // for what was a scope miss.
    if (isDocumentSubjectNotFoundError(error)) {
      console.warn("document_preview_subject_not_found", {
        clinicId: user.clinicId,
        documentType: code,
        subject: error.subject,
      });
      return domainFailure("documentSubjectNotFound");
    }
    console.error("document_preview_core_failed", {
      clinicId: user.clinicId,
      documentType: code,
      message: error instanceof Error ? error.message : "unknown",
    });
    return domainFailure("previewFailed");
  }
}

export type IssueDocumentCoreInput = {
  documentType: string;
  params: unknown;
  locale: "ar" | "en";
  idempotencyKey: string;
  attachmentKeys?: string[];
};

/**
 * The Assistant's single write entry point for every document type. Dispatches
 * to the same per-family core the matching server action calls, after
 * re-asserting the type's own application authorization.
 *
 * `mode: "preview"` resolves the snapshot only. Nothing is written, no
 * numbering sequence is consumed, and no PDF is stored.
 */
export async function issueDocumentCore(
  user: AuthedUser,
  input: IssueDocumentCoreInput,
  mode: DomainMutationMode = "execute",
  finalizeClinicalRecord?: ClinicalRecordFinalizer,
): Promise<DomainMutationResult<DocumentIssueCoreData | DocumentSnapshotSummary>> {
  if (!isRegisteredDocumentType(input.documentType)) {
    return domainFailure("documentTypeUnknown");
  }
  const code = input.documentType;
  const access = await assertDocumentTypeAccess(user, code);
  if (!access.ok) return access;
  if (mode === "preview") {
    return previewDocumentCore(user, code, input.params, { locale: input.locale });
  }

  const common: DocumentIssueCommonInput = {
    locale: input.locale,
    idempotencyKey: input.idempotencyKey,
  };
  const params = (input.params ?? {}) as Record<string, unknown>;
  switch (documentIssueFamily(code)) {
    case "revenue":
      return issueRevenueDocumentCore(user, {
        ...(params as unknown as RevenueDocumentParams),
        ...common,
      });
    case "analytical":
      return issueAnalyticalDocumentCore(user, {
        ...(params as unknown as AnalyticalDocumentParams),
        documentType: code as P74AnalyticalDocumentCode,
        ...common,
      });
    case "roster_profile":
      return issueRosterProfileDocumentCore(user, {
        ...(params as unknown as RosterProfileDocumentParams),
        documentType: code as P75RosterProfileDocumentCode,
        ...common,
        attachmentKeys: input.attachmentKeys ?? [],
      });
    case "invoice":
      return issueInvoiceDocumentCore(user, {
        ...(params as unknown as InvoiceDocumentParams),
        locale: input.locale,
      });
    case "patient_history":
      return issuePatientHistoryDocumentCore(user, {
        ...(params as unknown as PatientHistoryDocumentParams),
        documentType: code as P712PatientHistoryDocumentCode,
        ...common,
      });
    case "clinical":
      return issueClinicalDocumentCore(
        user,
        {
          ...(params as unknown as ClinicalDocumentParams),
          documentType: code as ClinicalDocumentParams["documentType"],
          locale: input.locale,
        },
        finalizeClinicalRecord ??
          ((table, recordId) =>
            finalizeClinicalRecordForIssue(user, table, recordId)),
      );
    case "generic":
      return issueGenericDocumentCore(user, {
        ...(params as unknown as GenericDocumentParams),
        ...common,
      });
  }
}
