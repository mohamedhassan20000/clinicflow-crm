"use server";

import { z } from "zod";
import { notFound } from "next/navigation";
import { requireActiveSubscription } from "@/lib/billing/subscriptions";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { issueDocumentFoundation } from "@/lib/documents/issuance";
import { documentPdfHref } from "@/lib/documents/module";
import { getDocumentPdfRenderer } from "@/lib/documents/renderers/registry";
import {
  GENERIC_DOCUMENT_CODE,
  genericDocumentParamsSchema,
  parseGenericDocumentSnapshot,
  resolveGenericDocumentSnapshot,
  type GenericDocumentParams,
  type GenericDocumentSnapshot,
} from "@/lib/documents/resolvers/generic-document";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import type { DocumentActionErrorCode, RevenueDocumentHistoryEvent } from "@/actions/documents";

const localeSchema = z.enum(["ar", "en"]);
const documentIdSchema = z.string().uuid();
const issueGenericSchema = genericDocumentParamsSchema.and(z.object({
  locale: localeSchema,
  idempotencyKey: z.string().uuid(),
  draftId: z.string().uuid().optional(),
}));

export type IssuedGenericDocument = {
  id: string;
  documentNumber: string;
  verificationToken: string;
  status: "issued" | "void" | "cancelled";
  locale: "ar" | "en";
  snapshot: GenericDocumentSnapshot;
  issuedAt: string;
  issuedBy: string | null;
  printCount: number;
  pageCount: number;
  events: RevenueDocumentHistoryEvent[];
};

async function requireGenericDocumentAccess() {
  const user = await requireUser();
  const catalog = getDocumentCatalogEntry(GENERIC_DOCUMENT_CODE);
  if (!catalog.pageRoles.includes(user.role)) notFound();
  return user;
}

export async function previewGenericDocument(input: GenericDocumentParams): Promise<
  { data: GenericDocumentSnapshot; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }
> {
  const parsed = genericDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireGenericDocumentAccess();
  try {
    return { data: await resolveGenericDocumentSnapshot(user, parsed.data) };
  } catch (error) {
    console.error("generic_document_preview_failed", {
      clinicId: user.clinicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "previewFailed" };
  }
}

export async function issueGenericDocument(input: GenericDocumentParams & {
  locale: "ar" | "en"; idempotencyKey: string; draftId?: string;
}): Promise<{ data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsed = issueGenericSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireGenericDocumentAccess();
  await requireActiveSubscription(user.clinicId);
  try {
    const snapshot = await resolveGenericDocumentSnapshot(user, parsed.data, { inlineAssets: true });
    const result = await issueDocumentFoundation({
      clinicId: user.clinicId,
      actorId: user.id,
      draftId: parsed.data.draftId,
      documentType: GENERIC_DOCUMENT_CODE,
      idempotencyKey: `generic-document:${parsed.data.idempotencyKey}`,
      locale: parsed.data.locale,
      numberingPrefix: snapshot.settings.numberingPrefix,
      periodKey: snapshot.settings.numberingYearlyReset
        ? new Date(snapshot.generatedAt).getFullYear().toString() : "",
      sequencePadding: snapshot.settings.sequencePadding,
      params: {
        version: 1, documentType: GENERIC_DOCUMENT_CODE,
        title: parsed.data.title, blocks: parsed.data.blocks,
      },
      snapshot: snapshot as unknown as Json,
      watermark: snapshot.settings.watermark,
      render: getDocumentPdfRenderer(GENERIC_DOCUMENT_CODE),
    });
    return { data: { documentId: result.documentId, documentNumber: result.documentNumber, reused: result.reused } };
  } catch (error) {
    console.error("generic_document_issue_failed", {
      clinicId: user.clinicId,
      stage: error && typeof error === "object" && "stage" in error ? String(error.stage) : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "issueFailed" };
  }
}

export async function getIssuedGenericDocument(
  documentId: string,
): Promise<{ data: IssuedGenericDocument; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "documentNotFound" };
  const user = await requireGenericDocumentAccess();
  const supabase = await createClient();
  const { data: document, error } = await supabase.from("documents")
    .select("id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count")
    .eq("clinic_id", user.clinicId).eq("doc_type", GENERIC_DOCUMENT_CODE).eq("id", parsedId.data).maybeSingle();
  if (error || !document || !document.issued_at || !document.page_count
    || !["issued", "void", "cancelled"].includes(document.status)
    || (document.locale !== "ar" && document.locale !== "en")) return { errorCode: "documentNotFound" };
  try {
    const snapshot = parseGenericDocumentSnapshot(document.snapshot);
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
    console.error("generic_document_history_failed", {
      clinicId: user.clinicId, documentId,
      message: historyError instanceof Error ? historyError.message : "unknown",
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function reprintGenericDocument(
  documentId: string,
): Promise<{ data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: DocumentActionErrorCode }> {
  const parsedId = documentIdSchema.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "invalidInput" };
  const user = await requireGenericDocumentAccess();
  await requireActiveSubscription(user.clinicId);
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("record_generic_document_reprint", { p_document_id: parsedId.data });
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return { data: { url: documentPdfHref(parsedId.data), documentNumber: row.document_number, printCount: row.print_count } };
  } catch (error) {
    console.error("generic_document_reprint_failed", {
      clinicId: user.clinicId, documentId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed" };
  }
}
