import "server-only";

import { ClinicalDocument } from "@/components/documents/templates/clinical-documents";
import { getClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { parseClinicalDocumentSnapshot } from "@/lib/documents/resolvers/clinical-document";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedClinicalDocumentPdf(reservation: DocumentIssueReservation) {
  const snapshot = parseClinicalDocumentSnapshot(reservation.snapshot);
  if (reservation.documentType !== snapshot.documentType) {
    throw new Error("Clinical reservation type does not match its snapshot");
  }
  const copy = getClinicalDocumentCopy(reservation.locale, snapshot.documentType);
  const qrDataUrl = snapshot.settings.qrEnabled
    ? await generateDocumentVerificationQrDataUrl(reservation.verificationToken)
    : null;
  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <ClinicalDocument locale={reservation.locale}
        lifecycle={reservation.presentationLifecycle ?? "issued"} snapshot={snapshot}
        copy={copy} documentNumber={reservation.documentNumber} qrDataUrl={qrDataUrl}
        renderContextBoundary={renderContextBoundary} />
    ),
  });
}
