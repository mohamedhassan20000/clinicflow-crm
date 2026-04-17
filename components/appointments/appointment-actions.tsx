"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateAppointmentStatus } from "@/actions/appointments";
import { STATUS_TRANSITIONS } from "@/lib/validations/appointment";
import type { Database } from "@/types/database";

type Status = Database["public"]["Enums"]["appointment_status"];

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirm",
  completed: "Complete",
  cancelled: "Cancel",
  no_show: "No-show",
};

const STATUS_VARIANTS: Record<string, "default" | "outline" | "destructive" | "secondary"> = {
  confirmed: "default",
  completed: "default",
  cancelled: "destructive",
  no_show: "secondary",
};

export function AppointmentActions({
  appointmentId,
  currentStatus,
}: {
  appointmentId: string;
  currentStatus: Status;
}) {
  const [isPending, startTransition] = useTransition();
  const allowed = STATUS_TRANSITIONS[currentStatus] ?? [];

  if (allowed.length === 0) return null;

  function handleTransition(newStatus: string) {
    startTransition(async () => {
      const result = await updateAppointmentStatus(appointmentId, newStatus);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Appointment ${newStatus}.`);
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-1">
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        allowed.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={STATUS_VARIANTS[s] ?? "outline"}
            className="h-6 px-1.5 text-[10px]"
            onClick={() => handleTransition(s)}
          >
            {STATUS_LABELS[s] ?? s}
          </Button>
        ))
      )}
    </div>
  );
}
