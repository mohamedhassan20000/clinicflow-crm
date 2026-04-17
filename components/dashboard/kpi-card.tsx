import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface KpiCardProps {
  title: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;
  trend?: {
    value: number; // percentage change (+/-)
    label: string;
  };
  variant?: "default" | "primary" | "warning" | "success" | "destructive";
}

const variantStyles = {
  default: "bg-card border-border/50",
  primary: "bg-primary/5 border-primary/20",
  warning: "bg-amber-500/5 border-amber-500/20",
  success: "bg-emerald-500/5 border-emerald-500/20",
  destructive: "bg-destructive/5 border-destructive/20",
};

const iconStyles = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-600",
  success: "bg-emerald-500/10 text-emerald-600",
  destructive: "bg-destructive/10 text-destructive",
};

export function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  trend,
  variant = "default",
}: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border p-5 space-y-3",
        variantStyles[variant],
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className={cn("rounded-lg p-2", iconStyles[variant])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <div>
        <p className="text-3xl font-bold tracking-tight">{value}</p>
        {sub && (
          <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
        )}
      </div>

      {trend !== undefined && (
        <p className={cn("text-xs font-medium", trend.value >= 0 ? "text-emerald-600" : "text-destructive")}>
          {trend.value >= 0 ? "+" : ""}
          {trend.value}% {trend.label}
        </p>
      )}
    </div>
  );
}
