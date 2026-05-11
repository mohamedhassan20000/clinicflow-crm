"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getBillingContext,
  updateAppointmentStatus,
  undoAppointmentStatus,
  undoInvoiceCompletion,
  type BillingContext,
  type InvoiceUndoStatus,
} from "@/actions/appointments";
import type { Database } from "@/types/database";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";
import { CancelAppointmentDialog } from "@/components/appointments/cancel-dialog";
import { NoShowDialog } from "@/components/appointments/noshow-dialog";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";

type Status = Database["public"]["Enums"]["appointment_status"];
type RestorableStatus = Extract<Status, "pending" | "confirmed">;
type PendingAction =
  | "confirm"
  | "complete"
  | "cancel"
  | "no_show"
  | "undo";

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
  const [billingOpen, setBillingOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [isNoShow, setIsNoShow] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Status | null>(null);
  const [ctx, setCtx] = useState<BillingContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<BillingPayload | null>(null);
  const [invoiceDraftKey, setInvoiceDraftKey] = useState(0);

  const effectiveStatus = optimisticStatus ?? currentStatus;
  const isTerminal = TERMINAL.includes(effectiveStatus);
  const hasPendingAction = pendingAction !== null;

  function setActionPending(action: PendingAction | null) {
    pendingActionRef.current = action;
    setPendingAction(action);
  }

  function resetCancelState() {
    setCancelOpen(false);
    setIsCancelling(false);
    if (pendingActionRef.current === "cancel") setActionPending(null);
  }

  function resetNoShowState() {
    setNoShowOpen(false);
    setIsNoShow(false);
    if (pendingActionRef.current === "no_show") setActionPending(null);
  }

  function resetBillingState() {
    setBillingOpen(false);
    setLoadingCtx(false);
    setIsCompleting(false);
    if (pendingActionRef.current === "complete") setActionPending(null);
  }

  // targetStatus is passed in from the closure, never read from a ref.
  function reopenInvoiceDraft(payload: BillingPayload, targetStatus: Status) {
    setInvoiceDraft(payload);
    setInvoiceDraftKey((key) => key + 1);
    setOptimisticStatus(targetStatus);
    setBillingOpen(true);
  }

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

  if (isTerminal) return null;

  // targetStatus and fallbackStatus are both passed by the caller's closure,
  // so this function never reads from any mutable ref for its core logic.
  function doUndo(targetStatus: Status, fallbackStatus: Status) {
    if (pendingActionRef.current) return;
    if (targetStatus !== "pending" && targetStatus !== "confirmed") {
      toast.error("This appointment cannot be restored to its previous status.");
      return;
    }
    setActionPending("undo");
    setOptimisticStatus(targetStatus);
    undoAppointmentStatus(appointmentId, targetStatus as RestorableStatus).then((res) => {
      if (res.error) {
        toast.error(res.error);
        setOptimisticStatus(fallbackStatus);
      }
    }).finally(() => {
      setActionPending(null);
    });
  }

  function runStatus(newStatus: Status) {
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    setActionPending(newStatus === "confirmed" ? "confirm" : null);
    setOptimisticStatus(newStatus);
    updateAppointmentStatus(appointmentId, newStatus).then((result) => {
      if (result.error) {
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        toast.success(`Appointment ${newStatus}.`, {
          duration: 10000,
          action: {
            label: "Undo",
            // prevStatus is captured at call time in this closure, not read
            // from a ref later, so RSC re-renders cannot stale it.
            onClick: () => doUndo(prevStatus, newStatus),
          },
        });
      }
    }).finally(() => {
      setActionPending(null);
    });
  }

  function runCancel(reason: string) {
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    setActionPending("cancel");
    setIsCancelling(true);
    updateAppointmentStatus(appointmentId, "cancelled", null, reason).then((result) => {
      if (result.error) {
        setIsCancelling(false);
        setActionPending(null);
        toast.error(result.error);
      } else {
        resetCancelState();
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
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    setActionPending("no_show");
    setIsNoShow(true);
    setOptimisticStatus("no_show");
    updateAppointmentStatus(appointmentId, "no_show", null, null, reason).then((result) => {
      if (result.error) {
        setIsNoShow(false);
        setActionPending(null);
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        resetNoShowState();
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
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    const undoTarget: InvoiceUndoStatus =
      prevStatus === "pending" || prevStatus === "confirmed"
        ? prevStatus
        : "confirmed";
    setInvoiceDraft(payload);
    setActionPending("complete");
    setIsCompleting(true);
    updateAppointmentStatus(appointmentId, "completed", payload).then(async (result) => {
      if (result.error) {
        setIsCompleting(false);
        setActionPending(null);
        toast.error(result.error);
        setOptimisticStatus(null);
      } else {
        setOptimisticStatus("completed");
        toast.success("Appointment completed & charged.", {
          duration: 10000,
          action: {
            label: "Undo",
            // undoTarget and prevStatus are both captured at call time.
            onClick: async () => {
              if (pendingActionRef.current) return;
              setActionPending("undo");
              reopenInvoiceDraft(payload, undoTarget);
              const undo = await undoInvoiceCompletion(appointmentId, undoTarget);
              if (undo.error) {
                toast.error(undo.error);
                setOptimisticStatus("completed");
                setActionPending(null);
                return;
              }
              setActionPending(null);
            },
          },
        });
        resetBillingState();
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
            disabled={hasPendingAction}
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
            disabled={hasPendingAction || loadingCtx}
            onClick={() => {
              if (hasPendingAction || loadingCtx) return;
              setInvoiceDraft(null);
              setInvoiceDraftKey((key) => key + 1);
              setBillingOpen(true);
            }}
          >
            Complete
          </Button>
        )}
        {showNoShow && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
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
            disabled={hasPendingAction}
            onClick={() => setCancelOpen(true)}
          >
            Cancel
          </Button>
        )}
      </div>

      <BillingDialog
        open={billingOpen}
        onOpenChange={(o) => {
          if (o) setBillingOpen(true);
          else resetBillingState();
        }}
        onConfirm={runComplete}
        isPending={isCompleting}
        loadingContext={loadingCtx && !ctx}
        hasInsurance={ctx?.hasInsurance ?? false}
        insuranceProviderName={ctx?.insuranceProviderName ?? null}
        services={ctx?.services ?? []}
        accountBalance={ctx?.accountBalance ?? 0}
        previousOutstandingBalance={ctx?.previousOutstandingBalance ?? 0}
        previousOutstandingAction={
          ctx && ctx.previousOutstandingBalance > 0 ? (
            <SettleOutstandingDialog
              patientId={ctx.patientId}
              outstanding={ctx.previousOutstandingBalance}
              patientName={ctx.patientName}
              triggerLabel="Pay separately"
            />
          ) : null
        }
        patientName={ctx?.patientName}
        departmentName={ctx?.departmentName ?? null}
        departmentColor={ctx?.departmentColor ?? null}
        initialPayload={invoiceDraft}
        draftKey={invoiceDraftKey}
      />

      <CancelAppointmentDialog
        open={cancelOpen}
        onOpenChange={(o) => {
          if (o) setCancelOpen(true);
          else resetCancelState();
        }}
        onConfirm={runCancel}
        isPending={isCancelling}
      />

      <NoShowDialog
        open={noShowOpen}
        onOpenChange={(o) => {
          if (o) setNoShowOpen(true);
          else resetNoShowState();
        }}
        onConfirm={runNoShow}
        isPending={isNoShow}
      />
    </>
  );
}
