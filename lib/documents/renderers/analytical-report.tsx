import "server-only";

import { AnalyticalReportDocument } from "@/components/documents/templates/analytical-reports";
import { getAnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { parseAnalyticalDocumentSnapshot } from "@/lib/documents/resolvers/analytical-report";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedAnalyticalReportPdf(
  reservation: DocumentIssueReservation,
) {
  const snapshot = parseAnalyticalDocumentSnapshot(reservation.snapshot);
  if (reservation.documentType !== snapshot.documentType) {
    throw new Error("Analytical document reservation type does not match its snapshot");
  }
  const [copy, qrDataUrl] = await Promise.all([
    getAnalyticalReportCopy(reservation.locale, snapshot.documentType),
    snapshot.settings.qrEnabled
      ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
      : Promise.resolve(null),
  ]);

  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <AnalyticalReportDocument
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
