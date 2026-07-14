import { Badge } from "@/components/ui/badge";
import type { Database } from "@/types/database";
import { useTranslations } from "next-intl";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

const STATUS_CONFIG: Record<
  AppointmentStatus,
  { labelKey: string; className: string }
> = {
  pending: {
    labelKey: "statusPending",
    className: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  },
  confirmed: {
    labelKey: "statusConfirmed",
    className: "bg-primary/10 text-foreground border-primary/40",
  },
  arrived: {
    labelKey: "statusArrived",
    className: "bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-700",
  },
  in_session: {
    labelKey: "statusInSession",
    className: "bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700",
  },
  completed: {
    labelKey: "statusCompleted",
    className: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700",
  },
  cancelled: {
    labelKey: "statusCancelled",
    className: "bg-destructive/10 text-foreground border-destructive/40",
  },
  no_show: {
    labelKey: "statusNoShow",
    className: "bg-muted text-foreground/80 border-calendar-grid",
  },
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const t = useTranslations("appointments");
  const config = STATUS_CONFIG[status];
  return (
    <Badge variant="outline" className={config.className}>
      {t(config.labelKey)}
    </Badge>
  );
}
