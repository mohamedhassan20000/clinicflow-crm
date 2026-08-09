export function VerificationBlock({
  qrDataUrl,
  title,
  caption,
  verificationKey,
}: {
  qrDataUrl: string;
  title: string;
  caption: string;
  verificationKey?: string | null;
}) {
  if (!qrDataUrl.startsWith("data:image/")) {
    throw new Error("VerificationBlock requires an inlined QR data URI");
  }
  return (
    <aside className="cf-doc-verification" data-testid="verification-block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="cf-doc-qr" src={qrDataUrl} alt="" aria-hidden />
      <div>
        <div className="cf-doc-verification-title">{title}</div>
        <div className="cf-doc-verification-caption">{caption}</div>
        {/* i18n-allow: document CSS class tokens, not user-facing copy */}
        {verificationKey && <bdi className="cf-doc-verification-key cf-doc-ltr">{verificationKey}</bdi>}
      </div>
    </aside>
  );
}
