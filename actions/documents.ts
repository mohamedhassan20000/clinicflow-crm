"use server";

import { z } from "zod";
import { notFound } from "next/navigation";
import { requireActiveSubscription } from "@/lib/billing/subscriptions";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { documentPdfHref } from "@/lib/documents/module";
import {
  issueAnalyticalDocumentCore,
  issueInvoiceDocumentCore,
  issuePatientHistoryDocumentCore,
  issueRevenueDocumentCore,
  issueRosterProfileDocumentCore,
  type DocumentIssueCoreData,
} from "@/lib/documents/mutations";
import type { DomainMutationResult } from "@/lib/domain-mutations";
import {
  analyticalDocumentParamsSchema,
  parseAnalyticalDocumentSnapshot,
  resolveAnalyticalDocumentSnapshot,
  type AnalyticalDocumentParams,
  type AnalyticalDocumentSnapshot,
  type P74AnalyticalDocumentCode,
} from "@/lib/documents/resolvers/analytical-report";
import {
  parseRevenueDocumentSnapshot,
  resolveRevenueDocumentSnapshot,
  revenueDocumentParamsSchema,
  type RevenueDocumentParams,
  type RevenueDocumentSnapshot,
} from "@/lib/documents/resolvers/revenue-report";
import {
  listRosterProfileAttachmentOptions,
  parseRosterProfileDocumentSnapshot,
  resolveRosterProfileDocumentSnapshot,
  rosterProfileDocumentParamsSchema,
  type P75RosterProfileDocumentCode,
  type RosterProfileAttachment,
  type RosterProfileDocumentParams,
  type RosterProfileDocumentSnapshot,
} from "@/lib/documents/resolvers/roster-profile";
import {
  invoiceDocumentParamsSchema,
  parseInvoiceDocumentSnapshot,
  resolveInvoiceDocumentSnapshot,
  type InvoiceDocumentParams,
  type InvoiceDocumentSnapshot,
} from "@/lib/documents/resolvers/invoice";
import {
  parsePatientHistoryDocumentSnapshot,
  patientHistoryDocumentParamsSchema,
  resolvePatientHistoryDocumentSnapshot,
  type P712PatientHistoryDocumentCode,
  type PatientHistoryDocumentParams,
  type PatientHistoryDocumentSnapshot,
} from "@/lib/documents/resolvers/patient-history";
import { requireUser } from "@/lib/rbac";
import { requireReportAccess, requireReportsIndexAccess } from "@/lib/reports/access";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 6 — the issuance bodies moved to `lib/documents/mutations.ts` so the
 * Assistant's `documents.issue` action runs the identical code. These server
 * actions keep their session guard, subscription check, and UI error codes and
 * are now thin adapters over the shared cores.
 */
function toIssueActionResult(
  result: DomainMutationResult<DocumentIssueCoreData>,
):
  | { data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode } {
  if (!result.ok) {
    return {
      errorCode: result.code === "invalidInput" ? "invalidInput" : "issueFailed",
    };
  }
  return {
    data: {
      documentId: result.data.documentId,
      documentNumber: result.data.documentNumber,
      reused: result.data.reused,
    },
  };
}

const localeSchema = z.enum(["ar", "en"]);
const issueRevenueSchema = revenueDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  idempotencyKey: z.string().uuid(),
  draftId: z.string().uuid().optional(),
}));
const documentIdSchema = z.string().uuid();
const issueAnalyticalSchema = analyticalDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  idempotencyKey: z.string().uuid(),
  draftId: z.string().uuid().optional(),
}));
const attachmentKeysSchema = z.array(z.string().min(1).max(500)).max(10).default([]);
const issueRosterProfileSchema = rosterProfileDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  idempotencyKey: z.string().uuid(),
  attachmentKeys: attachmentKeysSchema,
  draftId: z.string().uuid().optional(),
}));
const issueInvoiceSchema = invoiceDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  draftId: z.string().uuid().optional(),
}));
const issuePatientHistorySchema = patientHistoryDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  idempotencyKey: z.string().uuid(),
  draftId: z.string().uuid().optional(),
}));

export type DocumentActionErrorCode =
  | "invalidInput"
  | "previewFailed"
  | "issueFailed"
  | "documentNotFound"
  | "reprintFailed";

export type DocumentReprintFailureStage =
  | "storedPdfLookup"
  | "signedUrlCreation";

export type RevenueDocumentHistoryEvent = {
  id: string;
  event: string;
  occurredAt: string;
  actorName: string | null;
};

export type IssuedRevenueDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: RevenueDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: RevenueDocumentHistoryEvent[];
};

export async function previewRevenueReportDocument(
  input: RevenueDocumentParams,
): Promise<
  { data: RevenueDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const user = await requireReportAccess("revenue");
  const parsed = revenueDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  try {
    return {
      data: await resolveRevenueDocumentSnapshot(user, parsed.data),
    };
  } catch (error) {
    console.error("revenue_document_preview_failed", {
      clinicId: user.clinicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issueRevenueReportDocument(
  input: RevenueDocumentParams & { locale: "ar" | "en"; idempotencyKey: string; draftId?: string },
): Promise<
  | {
    data: {
      documentId: string;
      documentNumber: string;
      reused: boolean;
    };
    errorCode?: never;
  }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const user = await requireReportAccess("revenue");
  await requireActiveSubscription(user.clinicId);
  const parsed = issueRevenueSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  return toIssueActionResult(
    await issueRevenueDocumentCore(user, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    }),
  );
}

export async function getIssuedRevenueDocument(
  documentId: string,
): Promise<
  { data: IssuedRevenueDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const user = await requireReportAccess("revenue");
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "documentNotFound" };
  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count",
    )
    .eq("clinic_id", user.clinicId)
    .eq("doc_type", "REVENUE_REPORT")
    .eq("id", parsedId.data)
    .maybeSingle();
  if (error || !document || !document.issued_at || !document.page_count) {
    return { errorCode: "documentNotFound" };
  }
  if (
    document.status !== "issued"
    && document.status !== "void"
    && document.status !== "cancelled"
  ) return { errorCode: "documentNotFound" };
  if (document.locale !== "ar" && document.locale !== "en") {
    return { errorCode: "documentNotFound" };
  }

  try {
    const { data: eventRows, error: eventsError } = await supabase
      .from("document_events")
      .select("id, event, actor_id, occurred_at")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: true });
    if (eventsError) throw eventsError;

    const actorIds = Array.from(new Set([
      document.issued_by,
      ...(eventRows ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : []),
    ]));
    const { data: actors, error: actorsError } = actorIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    if (actorsError) throw actorsError;
    const actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));

    return {
      data: {
        id: document.id,
        documentNumber: document.document_number,
        verificationToken: document.verification_token,
        status: document.status,
        locale: document.locale,
        snapshot: parseRevenueDocumentSnapshot(document.snapshot),
        issuedAt: document.issued_at,
        issuedBy: actorNames.get(document.issued_by) ?? null,
        printCount: document.print_count,
        pageCount: document.page_count,
        events: (eventRows ?? []).map((event) => ({
          id: event.id,
          event: event.event,
          occurredAt: event.occurred_at,
          actorName: event.actor_id ? actorNames.get(event.actor_id) ?? null : null,
        })),
      },
    };
  } catch (historyError) {
    console.error("revenue_document_history_failed", {
      clinicId: user.clinicId,
      documentId,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintRevenueReportDocument(
  documentId: string,
): Promise<
  | { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const user = await requireReportAccess("revenue");
  await requireActiveSubscription(user.clinicId);
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "invalidInput" };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "record_revenue_document_reprint",
      { p_document_id: parsedId.data },
    );
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return {
      data: {
        url: documentPdfHref(parsedId.data),
        documentNumber: row.document_number,
        printCount: row.print_count,
      },
    };
  } catch (error) {
    console.error("revenue_document_reprint_failed", {
      clinicId: user.clinicId,
      documentId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed" };
  }
}

const P74_REPORT_ACCESS = {
  FOLLOW_UP_PAGE_REPORT: "followups",
  CANCELLATION_REPORT: "cancellations",
  NO_SHOW_REPORT: "no_shows",
  DOCTOR_PERFORMANCE_REPORT: "doctor_performance",
  RECEPTIONIST_PERFORMANCE_REPORT: "receptionist_performance",
} as const;

async function requireAnalyticalDocumentAccess(
  documentType: P74AnalyticalDocumentCode,
) {
  if (documentType in P74_REPORT_ACCESS) {
    return requireReportAccess(
      P74_REPORT_ACCESS[documentType as keyof typeof P74_REPORT_ACCESS],
    );
  }
  const { user } = await requireReportsIndexAccess();
  const catalog = getDocumentCatalogEntry(documentType);
  if (!catalog.pageRoles.includes(user.role)) notFound();
  return user;
}

export type AnalyticalDocumentHistoryEvent = RevenueDocumentHistoryEvent;

export type IssuedAnalyticalDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: AnalyticalDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: AnalyticalDocumentHistoryEvent[];
};

export async function previewAnalyticalReportDocument(
  input: AnalyticalDocumentParams,
): Promise<
  { data: AnalyticalDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = analyticalDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireAnalyticalDocumentAccess(parsed.data.documentType);
  try {
    return { data: await resolveAnalyticalDocumentSnapshot(user, parsed.data) };
  } catch (error) {
    console.error("analytical_document_preview_failed", {
      clinicId: user.clinicId,
      documentType: parsed.data.documentType,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issueAnalyticalReportDocument(
  input: AnalyticalDocumentParams & { locale: "ar" | "en"; idempotencyKey: string; draftId?: string },
): Promise<
  | { data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = issueAnalyticalSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireAnalyticalDocumentAccess(parsed.data.documentType);
  await requireActiveSubscription(user.clinicId);
  return toIssueActionResult(
    await issueAnalyticalDocumentCore(user, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    }),
  );
}

export async function getIssuedAnalyticalDocument(
  documentId: string,
  documentType: P74AnalyticalDocumentCode,
): Promise<
  { data: IssuedAnalyticalDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  const parsedType = analyticalDocumentParamsSchema.shape.documentType.safeParse(documentType);
  if (!parsedId.success || !parsedType.success) {
    return { errorCode: "documentNotFound" };
  }
  const user = await requireAnalyticalDocumentAccess(parsedType.data);
  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count",
    )
    .eq("clinic_id", user.clinicId)
    .eq("doc_type", parsedType.data)
    .eq("id", parsedId.data)
    .maybeSingle();

  if (error || !document || !document.issued_at || !document.page_count) {
    return { errorCode: "documentNotFound" };
  }
  if (
    (document.status !== "issued"
      && document.status !== "void"
      && document.status !== "cancelled")
    || (document.locale !== "ar" && document.locale !== "en")
  ) return { errorCode: "documentNotFound" };

  try {
    const snapshot = parseAnalyticalDocumentSnapshot(document.snapshot);
    if (snapshot.documentType !== parsedType.data) {
      return { errorCode: "documentNotFound" };
    }
    const { data: eventRows, error: eventsError } = await supabase
      .from("document_events")
      .select("id, event, actor_id, occurred_at")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: true });
    if (eventsError) throw eventsError;

    const actorIds = Array.from(new Set([
      document.issued_by,
      ...(eventRows ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : []),
    ]));
    const { data: actors, error: actorsError } = actorIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    if (actorsError) throw actorsError;
    const actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));

    return {
      data: {
        id: document.id,
        documentNumber: document.document_number,
        verificationToken: document.verification_token,
        status: document.status,
        locale: document.locale,
        snapshot,
        issuedAt: document.issued_at,
        issuedBy: actorNames.get(document.issued_by) ?? null,
        printCount: document.print_count,
        pageCount: document.page_count,
        events: (eventRows ?? []).map((event) => ({
          id: event.id,
          event: event.event,
          occurredAt: event.occurred_at,
          actorName: event.actor_id ? actorNames.get(event.actor_id) ?? null : null,
        })),
      },
    };
  } catch (historyError) {
    console.error("analytical_document_history_failed", {
      clinicId: user.clinicId,
      documentId,
      documentType: parsedType.data,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintAnalyticalReportDocument(
  documentId: string,
  documentType: P74AnalyticalDocumentCode,
): Promise<
  | { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  const parsedType = analyticalDocumentParamsSchema.shape.documentType.safeParse(documentType);
  if (!parsedId.success || !parsedType.success) return { errorCode: "invalidInput" };
  const user = await requireAnalyticalDocumentAccess(parsedType.data);
  await requireActiveSubscription(user.clinicId);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "record_analytical_document_reprint",
      { p_document_id: parsedId.data },
    );
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return {
      data: {
        url: documentPdfHref(parsedId.data),
        documentNumber: row.document_number,
        printCount: row.print_count,
      },
    };
  } catch (error) {
    console.error("analytical_document_reprint_failed", {
      clinicId: user.clinicId,
      documentId,
      documentType: parsedType.data,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed" };
  }
}

async function requireRosterProfileDocumentAccess(documentType: P75RosterProfileDocumentCode) {
  const user = await requireUser();
  const catalog = getDocumentCatalogEntry(documentType);
  if (!catalog.pageRoles.includes(user.role)) notFound();
  return user;
}

export type IssuedRosterProfileDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: RosterProfileDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: RevenueDocumentHistoryEvent[];
};

export async function previewRosterProfileDocument(input: RosterProfileDocumentParams): Promise<
  { data: RosterProfileDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = rosterProfileDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireRosterProfileDocumentAccess(parsed.data.documentType);
  try {
    return { data: await resolveRosterProfileDocumentSnapshot(user, parsed.data) };
  } catch (error) {
    console.error("roster_profile_document_preview_failed", {
      clinicId: user.clinicId, documentType: parsed.data.documentType,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function getRosterProfileAttachmentOptions(
  input: RosterProfileDocumentParams,
): Promise<{ data: RosterProfileAttachment[]; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsed = rosterProfileDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireRosterProfileDocumentAccess(parsed.data.documentType);
  try {
    return { data: await listRosterProfileAttachmentOptions(user, parsed.data) };
  } catch (error) {
    console.error("roster_profile_attachment_options_failed", {
      clinicId: user.clinicId, documentType: parsed.data.documentType,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issueRosterProfileDocument(input: RosterProfileDocumentParams & {
  locale: "ar" | "en"; idempotencyKey: string; attachmentKeys?: string[]; draftId?: string;
}): Promise<{ data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsed = issueRosterProfileSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireRosterProfileDocumentAccess(parsed.data.documentType);
  await requireActiveSubscription(user.clinicId);
  return toIssueActionResult(
    await issueRosterProfileDocumentCore(user, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    }),
  );
}

export async function getIssuedRosterProfileDocument(
  documentId: string,
  documentType: P75RosterProfileDocumentCode,
): Promise<{ data: IssuedRosterProfileDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsedId = documentIdSchema.safeParse(documentId);
  const parsedType = rosterProfileDocumentParamsSchema.safeParse({ documentType,
    patientId: documentType === "PATIENT_FILE" ? "00000000-0000-0000-0000-000000000000" : undefined,
    staffId: documentType === "STAFF_FILE" ? "00000000-0000-0000-0000-000000000000" : undefined });
  if (!parsedId.success || !parsedType.success) return { errorCode: "documentNotFound" };
  const user = await requireRosterProfileDocumentAccess(documentType);
  const supabase = await createClient();
  const { data: document, error } = await supabase.from("documents")
    .select("id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count")
    .eq("clinic_id", user.clinicId).eq("doc_type", documentType).eq("id", parsedId.data).maybeSingle();
  if (error || !document || !document.issued_at || !document.page_count
    || !["issued", "void", "cancelled"].includes(document.status)
    || (document.locale !== "ar" && document.locale !== "en")) return { errorCode: "documentNotFound" };
  try {
    const snapshot = parseRosterProfileDocumentSnapshot(document.snapshot);
    if (snapshot.documentType !== documentType) return { errorCode: "documentNotFound" };
    const { data: eventRows, error: eventsError } = await supabase.from("document_events")
      .select("id, event, actor_id, occurred_at").eq("document_id", document.id).order("occurred_at");
    if (eventsError) throw eventsError;
    const actorIds = Array.from(new Set([document.issued_by,
      ...(eventRows ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : [])]));
    const { data: actors, error: actorsError } = actorIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    if (actorsError) throw actorsError;
    const names = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));
    return { data: {
      id: document.id, documentNumber: document.document_number,
      verificationToken: document.verification_token,
      status: document.status as "issued" | "void" | "cancelled", locale: document.locale,
      snapshot, issuedAt: document.issued_at, issuedBy: names.get(document.issued_by) ?? null,
      printCount: document.print_count, pageCount: document.page_count,
      events: (eventRows ?? []).map((event) => ({ id: event.id, event: event.event,
        occurredAt: event.occurred_at, actorName: event.actor_id ? names.get(event.actor_id) ?? null : null })),
    } };
  } catch (historyError) {
    console.error("roster_profile_document_history_failed", {
      clinicId: user.clinicId, documentId, documentType,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintRosterProfileDocument(
  documentId: string, documentType: P75RosterProfileDocumentCode,
): Promise<{ data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "invalidInput" };
  const user = await requireRosterProfileDocumentAccess(documentType);
  await requireActiveSubscription(user.clinicId);
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("record_roster_profile_document_reprint", { p_document_id: parsedId.data });
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return { data: { url: documentPdfHref(parsedId.data), documentNumber: row.document_number, printCount: row.print_count } };
  } catch (error) {
    console.error("roster_profile_document_reprint_failed", {
      clinicId: user.clinicId, documentId, documentType,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed" };
  }
}

async function requireInvoiceDocumentAccess() {
  const user = await requireUser();
  const catalog = getDocumentCatalogEntry("INVOICE");
  if (!catalog.pageRoles.includes(user.role)) notFound();
  return user;
}

export type IssuedInvoiceDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: InvoiceDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: RevenueDocumentHistoryEvent[];
};

export async function previewInvoiceDocument(
  input: InvoiceDocumentParams,
): Promise<
  { data: InvoiceDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = invoiceDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireInvoiceDocumentAccess();
  try {
    return { data: await resolveInvoiceDocumentSnapshot(user.clinicId, parsed.data) };
  } catch (error) {
    console.error("invoice_document_preview_failed", {
      clinicId: user.clinicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issueInvoiceReportDocument(
  input: InvoiceDocumentParams & { locale: "ar" | "en"; draftId?: string },
): Promise<
  | { data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = issueInvoiceSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireInvoiceDocumentAccess();
  await requireActiveSubscription(user.clinicId);
  return toIssueActionResult(
    await issueInvoiceDocumentCore(user, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    }),
  );
}

export async function getIssuedInvoiceDocument(
  documentId: string,
): Promise<
  { data: IssuedInvoiceDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "documentNotFound" };
  const user = await requireInvoiceDocumentAccess();
  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count",
    )
    .eq("clinic_id", user.clinicId)
    .eq("doc_type", "INVOICE")
    .eq("id", parsedId.data)
    .maybeSingle();
  if (error || !document || !document.issued_at || !document.page_count) {
    return { errorCode: "documentNotFound" };
  }
  if (
    (document.status !== "issued"
      && document.status !== "void"
      && document.status !== "cancelled")
    || (document.locale !== "ar" && document.locale !== "en")
  ) return { errorCode: "documentNotFound" };

  try {
    const { data: eventRows, error: eventsError } = await supabase
      .from("document_events")
      .select("id, event, actor_id, occurred_at")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: true });
    if (eventsError) throw eventsError;

    const actorIds = Array.from(new Set([
      document.issued_by,
      ...(eventRows ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : []),
    ]));
    const { data: actors, error: actorsError } = actorIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    if (actorsError) throw actorsError;
    const actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));

    return {
      data: {
        id: document.id,
        documentNumber: document.document_number,
        verificationToken: document.verification_token,
        status: document.status,
        locale: document.locale,
        snapshot: parseInvoiceDocumentSnapshot(document.snapshot),
        issuedAt: document.issued_at,
        issuedBy: actorNames.get(document.issued_by) ?? null,
        printCount: document.print_count,
        pageCount: document.page_count,
        events: (eventRows ?? []).map((event) => ({
          id: event.id,
          event: event.event,
          occurredAt: event.occurred_at,
          actorName: event.actor_id ? actorNames.get(event.actor_id) ?? null : null,
        })),
      },
    };
  } catch (historyError) {
    console.error("invoice_document_history_failed", {
      clinicId: user.clinicId,
      documentId,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintInvoiceDocument(
  documentId: string,
): Promise<
  | { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "invalidInput" };
  const user = await requireInvoiceDocumentAccess();
  await requireActiveSubscription(user.clinicId);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "record_invoice_document_reprint",
      { p_document_id: parsedId.data },
    );
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return {
      data: {
        url: documentPdfHref(parsedId.data),
        documentNumber: row.document_number,
        printCount: row.print_count,
      },
    };
  } catch (error) {
    console.error("invoice_document_reprint_failed", {
      clinicId: user.clinicId,
      documentId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed" };
  }
}

// ---------------------------------------------------------------------------
// P7-12 — patient history & financial documents
// ---------------------------------------------------------------------------

async function requirePatientHistoryDocumentAccess(
  documentType: P712PatientHistoryDocumentCode,
) {
  const user = await requireUser();
  const catalog = getDocumentCatalogEntry(documentType);
  if (!catalog.pageRoles.includes(user.role)) notFound();
  return user;
}

export type IssuedPatientHistoryDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: PatientHistoryDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: RevenueDocumentHistoryEvent[];
};

export async function previewPatientHistoryDocument(
  input: PatientHistoryDocumentParams,
): Promise<
  { data: PatientHistoryDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = patientHistoryDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requirePatientHistoryDocumentAccess(parsed.data.documentType);
  try {
    return { data: await resolvePatientHistoryDocumentSnapshot(user, parsed.data) };
  } catch (error) {
    console.error("patient_history_document_preview_failed", {
      clinicId: user.clinicId,
      documentType: parsed.data.documentType,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issuePatientHistoryDocument(
  input: PatientHistoryDocumentParams & { locale: "ar" | "en"; idempotencyKey: string; draftId?: string },
): Promise<
  | { data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = issuePatientHistorySchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requirePatientHistoryDocumentAccess(parsed.data.documentType);
  await requireActiveSubscription(user.clinicId);
  return toIssueActionResult(
    await issuePatientHistoryDocumentCore(user, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    }),
  );
}

export async function getIssuedPatientHistoryDocument(
  documentId: string,
  documentType: P712PatientHistoryDocumentCode,
): Promise<
  { data: IssuedPatientHistoryDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  const parsedType = patientHistoryDocumentParamsSchema.shape.documentType.safeParse(documentType);
  if (!parsedId.success || !parsedType.success) return { errorCode: "documentNotFound" };
  const user = await requirePatientHistoryDocumentAccess(parsedType.data);
  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count",
    )
    .eq("clinic_id", user.clinicId)
    .eq("doc_type", parsedType.data)
    .eq("id", parsedId.data)
    .maybeSingle();
  if (
    error || !document || !document.issued_at || !document.page_count
    || !["issued", "void", "cancelled"].includes(document.status)
    || (document.locale !== "ar" && document.locale !== "en")
  ) return { errorCode: "documentNotFound" };

  try {
    const snapshot = parsePatientHistoryDocumentSnapshot(document.snapshot);
    if (snapshot.documentType !== parsedType.data) return { errorCode: "documentNotFound" };
    const { data: eventRows, error: eventsError } = await supabase
      .from("document_events")
      .select("id, event, actor_id, occurred_at")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: true });
    if (eventsError) throw eventsError;

    const actorIds = Array.from(new Set([
      document.issued_by,
      ...(eventRows ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : []),
    ]));
    const { data: actors, error: actorsError } = actorIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    if (actorsError) throw actorsError;
    const actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));

    return {
      data: {
        id: document.id,
        documentNumber: document.document_number,
        verificationToken: document.verification_token,
        status: document.status as "issued" | "void" | "cancelled",
        locale: document.locale,
        snapshot,
        issuedAt: document.issued_at,
        issuedBy: actorNames.get(document.issued_by) ?? null,
        printCount: document.print_count,
        pageCount: document.page_count,
        events: (eventRows ?? []).map((event) => ({
          id: event.id,
          event: event.event,
          occurredAt: event.occurred_at,
          actorName: event.actor_id ? actorNames.get(event.actor_id) ?? null : null,
        })),
      },
    };
  } catch (historyError) {
    console.error("patient_history_document_history_failed", {
      clinicId: user.clinicId,
      documentId,
      documentType,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintPatientHistoryDocument(
  documentId: string,
  documentType: P712PatientHistoryDocumentCode,
): Promise<
  | { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | {
    data?: never;
    errorCode: DocumentActionErrorCode;
    failureStage?: DocumentReprintFailureStage;
  }
> {
  const parsedId = documentIdSchema.safeParse(documentId);
  const parsedType = patientHistoryDocumentParamsSchema.shape.documentType.safeParse(documentType);
  if (!parsedId.success || !parsedType.success) return { errorCode: "invalidInput" };
  const user = await requirePatientHistoryDocumentAccess(parsedType.data);
  await requireActiveSubscription(user.clinicId);

  const failureStage: DocumentReprintFailureStage = "storedPdfLookup";
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "record_patient_history_document_reprint",
      { p_document_id: parsedId.data },
    );
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    if (!row.pdf_storage_path?.trim()) {
      throw new Error("Canonical PDF storage path is missing");
    }
    return {
      data: {
        url: documentPdfHref(parsedId.data),
        documentNumber: row.document_number,
        printCount: row.print_count,
      },
    };
  } catch (error) {
    console.error("patient_history_document_reprint_failed", {
      clinicId: user.clinicId,
      documentId,
      documentType,
      stage: failureStage,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed", failureStage };
  }
}
