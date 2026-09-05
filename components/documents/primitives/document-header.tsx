import type { DocumentBranding, DocumentIdentity } from "@/components/documents/engine/types";
import { formatDocIdentifier } from "@/lib/documents/format";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";
import type { Locale } from "@/lib/i18n/config";

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function DocumentHeader({
  branding,
  identity,
  previewNumber,
  locale,
}: {
  branding: DocumentBranding;
  identity: DocumentIdentity;
  previewNumber: string;
  locale: Locale;
}) {
  const labels = identity.labels;
  if (identity.issueTime && !labels.issueTime) {
    throw new Error("Document identity requires a localized issue-time label");
  }
  if (identity.period && !labels.period) {
    throw new Error("Document identity requires a localized period label");
  }
  // The clinic identifiers live in the metadata block, not beside the logo, so
  // their labels are engine-owned rather than per-family template copy.
  const headerCopy = getSharedDocumentSectionCopy(locale).header;
  const address = text(branding.address);
  const phone = text(branding.phone);
  const email = text(branding.email);
  const website = text(branding.website);
  const taxId = text(branding.taxId);
  const licenseNo = text(branding.licenseNo);
  const number = formatDocIdentifier(identity.documentNumber || previewNumber);
  const initial = branding.name.trim().charAt(0).toUpperCase() || "C";

  const rows = [
    [labels.documentNumber, number, true, false],
    taxId ? [headerCopy.taxRegistrationNumber, taxId, true, true] : null,
    licenseNo ? [headerCopy.registrationNumber, licenseNo, true, true] : null,
    [labels.issueDate, identity.issueDate, true, false],
    identity.issueTime ? [labels.issueTime, identity.issueTime, true, false] : null,
    identity.period ? [labels.period, identity.period, true, false] : null,
  ].filter((row): row is [string, string, boolean, boolean] => row !== null);

  return (
    <header className="cf-doc-header" data-testid="document-header">
      <div className="cf-doc-branding">
        {branding.logoSrc ? (
          // Canonical PDF callers must pass an inlined/data URI logo.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="cf-doc-logo" src={branding.logoSrc} alt="" aria-hidden />
        ) : (
          <div className={"cf-doc-logo cf-doc-logo-fallback" /* i18n-allow: document CSS class tokens, not user-facing copy */} aria-hidden>
            {initial}
          </div>
        )}
        <div className="cf-doc-branding-copy">
          <p className="cf-doc-clinic-name">{branding.name}</p>
          <div className="cf-doc-contact-lines">
            {address && <p>{formatDocIdentifier(address)}</p>}
            {phone && (
              <p>
                <bdi className="cf-doc-ltr">{formatDocIdentifier(phone)}</bdi>
              </p>
            )}
            {(email || website) && (
              <p className="cf-doc-contact-pair">
                {email && <bdi className="cf-doc-ltr">{formatDocIdentifier(email)}</bdi>}
                {website && <bdi className="cf-doc-ltr">{formatDocIdentifier(website)}</bdi>}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="cf-doc-identity">
        <h1 className="cf-doc-title">{identity.title}</h1>
        <div className="cf-doc-meta-grid">
          {rows.map(([label, value, isLtr, isAtomic]) => (
            <div key={label} style={{ display: "contents" }}>
              <span className="cf-doc-meta-label">{label}</span>
              <bdi
                className={`cf-doc-meta-value${isLtr ? " cf-doc-ltr" : ""}${
                  isAtomic ? " cf-doc-meta-value-atomic" : ""
                }`}
              >
                {formatDocIdentifier(value)}
              </bdi>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
