function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0]?.toUpperCase()).join("") || "—";
}

export function AvatarName({
  name,
  imageSrc,
  detail,
}: {
  name: string;
  imageSrc?: string | null;
  detail?: string | null;
}) {
  return <span className="cf-doc-avatar-name">
    {imageSrc ? (
      // Document PDF images are inlined by the roster/profile resolver.
      // eslint-disable-next-line @next/next/no-img-element
      <img className="cf-doc-list-avatar" src={imageSrc} alt="" aria-hidden />
    ) : (
      // i18n-allow: document CSS class tokens, not user-facing copy
      <span className="cf-doc-list-avatar cf-doc-list-avatar-fallback" aria-hidden>
        {initials(name)}
      </span>
    )}
    <span className="cf-doc-avatar-name-copy">
      <strong>{name}</strong>
      {detail && <small>{detail}</small>}
    </span>
  </span>;
}
