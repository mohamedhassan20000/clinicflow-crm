import "server-only";

import { InvoiceDocument } from "@/components/documents/templates/invoice";
import {
  DocumentIssueError,
  type DocumentIssueReservation,
} from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import { parseInvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedInvoicePdf(
  reservation: DocumentIssueReservation,
) {
  let snapshot: ReturnType<typeof parseInvoiceDocumentSnapshot>;
  let copy: Awaited<ReturnType<typeof getInvoiceCopy>>;
  let qrDataUrl: string | null;
  try {
    snapshot = parseInvoiceDocumentSnapshot(reservation.snapshot);
    [copy, qrDataUrl] = await Promise.all([
      getInvoiceCopy(reservation.locale),
      snapshot.settings.qrEnabled
        ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
        : Promise.resolve(null),
    ]);
  } catch (error) {
    throw new DocumentIssueError("renderer-dispatch", error);
  }

  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <InvoiceDocument
        locale={reservation.locale}
        lifecycle={reservation.presentationLifecycle ?? "issued"}
        snapshot={snapshot}
        copy={copy}
        documentNumber={reservation.documentNumber}
        qrDataUrl={qrDataUrl}
        renderContextBoundary={renderContextBoundary}
      />
    ),
  });
}
