"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getBillingContext,
  updateAppointmentStatus,
  type BillingContext,
} from "@/actions/appointments";
import { STATUS_TRANSITIONS } from "@/lib/validations/appointment";
import type { Database } from "@/types/database";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";

type Status = Database["public"]["Enums"]["appointment_status"];

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirm",
  completed: "Complete",
  cancelled: "Cancel",
  no_show: "No-show",
};

const STATUS_VARIANTS: Record<
  string,
  "default" | "outline" | "destructive" | "secondary"
> = {
  confirmed: "default",
  completed: "default",
  cancelled: "outline",
  no_show: "outline",
};

const STATUS_CLASSES: Record<string, string> = {
  completed:
    "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 shadow-sm",
};

export function AppointmentActions({
  appointmentId,
  currentStatus,
}: {
  appointmentId: string;
  currentStatus: Status;
  /** @deprecated kept for back-compat — context is loaded from the server now */
  hasInsurance?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [billingOpen, setBillingOpen] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Status | null>(null);
  const [ctx, setCtx] = useState<BillingContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const effectiveStatus = optimisticStatus ?? currentStatus;
  const allowed = STATUS_TRANSITIONS[effectiveStatus] ?? [];

  useEffect(() => {
    if (!billingOpen || ctx || loadingCtx) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoadingCtx(true);
      getBillingContext(appointmentId)
        .then((res) => {
          if (cancelled) return;
          if (res.error) {
            toast.error(res.error);
            setBillingOpen(false);
          } else if (res.data) {
            setCtx(res.data);
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingCtx(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [billingOpen, appointmentId, ctx, loadingCtx]);

  if (allowed.length === 0) return null;

  function runStatus(newStatus: string) {
    setOptimisticStatus(newStatus as Status);
    startTransition(async () => {
      const result = await updateAppointmentStatus(appointmentId, newStatus);
      if (result.error) {
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        toast.success(`Appointment ${newStatus}.`);
      }
    });
  }

  function runComplete(payload: BillingPayload) {
    startTransition(async () => {
      const result = await updateAppointmentStatus(
        appointmentId,
        "completed",
        payload,
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Appointment completed & charged.");
        setBillingOpen(false);
        setCtx(null);
      }
    });
  }

  function handleClick(newStatus: string) {
    if (newStatus === "completed") {
      setBillingOpen(true);
      return;
    }
    runStatus(newStatus);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {allowed.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={STATUS_VARIANTS[s] ?? "outline"}
            className={cn(
              "h-6 px-2 text-[10px] font-semibold",
              STATUS_CLASSES[s],
            )}
            onClick={() => handleClick(s)}
          >
            {STATUS_LABELS[s] ?? s}
          </Button>
        ))}
        {isPending && !billingOpen && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      <BillingDialog
        open={billingOpen}
        onOpenChange={(o) => {
          setBillingOpen(o);
          if (!o) setCtx(null);
        }}
        onConfirm={runComplete}
        isPending={isPending || loadingCtx}
        hasInsurance={ctx?.hasInsurance ?? false}
        services={ctx?.services ?? []}
        accountBalance={ctx?.accountBalance ?? 0}
        patientName={ctx?.patientName}
      />
    </>
  );
}
