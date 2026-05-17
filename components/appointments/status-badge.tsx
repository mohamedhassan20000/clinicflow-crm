import { Badge } from "@/components/ui/badge";
import type { Database } from "@/types/database";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

const STATUS_CONFIG: Record<
  AppointmentStatus,
  { label: string; className: string }
> = {
  pending: {
    label: "Pending",
    className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400",
  },
  confirmed: {
    label: "Confirmed",
    className: "bg-primary/10 text-primary border-primary/20",
  },
  arrived: {
    label: "Arrived",
    className: "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400",
  },
  in_session: {
    label: "In session",
    className: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  no_show: {
    label: "No-show",
    className: "bg-muted text-muted-foreground border-border",
  },
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}
