export type SignatureLine = {
  id: string;
  label: string;
  imageSrc?: string | null;
  emptyLabel?: string;
};

export function SignatureBlock({
  signatures,
  stampLabel,
}: {
  signatures: readonly SignatureLine[];
  stampLabel?: string;
}) {
  if (signatures.length === 0 && !stampLabel) return null;
  const count = signatures.length + (stampLabel ? 1 : 0);
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <section
      className={"cf-doc-signatures cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}
      style={{ "--doc-column-count": Math.min(count, 3) } as React.CSSProperties}
      data-testid="signature-block"
    >
      {signatures.map((signature) => (
        <div key={signature.id}>
          <div className="cf-doc-signature-line">
            {signature.imageSrc ? (
              // Clinical signature assets are inlined into the immutable snapshot.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="cf-doc-signature-image" src={signature.imageSrc} alt="" aria-hidden />
            ) : signature.emptyLabel ? (
              <span className="cf-doc-signature-empty">{signature.emptyLabel}</span>
            ) : null}
          </div>
          <div className="cf-doc-signature-label">{signature.label}</div>
        </div>
      ))}
      {stampLabel && <div className="cf-doc-stamp-slot">{stampLabel}</div>}
    </section>
  );
}
