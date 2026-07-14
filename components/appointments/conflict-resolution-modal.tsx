"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { confirmAndDisplaceConflicts, type ConflictingAppointment } from "@/actions/appointments";
import { toast } from "sonner";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { useTranslations } from "next-intl";

interface ConflictResolutionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string;
  conflicts: ConflictingAppointment[];
  onConfirmed: () => void;
}

export function ConflictResolutionModal({
  open,
  onOpenChange,
  appointmentId,
  conflicts,
  onConfirmed,
}: ConflictResolutionModalProps) {
  const t = useTranslations("appointments");
  const { formatTime } = useClinicSettings();
  const [isPending, setIsPending] = useState(false);

  async function handleConfirmAndDisplace() {
    if (isPending) return;
    setIsPending(true);
    const result = await confirmAndDisplaceConflicts(
      appointmentId,
      conflicts.map((c) => c.id),
    );
    setIsPending(false);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    toast.success(t("appointmentConfirmedConflictingAppointmentsMovedTo"));
    onOpenChange(false);
    onConfirmed();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("schedulingConflictDetected")}</DialogTitle>
          <DialogDescription>
            {conflicts.length === 1
              ? t("1pendingappointmentoverlapswiththis")
              : t("pendingAppointmentsOverlap", { count: conflicts.length })}{" "}
            {t("confirmingMovesToRebook", { count: conflicts.length })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-64 overflow-y-auto pe-1">
          {conflicts.map((c) => {
            const time = formatTime(c.scheduled_at);
            const date = new Date(c.scheduled_at).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              timeZone: DEFAULT_TIME_ZONE,
            });
            const deptColor = c.departments?.color ?? "#64748b";
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2 text-sm"
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: deptColor }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {c.patients?.full_name ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                      {date} · {time} · {t("durationMinutes", { count: c.duration_minutes ?? 30 })}
                    {c.departments?.name ? ` · ${c.departments.name}` : ""}
                  </div>
                </div>
                <StatusBadge status="pending" />
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t("cancel")}</Button>
          <Button
            variant="destructive"
            onClick={handleConfirmAndDisplace}
            disabled={isPending}
          >
            {isPending ? t("confirming") : t("confirmAndRemoveConflicts", { count: conflicts.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
