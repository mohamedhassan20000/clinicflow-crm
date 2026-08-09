import type { DocumentBranding, DocumentIdentity } from "@/components/documents/engine/types";
import { formatDocIdentifier } from "@/lib/documents/format";

function optionalContactParts(branding: DocumentBranding): string[] {
  return [branding.licenseNo, branding.address].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

function secondaryContactParts(branding: DocumentBranding): string[] {
  return [branding.phone, branding.email, branding.website].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

export function DocumentHeader({
  branding,
  identity,
  previewNumber,
}: {
  branding: DocumentBranding;
  identity: DocumentIdentity;
  previewNumber: string;
}) {
  const labels = identity.labels;
  if (identity.issueTime && !labels.issueTime) {
    throw new Error("Document identity requires a localized issue-time label");
  }
  if (identity.period && !labels.period) {
    throw new Error("Document identity requires a localized period label");
  }
  const primary = optionalContactParts(branding);
  const secondary = secondaryContactParts(branding);
  const number = formatDocIdentifier(identity.documentNumber || previewNumber);
  const initial = branding.name.trim().charAt(0).toUpperCase() || "C";

  const rows = [
    [labels.documentNumber, number, true],
    [labels.issueDate, identity.issueDate, true],
    identity.issueTime ? [labels.issueTime, identity.issueTime, true] : null,
    identity.period ? [labels.period, identity.period, true] : null,
  ].filter((row): row is [string, string, boolean] => row !== null);

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
            {primary.length > 0 && <p>{primary.join(" · ")}</p>}
            {secondary.length > 0 && (
              <p>
                {secondary.map((value, index) => (
                  <span key={value}>
                    {index > 0 ? " · " : ""}
                    <bdi className="cf-doc-ltr">{formatDocIdentifier(value)}</bdi>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="cf-doc-identity">
        <h1 className="cf-doc-title">{identity.title}</h1>
        <div className="cf-doc-meta-grid">
          {rows.map(([label, value, isLtr]) => (
            <div key={label} style={{ display: "contents" }}>
              <span className="cf-doc-meta-label">{label}</span>
              <bdi className={`cf-doc-meta-value${isLtr ? " cf-doc-ltr" : ""}`}>
                {formatDocIdentifier(value)}
              </bdi>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
