import type { ReactNode } from "react";

export function IdentityHero({
  name,
  identifier,
  detail,
  initials,
  imageSrc,
  imageBackgroundSrc,
  status,
}: {
  name: string;
  identifier?: string | null;
  detail?: ReactNode;
  initials: string;
  imageSrc?: string | null;
  imageBackgroundSrc?: string | null;
  imagePresentation?: "cover" | "background-fill";
  status?: ReactNode;
}) {
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <section className="cf-doc-identity-hero cf-doc-section" data-testid="identity-hero">
      {imageSrc ? (
        // i18n-allow: document CSS class tokens, not user-facing copy
        <span className="cf-doc-avatar cf-doc-avatar-layered" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cf-doc-avatar-background" src={imageBackgroundSrc || imageSrc} alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cf-doc-avatar-foreground" src={imageSrc} alt="" />
        </span>
      ) : <div className="cf-doc-avatar" aria-hidden>{initials}</div>}
      <div className="cf-doc-hero-main">
        <h2 className="cf-doc-hero-name">{name}</h2>
        {/* i18n-allow: document CSS class tokens, not user-facing copy */}
        {identifier && <bdi className="cf-doc-hero-detail cf-doc-ltr">{identifier}</bdi>}
        {detail && <div className="cf-doc-hero-detail">{detail}</div>}
      </div>
      {status}
    </section>
  );
}
