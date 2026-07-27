"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarX2, ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissDisplacedAppointment } from "@/actions/appointments";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { withReturnTo } from "@/lib/navigation/return-url";
import { useTranslations } from "next-intl";

export type DisplacedAppointmentItem = {
  id: string;
  scheduled_at: string;
  duration_minutes: number;
  displaced_at: string;
  patient_id: string;
  doctor_id: string;
  department_id: string | null;
  insurance_provider_id: string | null;
  patientName: string;
  doctorName: string;
  departmentName: string | null;
  departmentColor: string | null;
};

interface DisplacedAppointmentsProps {
  items: DisplacedAppointmentItem[];
  returnHref?: string;
  canDismiss?: boolean;
}

export function DisplacedAppointments({
  items,
  returnHref = "/appointments",
  canDismiss = true,
}: DisplacedAppointmentsProps) {
  const t = useTranslations("appointments");
  const { formatTime } = useClinicSettings();
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const visible = items.filter((i) => !dismissed.has(i.id));

  if (visible.length === 0) return null;

  function handleDismiss(id: string) {
    startTransition(async () => {
      const res = await dismissDisplacedAppointment(id);
      if (res.error) {
        toast.error(res.error);
      } else {
        setDismissed((prev) => new Set([...prev, id]));
      }
    });
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5">
      {/* Header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start"
      >
        <div className="flex items-center gap-2">
          <CalendarX2 className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-sm font-medium">
            {t("displacedAppointments")}</span>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
            {visible.length}
          </span>
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-amber-500/20 px-4 pb-4">
          <p className="py-2 text-xs text-muted-foreground">
            {t("theseAppointmentsWereRemovedWhenA")}</p>
          <div className="space-y-2">
            {visible.map((item) => {
              const date = new Date(item.scheduled_at).toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
                timeZone: DEFAULT_TIME_ZONE,
              });
              const time = formatTime(item.scheduled_at);

              const rebookParams = new URLSearchParams({
                patient_id: item.patient_id,
                doctor_id: item.doctor_id,
                ...(item.department_id ? { dept_id: item.department_id } : {}),
                ...(item.insurance_provider_id
                  ? { insurance_id: item.insurance_provider_id }
                  : {}),
              });

              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border/40 bg-card px-3 py-2.5"
                >
                  {item.departmentColor && (
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: item.departmentColor }}
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{item.patientName}</div>
                    <div className="text-xs text-muted-foreground">
                    {date} · {time} · {t("durationMinutes", { count: item.duration_minutes })}
                      {item.doctorName ? ` · ${item.doctorName}` : ""}
                      {item.departmentName ? ` · ${item.departmentName}` : ""}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                    >
                      <Link href={withReturnTo(`/appointments/new?${rebookParams.toString()}`, returnHref)}>
                        <RefreshCw className="h-3 w-3" />
                        {t("rebook")}</Link>
                    </Button>
                    {canDismiss ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        disabled={isPending}
                        onClick={() => handleDismiss(item.id)}
                        title={t("dismiss")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
