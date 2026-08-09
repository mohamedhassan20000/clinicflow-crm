import type { ReactNode } from "react";

export function NotesCallout({
  label,
  children,
  tone = "accent",
}: {
  label: string;
  children: ReactNode;
  tone?: "accent" | "neutral";
}) {
  return (
    <aside className="cf-doc-callout" data-tone={tone} data-testid="notes-callout">
      <div className="cf-doc-label">{label}</div>
      <div className="cf-doc-callout-content">{children}</div>
    </aside>
  );
}
