import "server-only";

import { GenericDocument } from "@/components/documents/templates/generic-document";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getGenericDocumentCopy } from "@/lib/documents/generic-copy";
import { parseGenericDocumentSnapshot } from "@/lib/documents/resolvers/generic-document";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedGenericDocumentPdf(reservation: DocumentIssueReservation) {
  const snapshot = parseGenericDocumentSnapshot(reservation.snapshot);
  if (reservation.documentType !== snapshot.documentType) {
    throw new Error("Generic document reservation type does not match its snapshot");
  }
  const copy = getGenericDocumentCopy(reservation.locale);
  const qrDataUrl = snapshot.settings.qrEnabled
    ? await generateDocumentVerificationQrDataUrl(reservation.verificationToken)
    : null;
  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${snapshot.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <GenericDocument locale={reservation.locale}
        lifecycle={reservation.presentationLifecycle ?? "issued"}
        snapshot={snapshot} copy={copy} documentNumber={reservation.documentNumber}
        qrDataUrl={qrDataUrl} renderContextBoundary={renderContextBoundary} />
    ),
  });
}
