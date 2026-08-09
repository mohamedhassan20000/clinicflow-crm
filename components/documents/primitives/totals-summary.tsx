import type { ReactNode } from "react";

export type TotalSummaryItem = {
  label: string;
  value: ReactNode;
  emphasis?: "default" | "strong";
};

export function TotalsSummary({ items }: { items: readonly TotalSummaryItem[] }) {
  if (items.length === 0) return null;
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <section
      className={"cf-doc-totals cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}
      style={{ "--doc-column-count": Math.min(items.length, 4) } as React.CSSProperties}
      data-testid="totals-summary"
    >
      {items.map((item) => (
        <div className="cf-doc-total-item" data-emphasis={item.emphasis || "default"} key={item.label}>
          <div className="cf-doc-label">{item.label}</div>
          <div className="cf-doc-total-value">{item.value}</div>
        </div>
      ))}
    </section>
  );
}
