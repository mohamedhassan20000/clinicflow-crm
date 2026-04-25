"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getBillingContext,
  updateAppointmentStatus,
  type BillingContext,
} from "@/actions/appointments";
import type { Database } from "@/types/database";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";

type Status = Database["public"]["Enums"]["appointment_status"];

const TERMINAL: Status[] = ["completed", "cancelled", "no_show"];

export function AppointmentActions({
  appointmentId,
  currentStatus,
}: {
  appointmentId: string;
  currentStatus: Status;
  /** @deprecated kept for back-compat */
  hasInsurance?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [billingOpen, setBillingOpen] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Status | null>(null);
  const [ctx, setCtx] = useState<BillingContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  const effectiveStatus = optimisticStatus ?? currentStatus;
  const isTerminal = TERMINAL.includes(effectiveStatus);

  // Lazy-load services + balance the moment the dialog opens.
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

  if (isTerminal) return null;

  function runStatus(newStatus: Status) {
    // Optimistic UI flip — button disappears immediately, no spinner.
    setOptimisticStatus(newStatus);
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
    setIsCompleting(true);
    setOptimisticStatus("completed");
    startTransition(async () => {
      const result = await updateAppointmentStatus(
        appointmentId,
        "completed",
        payload,
      );
      setIsCompleting(false);
      if (result.error) {
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        toast.success("Appointment completed & charged.");
        setBillingOpen(false);
        setCtx(null);
      }
    });
  }

  const showConfirm = effectiveStatus === "pending";
  // Complete is always offered for non-terminal appointments — past, today,
  // future. Server allows pending → completed and confirmed → completed.
  const showComplete = !isTerminal;
  const showCancel = effectiveStatus !== "cancelled";
  const showNoShow = effectiveStatus === "confirmed";

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {showConfirm && (
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2 text-[10px] font-semibold"
            onClick={() => runStatus("confirmed")}
          >
            Confirm
          </Button>
        )}
        {showComplete && (
          <Button
            size="sm"
            variant="default"
            className={cn(
              "h-6 px-2 text-[10px] font-semibold",
              "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 shadow-sm",
            )}
            onClick={() => setBillingOpen(true)}
          >
            Complete
          </Button>
        )}
        {showNoShow && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            onClick={() => runStatus("no_show")}
          >
            No-show
          </Button>
        )}
        {showCancel && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            onClick={() => runStatus("cancelled")}
          >
            Cancel
          </Button>
        )}
      </div>

      <BillingDialog
        open={billingOpen}
        onOpenChange={(o) => {
          setBillingOpen(o);
          if (!o) setCtx(null);
        }}
        onConfirm={runComplete}
        isPending={isCompleting || loadingCtx}
        loadingContext={loadingCtx && !ctx}
        hasInsurance={ctx?.hasInsurance ?? false}
        insuranceProviderName={ctx?.insuranceProviderName ?? null}
        services={ctx?.services ?? []}
        accountBalance={ctx?.accountBalance ?? 0}
        patientName={ctx?.patientName}
        departmentName={ctx?.departmentName ?? null}
        departmentColor={ctx?.departmentColor ?? null}
      />
    </>
  );
}
