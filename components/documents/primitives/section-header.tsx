import type { ReactNode } from "react";

export function SectionHeader({ title, icon }: { title: string; icon?: ReactNode }) {
  return (
    <h2 className="cf-doc-section-header" data-testid="section-header">
      {icon}
      <span>{title}</span>
    </h2>
  );
}
