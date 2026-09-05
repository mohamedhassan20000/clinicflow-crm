"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import { requireActiveSubscription } from "@/lib/billing/subscriptions";
import { ensureClinicalRecordFinalizedForIssue } from "@/actions/clinical/_shared";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { issueClinicalDocumentCore } from "@/lib/documents/mutations";
import { documentPdfHref } from "@/lib/documents/module";
import { clinicalDocumentParamsSchema, parseClinicalDocumentSnapshot,
  resolveClinicalDocumentSnapshot, type ClinicalDocumentParams, type ClinicalDocumentSnapshot,
  type P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import { requireUser, type AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

const issueSchema = clinicalDocumentParamsSchema.and(z.object({
  locale: z.enum(["ar", "en"]),
  draftId: z.string().uuid().optional(),
}));
const documentIdSchema = z.string().uuid();
export type ClinicalDocumentActionError = "invalidInput" | "previewFailed" | "issueFailed"
  | "documentNotFound" | "reprintFailed" | "controlledMedicineBlocked";
export type IssuedClinicalDocument = { id: string; documentNumber: string; verificationToken: string;
  status: "issued" | "void" | "cancelled"; locale: "ar" | "en";
  snapshot: ClinicalDocumentSnapshot; issuedAt: string; issuedBy: string | null;
  printCount: number; pageCount: number; events: { id: string; event: string;
    occurredAt: string; actorName: string | null }[] };

async function requireClinicalDocumentAccess(documentType: P76ClinicalDocumentCode): Promise<AuthedUser> {
  const user = await requireUser();
  if (!getDocumentCatalogEntry(documentType).pageRoles.includes(user.role)) notFound();
  return user;
}

export async function previewClinicalDocument(input: ClinicalDocumentParams): Promise<
  { data: ClinicalDocumentSnapshot; errorCode?: never } | { data?: never; errorCode: ClinicalDocumentActionError }> {
  const parsed = clinicalDocumentParamsSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireClinicalDocumentAccess(parsed.data.documentType);
  try { return { data: await resolveClinicalDocumentSnapshot(user, parsed.data, { allowDraft: true }) }; }
  catch (error) {
    console.error("clinical_document_preview_failed", { clinicId: user.clinicId,
      documentType: parsed.data.documentType, message: error instanceof Error ? error.message : "unknown" });
    return { errorCode: "previewFailed" };
  }
}

export async function issueClinicalDocument(input: ClinicalDocumentParams & { locale: "ar" | "en"; draftId?: string }): Promise<
  { data: { documentId: string; documentNumber: string; reused: boolean }; errorCode?: never }
  | { data?: never; errorCode: ClinicalDocumentActionError }> {
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const user = await requireClinicalDocumentAccess(parsed.data.documentType);
  await requireActiveSubscription(user.clinicId);
  // Phase 6: the issuance body lives in `lib/documents/mutations.ts` so the
  // Assistant's `documents.issue` action runs identical code. The UI keeps its
  // own session-scoped finalizer, which enforces the mutation-role guard.
  const result = await issueClinicalDocumentCore(
    user,
    { ...parsed.data, draftId: parsed.data.draftId ?? null },
    async (table, recordId) => ({
      success:
        (await ensureClinicalRecordFinalizedForIssue(table, recordId)).success === true,
    }),
  );
  if (!result.ok) {
    return {
      errorCode:
        result.code === "controlledMedicineBlocked"
          ? "controlledMedicineBlocked"
          : result.code === "invalidInput"
            ? "invalidInput"
            : "issueFailed",
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

export async function getIssuedClinicalDocument(documentId: string, documentType: P76ClinicalDocumentCode): Promise<
  { data: IssuedClinicalDocument; errorCode?: never } | { data?: never; errorCode: ClinicalDocumentActionError }> {
  const id = documentIdSchema.safeParse(documentId);
  if (!id.success) return { errorCode: "documentNotFound" };
  const user = await requireClinicalDocumentAccess(documentType);
  const supabase = await createClient();
  const { data: document, error } = await supabase.from("documents")
    .select("id, document_number, verification_token, status, locale, snapshot, issued_at, issued_by, print_count, page_count")
    .eq("clinic_id", user.clinicId).eq("doc_type", documentType).eq("id", id.data).maybeSingle();
  if (error || !document || !document.issued_at || !document.page_count
    || !["issued", "void", "cancelled"].includes(document.status)
    || (document.locale !== "ar" && document.locale !== "en")) return { errorCode: "documentNotFound" };
  try {
    const snapshot = parseClinicalDocumentSnapshot(document.snapshot);
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
    return { data: { id: document.id, documentNumber: document.document_number,
      verificationToken: document.verification_token, status: document.status as "issued" | "void" | "cancelled",
      locale: document.locale, snapshot, issuedAt: document.issued_at,
      issuedBy: names.get(document.issued_by) ?? null, printCount: document.print_count,
      pageCount: document.page_count, events: (eventRows ?? []).map((event) => ({ id: event.id,
        event: event.event, occurredAt: event.occurred_at,
        actorName: event.actor_id ? names.get(event.actor_id) ?? null : null })) } };
  } catch { return { errorCode: "documentNotFound" }; }
}

export async function reprintClinicalDocument(documentId: string, documentType: P76ClinicalDocumentCode): Promise<
  { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | { data?: never; errorCode: ClinicalDocumentActionError }> {
  const id = documentIdSchema.safeParse(documentId);
  if (!id.success) return { errorCode: "invalidInput" };
  const user = await requireClinicalDocumentAccess(documentType);
  await requireActiveSubscription(user.clinicId);
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("record_clinical_document_reprint", { p_document_id: id.data });
    const row = data?.[0];
    if (error || !row) throw error ?? new Error("Reprint did not return a document");
    return { data: { url: documentPdfHref(id.data), documentNumber: row.document_number, printCount: row.print_count } };
  } catch (error) {
    console.error("clinical_document_reprint_failed", { clinicId: user.clinicId, documentId, documentType,
      message: error instanceof Error ? error.message : "unknown" });
    return { errorCode: "reprintFailed" };
  }
}
