import { DocumentPage, type DocumentLifecycle, type DocumentRenderContextBoundary } from "@/components/documents/engine";
import {
  SectionHeader, SignatureBlock, VerificationBlock,
} from "@/components/documents/primitives";
import { formatDocDate, formatDocTime } from "@/lib/documents/format";
import type { GenericDocumentCopy } from "@/lib/documents/generic-copy";
import type { GenericDocumentSnapshot } from "@/lib/documents/generic-shared";
import type { Locale } from "@/lib/i18n/config";

export function GenericDocument({
  locale, lifecycle, snapshot, copy, documentNumber, qrDataUrl, renderContextBoundary,
}: {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: GenericDocumentSnapshot;
  copy: GenericDocumentCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
}) {
  const formatLocale = { locale, timeZone: snapshot.format.timeZone, timeFormat: snapshot.format.timeFormat };
  const verification = lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl ? (
    <VerificationBlock qrDataUrl={qrDataUrl} title={copy.verificationTitle}
      caption={copy.verificationCaption} verificationKey={documentNumber} />
  ) : null;

  return (
    <DocumentPage locale={locale} lifecycle={lifecycle} branding={snapshot.branding}
      identity={{ title: snapshot.title, documentNumber: lifecycle !== "preview" ? documentNumber : null,
        issueDate: formatDocDate(snapshot.generatedAt, formatLocale, { dateStyle: "medium" }),
        issueTime: formatDocTime(snapshot.generatedAt, formatLocale), labels: copy.labels }}
      watermark={{ enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
        text: snapshot.settings.watermark }}
      footer={{ attribution: snapshot.branding.footerText || copy.footerAttribution, copyright: copy.copyright }}
      pageLabels={{ page: copy.page, of: copy.of }}
      renderContextBoundary={renderContextBoundary}>
      <div className={"cf-doc-generic-body cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}>
        {snapshot.blocks.map((block, index) =>
          block.kind === "heading" ? (
            <SectionHeader key={index} title={block.text} />
          ) : (
            <p key={index} className="cf-doc-generic-paragraph" dir="auto">{block.text}</p>
          ),
        )}
      </div>
      <SignatureBlock signatures={[
        { id: "authorized", label: copy.authorizedSignature },
        { id: "recipient", label: copy.recipientSignature },
      ]} stampLabel={copy.stamp} />
      {verification}
    </DocumentPage>
  );
}
