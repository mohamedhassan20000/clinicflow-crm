import "server-only";

import { RevenueReportDocument } from "@/components/documents/templates/revenue-report";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getRevenueReportCopy } from "@/lib/documents/revenue-copy";
import { parseRevenueDocumentSnapshot } from "@/lib/documents/resolvers/revenue-report";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedRevenueReportPdf(
  reservation: DocumentIssueReservation,
) {
  const snapshot = parseRevenueDocumentSnapshot(reservation.snapshot);
  const [copy, qrDataUrl] = await Promise.all([
    getRevenueReportCopy(reservation.locale),
    snapshot.settings.qrEnabled
      ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
      : Promise.resolve(null),
  ]);

  return renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <RevenueReportDocument
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
