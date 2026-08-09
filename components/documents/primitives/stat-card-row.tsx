import type { ReactNode } from "react";

export type StatCardItem = {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
};

export function StatCardRow({ items }: { items: readonly StatCardItem[] }) {
  if (items.length === 0) return null;
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <section
      className={"cf-doc-stat-row cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}
      style={{ "--doc-column-count": Math.min(items.length, 6) } as React.CSSProperties}
      data-testid="stat-card-row"
    >
      {items.map((item) => (
        <div className="cf-doc-stat" key={item.label}>
          <div className="cf-doc-label">{item.label}</div>
          <div className="cf-doc-stat-value">{item.value}</div>
          {item.detail && <div className="cf-doc-stat-detail">{item.detail}</div>}
        </div>
      ))}
    </section>
  );
}
