import "server-only";

import { InvoiceDocument } from "@/components/documents/templates/invoice";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import { parseInvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedInvoicePdf(
  reservation: DocumentIssueReservation,
) {
  const snapshot = parseInvoiceDocumentSnapshot(reservation.snapshot);
  const [copy, qrDataUrl] = await Promise.all([
    getInvoiceCopy(reservation.locale),
    snapshot.settings.qrEnabled
      ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
      : Promise.resolve(null),
  ]);

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
