"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getBillingContext,
  updateAppointmentStatus,
  forceRestoreAppointmentStatus,
  type BillingContext,
} from "@/actions/appointments";
import type { Database } from "@/types/database";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";
import { CancelAppointmentDialog } from "@/components/appointments/cancel-dialog";
import { NoShowDialog } from "@/components/appointments/noshow-dialog";

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
  const [cancelOpen, setCancelOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [isNoShow, setIsNoShow] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Status | null>(null);
  const [ctx, setCtx] = useState<BillingContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  const effectiveStatus = optimisticStatus ?? currentStatus;
  const isTerminal = TERMINAL.includes(effectiveStatus);

  // Lazy-load services + balance the moment the dialog opens.
  useEffect(() => {
    if (!billingOpen) return;
    if (ctx) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoadingCtx(true);
      getBillingContext(appointmentId)
        .then((res) => {
          if (!active) return;
          if (res.error) {
            toast.error(res.error);
            setBillingOpen(false);
          } else if (res.data) {
            setCtx(res.data);
          }
        })
        .catch((err) => {
          if (!active) return;
          toast.error(
            err instanceof Error
              ? err.message
              : "Failed to load invoice details.",
          );
          setBillingOpen(false);
        })
        .finally(() => {
          if (active) setLoadingCtx(false);
        });
    });
    return () => {
      active = false;
    };
    // Intentionally do NOT depend on loadingCtx — its state change inside this
    // effect would cancel the in-flight fetch and leave the dialog stuck.
  }, [billingOpen, appointmentId, ctx]);

  // Prefetch billing context when the appointment is confirmed so the
  // Complete dialog opens instantly instead of showing a loading spinner.
  useEffect(() => {
    if (effectiveStatus !== "confirmed") return;
    if (ctx) return;
    let active = true;
    getBillingContext(appointmentId).then((res) => {
      if (!active || res.error || !res.data) return;
      setCtx(res.data);
    });
    return () => { active = false; };
  }, [effectiveStatus, appointmentId, ctx]);

  // When the billing dialog closes (whether via Cancel button, Esc, or
  // outside-click), force-clear the lazy-load + in-flight flags so the next
  // open starts from a clean slate. Without this, an aborted fetch can leave
  // `loadingCtx=true` and the dialog reopens stuck on the loading spinner.
  useEffect(() => {
    if (billingOpen) return;
    queueMicrotask(() => {
      setCtx(null);
      setLoadingCtx(false);
      setIsCompleting(false);
    });
  }, [billingOpen]);

  if (isTerminal) return null;

  function doUndo(prevStatus: Status, fallbackStatus: Status) {
    setOptimisticStatus(prevStatus);
    const restorable = prevStatus === "pending" || prevStatus === "confirmed";
    const promise = restorable
      ? forceRestoreAppointmentStatus(appointmentId, prevStatus as "pending" | "confirmed")
      : updateAppointmentStatus(appointmentId, prevStatus);
    promise.then((res) => {
      if (res.error) {
        toast.error(res.error);
        setOptimisticStatus(fallbackStatus);
      }
    });
  }

  function runStatus(newStatus: Status) {
    const prevStatus = effectiveStatus;
    setOptimisticStatus(newStatus);
    startTransition(async () => {
      const result = await updateAppointmentStatus(appointmentId, newStatus);
      if (result.error) {
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        toast.success(`Appointment ${newStatus}.`, {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => doUndo(prevStatus, newStatus),
          },
        });
      }
    });
  }

  function runCancel(reason: string) {
    const prevStatus = effectiveStatus;
    setIsCancelling(true);
    startTransition(async () => {
      const result = await updateAppointmentStatus(
        appointmentId,
        "cancelled",
        null,
        reason,
      );
      setIsCancelling(false);
      if (result.error) {
        toast.error(result.error);
      } else {
        setCancelOpen(false);
        setOptimisticStatus("cancelled");
        toast.success("Appointment cancelled.", {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => doUndo(prevStatus, "cancelled"),
          },
        });
      }
    });
  }

  function runNoShow(reason: string) {
    const prevStatus = effectiveStatus;
    setIsNoShow(true);
    setOptimisticStatus("no_show");
    startTransition(async () => {
      const result = await updateAppointmentStatus(
        appointmentId,
        "no_show",
        null,
        null,
        reason,
      );
      setIsNoShow(false);
      if (result.error) {
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        setNoShowOpen(false);
        toast.success("Appointment marked as no-show.", {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => doUndo(prevStatus, "no_show"),
          },
        });
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

  // Pending → Confirm + Cancel (so reception can cancel without confirming).
  // Confirmed → Complete + Cancel + No-show.
  const showConfirm = effectiveStatus === "pending";
  const showComplete = effectiveStatus === "confirmed";
  const showCancel =
    effectiveStatus === "confirmed" || effectiveStatus === "pending";
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
            onClick={() => setNoShowOpen(true)}
          >
            No-show
          </Button>
        )}
        {showCancel && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            onClick={() => setCancelOpen(true)}
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

      <CancelAppointmentDialog
        open={cancelOpen}
        onOpenChange={(o) => {
          if (!isCancelling) setCancelOpen(o);
        }}
        onConfirm={runCancel}
        isPending={isCancelling}
      />

      <NoShowDialog
        open={noShowOpen}
        onOpenChange={(o) => {
          if (!isNoShow) setNoShowOpen(o);
        }}
        onConfirm={runNoShow}
        isPending={isNoShow}
      />
    </>
  );
}
