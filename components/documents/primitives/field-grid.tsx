import type { ReactNode } from "react";

export type FieldGridItem = {
  label: string;
  value?: ReactNode | null;
  direction?: "auto" | "ltr" | "rtl";
};

export function FieldGrid({
  items,
  columns = 2,
}: {
  items: readonly FieldGridItem[];
  columns?: 1 | 2 | 3;
}) {
  const present = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
  if (present.length === 0) return null;
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <dl
      className={"cf-doc-field-grid cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}
      style={{ "--doc-column-count": columns } as React.CSSProperties}
      data-testid="field-grid"
    >
      {present.map((item) => (
        <div className="cf-doc-field" key={item.label}>
          <dt className="cf-doc-label">{item.label}</dt>
          <dd className="cf-doc-field-value" style={{ marginInline: 0 }}>
            {item.direction === "ltr" ? <bdi className="cf-doc-ltr">{item.value}</bdi> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
