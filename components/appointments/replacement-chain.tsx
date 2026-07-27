"use client";

import { useEffect, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  getAppointmentReplacementChain,
  type ReplacementChainItem,
} from "@/actions/appointments";
import { StatusBadge } from "@/components/appointments/status-badge";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { cn } from "@/lib/utils";

export function ReplacementChain({
  appointmentId,
}: {
  appointmentId: string;
}) {
  const t = useTranslations("appointments");
  const { formatDate, formatTime } = useClinicSettings();
  const [items, setItems] = useState<ReplacementChainItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getAppointmentReplacementChain(appointmentId)
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setFailed(true);
          return;
        }
        setItems(result.data ?? []);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [appointmentId]);

  return (
    <section className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("replacementChain")}
      </p>
      <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t("loadingReplacementHistory")}
          </div>
        ) : failed ? (
          <p className="text-xs text-destructive">
            {t("failedToLoadReplacementHistory")}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {items.map((item, index) => {
              const isViewed = item.id === appointmentId;
              const isActive =
                index === items.length - 1 && item.status !== "replaced";
              return (
                <li key={item.id} className="flex flex-col gap-2">
                  {index > 0 ? (
                    <ArrowDown
                      className="ms-4 size-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : null}
                  <div
                    className={cn(
                      "rounded-md border bg-background px-3 py-2",
                      isViewed && "border-primary/50 ring-1 ring-primary/15",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold">
                        {index === 0
                          ? t("originalAppointment")
                          : t("replacementNumber", { number: index })}
                        {isActive ? ` · ${t("activeAppointment")}` : ""}
                        {isViewed ? ` · ${t("viewing")}` : ""}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(item.scheduledAt, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {" · "}
                      {formatTime(item.scheduledAt)}
                      {item.doctorName ? ` · ${item.doctorName}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
