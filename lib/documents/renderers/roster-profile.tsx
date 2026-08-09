import "server-only";

import { RosterProfileDocument } from "@/components/documents/templates/roster-profile-documents";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { mergeRosterProfileAttachments } from "@/lib/documents/pdf/merge-attachments";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { getRosterProfileCopy } from "@/lib/documents/roster-profile-copy";
import { parseRosterProfileDocumentSnapshot } from "@/lib/documents/resolvers/roster-profile";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function renderIssuedRosterProfilePdf(reservation: DocumentIssueReservation) {
  const snapshot = parseRosterProfileDocumentSnapshot(reservation.snapshot);
  if (reservation.documentType !== snapshot.documentType) {
    throw new Error("Roster/profile reservation type does not match its snapshot");
  }
  const [copy, qrDataUrl] = await Promise.all([
    Promise.resolve(getRosterProfileCopy(reservation.locale, snapshot.documentType)),
    snapshot.settings.qrEnabled
      ? generateDocumentVerificationQrDataUrl(reservation.verificationToken)
      : Promise.resolve(null),
  ]);
  const canonical = await renderDocumentPdf({
    locale: reservation.locale,
    title: `${copy.title} · ${reservation.documentNumber}`,
    renderDocument: (renderContextBoundary) => (
      <RosterProfileDocument locale={reservation.locale}
        lifecycle={reservation.presentationLifecycle ?? "issued"}
        snapshot={snapshot} copy={copy} documentNumber={reservation.documentNumber}
        qrDataUrl={qrDataUrl} renderContextBoundary={renderContextBoundary} />
    ),
  });
  if (snapshot.attachments.length === 0) return canonical;
  return mergeRosterProfileAttachments(canonical.pdf, snapshot.attachments);
}
