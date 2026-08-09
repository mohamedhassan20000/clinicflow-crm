import { Children, type ReactNode } from "react";
import { localeDirection } from "@/lib/i18n/config";
import { DocumentRenderContextProvider } from "@/components/documents/engine/render-context";
import { normalizeDocumentDigits } from "@/components/documents/engine/latin-digits";
import { DOCUMENT_ENGINE_CSS } from "@/components/documents/engine/styles";
import type {
  DocumentBranding,
  DocumentFooterContent,
  DocumentIdentity,
  DocumentLifecycle,
  DocumentOrientation,
  DocumentRenderContextBoundary,
  DocumentWatermarkSettings,
} from "@/components/documents/engine/types";
import { DocumentFooter } from "@/components/documents/primitives/document-footer";
import { DocumentHeader } from "@/components/documents/primitives/document-header";
import type { Locale } from "@/lib/i18n/config";

export type DocumentPageProps = {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  branding: DocumentBranding;
  identity: DocumentIdentity;
  watermark: DocumentWatermarkSettings;
  children: ReactNode;
  orientation?: DocumentOrientation;
  footer?: DocumentFooterContent;
  pageNumber?: number;
  pageCount?: number;
  pageLabels?: { page: string; of: string };
  renderContextBoundary?: DocumentRenderContextBoundary;
  className?: string;
};

function effectiveWatermark({
  locale,
  lifecycle,
  branding,
  watermark,
}: Pick<DocumentPageProps, "locale" | "lifecycle" | "branding" | "watermark">): string | null {
  if (lifecycle === "preview") {
    return watermark.draftText || (locale === "ar" ? "مسودة" : "DRAFT");
  }
  if (lifecycle === "cancelled") {
    // i18n-allow: paired engine-owned lifecycle labels for immutable documents
    return locale === "ar" ? "ملغي" : "CANCELLED";
  }
  if (!watermark.enabled) return null;
  return watermark.text?.trim() || branding.name;
}

export function DocumentPage({
  locale,
  lifecycle,
  branding,
  identity,
  watermark,
  children,
  orientation = "portrait",
  footer,
  pageNumber,
  pageCount,
  pageLabels = locale === "ar" ? { page: "صفحة", of: "من" } : { page: "Page", of: "of" },
  renderContextBoundary: RenderContextBoundary = DocumentRenderContextProvider,
  className,
}: DocumentPageProps) {
  const normalizedBranding = normalizeDocumentDigits(branding);
  const normalizedIdentity = normalizeDocumentDigits(identity);
  const normalizedWatermark = normalizeDocumentDigits(watermark);
  const normalizedFooter = normalizeDocumentDigits(footer);
  const normalizedChildren = Children.map(
    Children.toArray(children),
    (child) => normalizeDocumentDigits(child),
  );
  const normalizedPageLabels = normalizeDocumentDigits(pageLabels);
  const direction = localeDirection(locale);
  const watermarkText = effectiveWatermark({
    locale,
    lifecycle,
    branding: normalizedBranding,
    watermark: normalizedWatermark,
  });
  const context = {
    locale,
    direction,
    digits: "latn" as const,
    lifecycle,
    orientation,
    branding: normalizedBranding,
    identity: normalizedIdentity,
  };

  return (
    <RenderContextBoundary value={context}>
      <style dangerouslySetInnerHTML={{ __html: DOCUMENT_ENGINE_CSS }} />
      <div className="cf-document-print-root">
        <div className="cf-document-surface">
          <article
            className={`cf-document-page${className ? ` ${className}` : ""}`}
            dir={direction}
            lang={locale}
            data-digits="latn"
            data-lifecycle={lifecycle}
            data-orientation={orientation}
            data-testid="document-page"
          >
            {watermarkText && (
              <div
                className="cf-document-watermark"
                aria-hidden
                data-testid="document-watermark"
                data-watermark-kind={lifecycle}
              >
                {watermarkText}
              </div>
            )}
            <table className="cf-document-pagination" role="presentation">
              <thead>
                <tr>
                  <td>
                    <div className="cf-document-chrome">
                      {/* i18n-allow: paired engine-owned lifecycle labels for the bilingual document surface */}
                      <DocumentHeader
                        branding={normalizedBranding}
                        identity={normalizedIdentity}
                        previewNumber={locale === "ar" ? "معاينة" : "PREVIEW" /* i18n-allow: paired engine-owned lifecycle labels */}
                      />
                    </div>
                  </td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><main className="cf-document-body">{normalizedChildren}</main></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <div className="cf-document-chrome">
                      {/* i18n-allow: paired engine-owned accessibility labels for the bilingual document surface */}
                      <DocumentFooter
                        branding={normalizedBranding}
                        content={normalizedFooter}
                        pageNumber={pageNumber}
                        pageCount={pageCount}
                        pageLabel={normalizedPageLabels.page}
                        ofLabel={normalizedPageLabels.of}
                        linksLabel={locale === "ar" ? "روابط المستند" : "Document links" /* i18n-allow: paired engine-owned accessibility labels */}
                      />
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </article>
        </div>
      </div>
    </RenderContextBoundary>
  );
}
