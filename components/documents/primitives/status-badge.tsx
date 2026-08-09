export type StatusBadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: StatusBadgeTone }) {
  return <span className="cf-doc-badge" data-tone={tone} data-testid="status-badge">{label}</span>;
}
