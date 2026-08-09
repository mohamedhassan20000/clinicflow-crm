import "server-only";

import { PatientHistoryDocument } from "@/components/documents/templates/patient-history-documents";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getPatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import {
  parsePatientHistoryDocumentSnapshot,
  type P712PatientHistoryDocumentCode,
} from "@/lib/documents/resolvers/patient-history";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedPatientHistoryPdf(
  reservation: DocumentIssueReservation,
) {
  const snapshot = parsePatientHistoryDocumentSnapshot(reservation.snapshot);
  if (reservation.documentType !== snapshot.documentType) {
    throw new Error("Patient-history reservation type does not match its snapshot");
  }
  const [copy, qrDataUrl] = await Promise.all([
    Promise.resolve(
      getPatientHistoryCopy(
        reservation.locale,
        snapshot.documentType as P712PatientHistoryDocumentCode,
      ),
    ),
    snapshot.settings.qrEnabled
      ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
      : Promise.resolve(null),
  ]);
  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <PatientHistoryDocument
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
