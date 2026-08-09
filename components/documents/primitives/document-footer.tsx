import type { DocumentBranding, DocumentFooterContent } from "@/components/documents/engine/types";
import { formatDocNumber } from "@/lib/documents/format";

export function DocumentFooter({
  branding,
  content = {},
  pageNumber,
  pageCount,
  pageLabel = "Page",
  ofLabel = "of",
  linksLabel,
}: {
  branding: DocumentBranding;
  content?: DocumentFooterContent;
  pageNumber?: number;
  pageCount?: number;
  pageLabel?: string;
  ofLabel?: string;
  linksLabel: string;
}) {
  const attribution = content.attribution || branding.footerText;
  return (
    <footer className="cf-doc-footer" data-testid="document-footer">
      {content.verificationSlot}
      <div className="cf-doc-footer-main">
        {attribution && <p>{attribution}</p>}
        {content.copyright && <p>{content.copyright}</p>}
        {content.links && content.links.length > 0 && (
          <nav className="cf-doc-footer-links" aria-label={linksLabel}>
            {content.links.map((link) =>
              link.href ? (
                <a key={link.label} href={link.href}>{link.label}</a>
              ) : (
                <span key={link.label}>{link.label}</span>
              )
            )}
          </nav>
        )}
      </div>
      {pageNumber && pageCount && (
        <p className="cf-doc-page-number">
          {pageLabel} <span className="cf-doc-page-current">{formatDocNumber(pageNumber)}</span>{" "}
          {ofLabel} <span className="cf-doc-page-total">{formatDocNumber(pageCount)}</span>
        </p>
      )}
    </footer>
  );
}
