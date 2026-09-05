import { cn } from "@/lib/utils";

/**
 * A compact percentage meter, shared by the owner allowance console, the owner
 * clinic page, and the clinic-admin dashboard so one usage figure never renders
 * three different ways.
 *
 * Tone follows the same thresholds the allowance invariant uses (75 / 90 / 100)
 * rather than an arbitrary colour ramp, and the bar is a real `progressbar` with
 * an accessible name — a coloured div is not readable to a screen reader.
 */
export function UsageBar({
  percent,
  label,
  tone,
  className,
}: {
  percent: number;
  /** Accessible name. Rendered visually by the caller, not by the bar. */
  label: string;
  tone?: "neutral" | "warning" | "critical" | "exhausted";
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const resolved =
    tone ?? (clamped >= 100 ? "exhausted" : clamped >= 90 ? "critical" : clamped >= 75 ? "warning" : "neutral");
  const fill = {
    neutral: "bg-primary",
    warning: "bg-amber-500",
    critical: "bg-orange-500",
    exhausted: "bg-destructive",
  }[resolved];

  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <div
        className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
