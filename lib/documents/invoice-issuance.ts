import "server-only";

import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import {
  DocumentIssueError,
  finalizeDocumentDraft,
  issueDocumentFoundation,
} from "@/lib/documents/issuance";
import { getDocumentPdfRenderer } from "@/lib/documents/renderers/registry";
import { resolveInvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";
import { findCompletedClinicDocument } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

/**
 * Canonical per-appointment invoice issuance.
 *
 * The idempotency key is `invoice:<appointmentId>` with no random component, so
 * an appointment maps to exactly one immutable canonical invoice document —
 * whether it is issued from the invoice document UI or lazily during manual
 * "Send to patient" delivery. A second call always reuses the first document and
 * its frozen number, snapshot, and PDF.
 */
export async function issueInvoiceDocument(input: {
  clinicId: string;
  actorId: string;
  appointmentId: string;
  locale: "ar" | "en";
  draftId?: string;
}): Promise<{
  documentId: string;
  documentNumber: string;
  verificationToken: string;
  reused: boolean;
}> {
  const catalog = getDocumentCatalogEntry("INVOICE");
  const idempotencyKey = `invoice:${input.appointmentId}`;

  let existing: Awaited<ReturnType<typeof findCompletedClinicDocument>>;
  try {
    existing = await findCompletedClinicDocument({
      clinicId: input.clinicId,
      documentType: catalog.code,
      idempotencyKey,
    });
  } catch (error) {
    throw new DocumentIssueError("reservation", error);
  }
  if (existing.error) throw new DocumentIssueError("reservation", existing.error);
  if (existing.data) {
    await finalizeDocumentDraft({ ...input, documentId: existing.data.id });
    return {
      documentId: existing.data.id,
      documentNumber: existing.data.document_number,
      verificationToken: existing.data.verification_token,
      reused: true,
    };
  }

  let snapshot: Awaited<ReturnType<typeof resolveInvoiceDocumentSnapshot>>;
  try {
    snapshot = await resolveInvoiceDocumentSnapshot(
      input.clinicId,
      { appointmentId: input.appointmentId },
    );
  } catch (error) {
    throw new DocumentIssueError("invoice-data-resolution", error);
  }

  let render;
  try {
    render = getDocumentPdfRenderer(catalog.code);
  } catch (error) {
    throw new DocumentIssueError("renderer-dispatch", error);
  }
  const result = await issueDocumentFoundation({
    clinicId: input.clinicId,
    actorId: input.actorId,
    draftId: input.draftId,
    documentType: catalog.code,
    idempotencyKey,
    locale: input.locale,
    numberingPrefix: snapshot.settings.numberingPrefix,
    periodKey: snapshot.settings.numberingYearlyReset
      ? new Date(snapshot.generatedAt).getFullYear().toString()
      : "",
    sequencePadding: snapshot.settings.sequencePadding,
    params: {
      version: 1,
      appointmentId: input.appointmentId,
    },
    snapshot: snapshot as unknown as Json,
    watermark: snapshot.settings.watermark,
    appointmentId: input.appointmentId,
    render,
  });
  return {
    documentId: result.documentId,
    documentNumber: result.documentNumber,
    verificationToken: result.verificationToken,
    reused: result.reused,
  };
}
