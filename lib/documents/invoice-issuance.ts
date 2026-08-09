import "server-only";

import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { issueDocumentFoundation } from "@/lib/documents/issuance";
import { getDocumentPdfRenderer } from "@/lib/documents/renderers/registry";
import { resolveInvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";
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
  const snapshot = await resolveInvoiceDocumentSnapshot(
    input.clinicId,
    { appointmentId: input.appointmentId },
    { inlineLogo: true },
  );
  const catalog = getDocumentCatalogEntry("INVOICE");
  const result = await issueDocumentFoundation({
    clinicId: input.clinicId,
    actorId: input.actorId,
    draftId: input.draftId,
    documentType: catalog.code,
    idempotencyKey: `invoice:${input.appointmentId}`,
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
    render: getDocumentPdfRenderer(catalog.code),
  });
  return {
    documentId: result.documentId,
    documentNumber: result.documentNumber,
    verificationToken: result.verificationToken,
    reused: result.reused,
  };
}
