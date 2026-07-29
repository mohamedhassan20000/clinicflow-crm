"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Repeat, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReplaceAppointmentDialog } from "@/components/appointments/replace-appointment-dialog";
import { cn } from "@/lib/utils";
import {
  arriveAppointment,
  getBillingContext,
  getInvoiceUndoEligibility,
  startAppointmentSession,
  updateAppointmentStatus,
  undoAppointmentStatus,
  undoInvoiceCompletion,
  getConflictingPendingAppointments,
  type BillingContext,
  type ConflictingAppointment,
} from "@/actions/appointments";
import { ConflictResolutionModal } from "@/components/appointments/conflict-resolution-modal";
import type { Database } from "@/types/database";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";
import { CancelAppointmentDialog } from "@/components/appointments/cancel-dialog";
import { NoShowDialog } from "@/components/appointments/noshow-dialog";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";
import { useTranslations } from "next-intl";
import type {
  BillingUndoEligibility,
  BillingUndoEligibilityReason,
} from "@/lib/appointments/billing-undo";

type Status = Database["public"]["Enums"]["appointment_status"];
type UserRole = "admin" | "receptionist" | "manager" | "doctor" | "assistant";
type RestorableStatus = Extract<Status, "pending" | "confirmed" | "arrived" | "in_session">;
type PendingAction =
  | "confirm"
  | "arrive"
  | "start_session"
  | "complete"
  | "cancel"
  | "no_show"
  | "undo";

const TERMINAL: Status[] = ["completed", "cancelled", "no_show", "replaced"];

function AppointmentActionsInner({
  appointmentId,
  currentStatus,
  patientId,
  doctorId,
  scheduledAt,
  durationMinutes,
  currentUserId,
  currentUserRole = "receptionist",
  onActionComplete,
  onBillingChanged,
  showBillingUndo = false,
}: {
  appointmentId: string;
  currentStatus: Status;
  patientId?: string;
  doctorId?: string;
  scheduledAt?: string;
  durationMinutes?: number;
  currentUserId?: string;
  currentUserRole?: UserRole;
  /** @deprecated kept for back-compat */
  hasInsurance?: boolean;
  /** Called after a terminal action (cancel, no-show) succeeds. */
  onActionComplete?: () => void;
  /** Refreshes dialog-local invoice and activity state after billing changes. */
  onBillingChanged?: () => void;
  /** Persistent billing Undo belongs in the appointment detail dialog only. */
  showBillingUndo?: boolean;
}) {
  const t = useTranslations("appointments");
  const router = useRouter();
  const [billingOpen, setBillingOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [isNoShow, setIsNoShow] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Status | null>(null);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictingAppointment[]>([]);
  const [ctx, setCtx] = useState<BillingContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<BillingPayload | null>(null);
  const [invoiceDraftKey, setInvoiceDraftKey] = useState(0);
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoEligibility, setUndoEligibility] =
    useState<BillingUndoEligibility | null>(null);
  const [loadingUndoEligibility, setLoadingUndoEligibility] = useState(false);

  const effectiveStatus = optimisticStatus ?? currentStatus;
  const isTerminal = TERMINAL.includes(effectiveStatus);
  const hasPendingAction = pendingAction !== null;
  const isFrontDesk =
    currentUserRole === "admin" || currentUserRole === "receptionist";
  // Non-financial operational status actions (confirm / check-in / cancel /
  // no-show). Managers and assistants operate their scoped appointments; the
  // data layer (RLS + scoped guards) still limits an assistant to their assigned
  // doctors' appointments.
  const canOperate =
    isFrontDesk ||
    currentUserRole === "manager" ||
    currentUserRole === "assistant";
  const canReplace = canOperate || currentUserRole === "doctor";
  // Completion opens the billing dialog — a financial action. Assistants are
  // excluded (kept read-only for financials); managers/front-desk may complete.
  const canComplete = isFrontDesk || currentUserRole === "manager";
  const isAssignedDoctor =
    currentUserRole === "doctor" &&
    effectiveStatus === "arrived" &&
    Boolean(currentUserId) &&
    doctorId === currentUserId;

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
              : t("failedToLoadInvoiceDetails"),
          );
        })
        .finally(() => {
          if (active) setLoadingCtx(false);
        });
    });
    return () => {
      active = false;
    };
  }, [billingOpen, appointmentId, ctx, t]);

  useEffect(() => {
    if (!showBillingUndo || effectiveStatus !== "completed") return;

    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoadingUndoEligibility(true);
      getInvoiceUndoEligibility(appointmentId)
        .then((eligibility) => {
          if (active) setUndoEligibility(eligibility);
        })
        .catch(() => {
          if (!active) return;
          setUndoEligibility({
            canUndo: false,
            reason: "activity_unavailable",
            targetStatus: null,
            completionEventId: null,
            completionOccurredAt: null,
            expiresAt: null,
          });
        })
        .finally(() => {
          if (active) setLoadingUndoEligibility(false);
        });
    });

    return () => {
      active = false;
    };
  }, [appointmentId, effectiveStatus, showBillingUndo]);

  useEffect(() => {
    if (!undoEligibility?.canUndo || !undoEligibility.expiresAt) return;
    const remaining =
      new Date(undoEligibility.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(() => {
      setUndoEligibility((current) =>
        current?.completionEventId === undoEligibility.completionEventId
          ? { ...current, canUndo: false, reason: "expired" }
          : current,
      );
    }, Math.max(0, remaining) + 25);
    return () => window.clearTimeout(timer);
  }, [undoEligibility]);

  const showBillingUndoAction =
    showBillingUndo && effectiveStatus === "completed";
  if (isTerminal && !showBillingUndoAction) return null;

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

  function reopenInvoiceDraft(payload: BillingPayload, targetStatus: Status) {
    setInvoiceDraft(payload);
    setInvoiceDraftKey((key) => key + 1);
    setOptimisticStatus(targetStatus);
    setCtx(null);
    setBillingOpen(true);
  }

  function billingUndoReason(reason: BillingUndoEligibilityReason): string {
    const key = {
      eligible: "billingUndoUnavailableReason",
      unauthorized: "billingUndoUnauthorizedReason",
      appointment_not_found: "billingUndoAppointmentMissingReason",
      not_completed: "billingUndoNotCompletedReason",
      completion_event_missing: "billingUndoMissingEventReason",
      completion_already_undone: "billingUndoAlreadyUndoneReason",
      invalid_previous_status: "billingUndoInvalidPreviousStatusReason",
      expired: "billingUndoExpiredReason",
      activity_unavailable: "billingUndoUnavailableReason",
    } as const;
    return t(key[reason]);
  }

  async function runBillingUndo(payload?: BillingPayload) {
    if (pendingActionRef.current) return;
    setActionPending("undo");
    setIsUndoing(true);

    try {
      const result = await undoInvoiceCompletion(appointmentId);
      if (result.error || !result.targetStatus) {
        if (result.eligibility) setUndoEligibility(result.eligibility);
        toast.error(result.error ?? t("billingUndoUnavailableReason"));
        return;
      }

      setOptimisticStatus(result.targetStatus);
      setUndoEligibility(null);
      if (payload) {
        reopenInvoiceDraft(payload, result.targetStatus);
      }
      toast.success(t("billingCompletionUndone"));
      onBillingChanged?.();
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("billingUndoUnavailableReason"),
      );
    } finally {
      setIsUndoing(false);
      setActionPending(null);
    }
  }

  function doUndo(targetStatus: Status, fallbackStatus: Status) {
    if (pendingActionRef.current) return;
    if (
      targetStatus !== "pending" &&
      targetStatus !== "confirmed" &&
      targetStatus !== "arrived" &&
      targetStatus !== "in_session"
    ) {
      toast.error(t("thisAppointmentCannotBeRestoredTo"));
      return;
    }

    pendingActionRef.current = "undo";
    setIsUndoing(true);

    undoAppointmentStatus(appointmentId, targetStatus as RestorableStatus)
      .then((res) => {
        if (res.error) {
          toast.error(res.error);
          setOptimisticStatus(fallbackStatus);
          setIsUndoing(false);
        } else {
          setOptimisticStatus(targetStatus);
          setIsUndoing(false);
        }
      })
      .finally(() => {
        pendingActionRef.current = null;
      });
  }

  function runStatus(newStatus: Status) {
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    setActionPending(newStatus === "confirmed" ? "confirm" : null);
    setOptimisticStatus(newStatus);

    updateAppointmentStatus(appointmentId, newStatus)
      .then((result) => {
        if (result.error) {
          toast.error(result.error);
          setOptimisticStatus(null);
        } else {
          toast.success(t("appointmentStatusUpdated", { status: newStatus }), {
            duration: 10000,
            action: {
              label: t("undo"),
              onClick: () => doUndo(prevStatus, newStatus),
            },
          });
        }
      })
      .finally(() => {
        setActionPending(null);
      });
  }

  function runArrive() {
    if (pendingActionRef.current) return;
    const prevStatus = effectiveStatus;
    setActionPending("arrive");
    setOptimisticStatus("arrived");

    arriveAppointment(appointmentId)
      .then((result) => {
        if (result.error) {
          toast.error(result.error);
          setOptimisticStatus(null);
        } else {
          toast.success(t("appointmentMarkedAsArrived"), {
            duration: 10000,
            action: {
              label: t("undo"),
              onClick: () => doUndo(prevStatus, "arrived"),
            },
          });
        }
      })
      .finally(() => {
        setActionPending(null);
      });
  }

  function runStartSession() {
    if (pendingActionRef.current) return;
    setActionPending("start_session");
    setOptimisticStatus("in_session");

    startAppointmentSession(appointmentId)
      .then((result) => {
        if (result.error) {
          toast.error(result.error);
          setOptimisticStatus(null);
          return;
        }

        const targetPatientId = result.patientId ?? patientId;
        const redirectTo =
          result.redirectTo ??
          (targetPatientId
            ? `/patients/${targetPatientId}/medical-notes-report`
            : null);

        toast.success(t("sessionStarted"), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => {
              doUndo("arrived", "in_session");
              if (
                redirectTo &&
                typeof window !== "undefined" &&
                window.location.pathname === redirectTo
              ) {
                router.back();
              }
            },
          },
        });

        if (!redirectTo) {
          toast.message(t("openThePatientProfileToView"));
          return;
        }

        try {
          router.push(redirectTo);
        } catch {
          toast.message(t("sessionIsInProgress"), {
            action: {
              label: t("openNotes"),
              onClick: () => router.push(redirectTo),
            },
          });
        }
      })
      .finally(() => {
        setActionPending(null);
      });
  }

  async function handleConfirmClick() {
    if (pendingActionRef.current) return;
    setActionPending("confirm");
    const result = await getConflictingPendingAppointments(appointmentId);
    if (result.error) {
      toast.error(result.error);
      setActionPending(null);
      return;
    }
    if (!result.data?.length) {
      // No conflicts — proceed with normal confirm flow
      setActionPending(null);
      runStatus("confirmed");
      return;
    }
    // Conflicts found — show resolution modal
    setConflicts(result.data);
    setConflictModalOpen(true);
    setActionPending(null);
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
        onActionComplete?.();
        toast.success(t("appointmentCancelled"), {
          duration: 10000,
          action: {
            label: t("undo"),
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
        onActionComplete?.();
        toast.success(t("appointmentMarkedAsNoShow"), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => doUndo(prevStatus, "no_show"),
          },
        });
      }
    });
  }

  function runComplete(payload: BillingPayload) {
    if (pendingActionRef.current) return;
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
        toast.success(t("appointmentCompletedCharged"), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => void runBillingUndo(payload),
          },
        });
        onBillingChanged?.();
        router.refresh();
        resetBillingState();
      }
    });
  }

  const showConfirm = canOperate && effectiveStatus === "pending";
  const showArrive = canOperate && effectiveStatus === "confirmed";
  const showComplete =
    canComplete &&
    (effectiveStatus === "confirmed" ||
      effectiveStatus === "arrived" ||
      effectiveStatus === "in_session");
  const showCancel =
    canOperate &&
    (effectiveStatus === "pending" ||
      effectiveStatus === "confirmed");
  const showNoShow = canOperate && effectiveStatus === "confirmed";
  const showStartSession = isAssignedDoctor;
  // Replace is a dedicated reschedule workflow, only for a FUTURE pending/
  // confirmed appointment. Non-financial → available to the same operators.
  const showReplace =
    canReplace &&
    (effectiveStatus === "pending" || effectiveStatus === "confirmed") &&
    !!doctorId &&
    !!scheduledAt &&
    new Date(scheduledAt) > new Date();
  const checkingBillingUndo =
    showBillingUndoAction &&
    (loadingUndoEligibility || undoEligibility === null);
  const billingUndoDisabled =
    checkingBillingUndo ||
    !undoEligibility?.canUndo ||
    hasPendingAction ||
    isUndoing;
  const billingUndoStatus =
    checkingBillingUndo
      ? t("checkingUndoEligibility")
      : undoEligibility && !undoEligibility.canUndo
        ? billingUndoReason(undoEligibility.reason)
        : null;

  if (
    !showConfirm &&
    !showArrive &&
    !showComplete &&
    !showCancel &&
    !showNoShow &&
    !showStartSession &&
    !showReplace &&
    !showBillingUndoAction
  ) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {showBillingUndoAction && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[11px] font-semibold"
              disabled={billingUndoDisabled}
              onClick={() => void runBillingUndo()}
              title={billingUndoStatus ?? t("undoBillingCompletion")}
              aria-describedby={
                billingUndoStatus
                  ? `billing-undo-reason-${appointmentId}`
                  : undefined
              }
            >
              {isUndoing ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <Undo2
                  className="size-3 rtl:-scale-x-100"
                  aria-hidden="true"
                />
              )}
              {isUndoing
                ? t("undoingBillingCompletion")
                : t("undoBillingCompletion")}
            </Button>
            {billingUndoStatus && (
              <span
                id={`billing-undo-reason-${appointmentId}`}
                className="text-[11px] text-muted-foreground"
                role="status"
              >
                {billingUndoStatus}
              </span>
            )}
          </div>
        )}
        {showConfirm && (
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
            onClick={handleConfirmClick}
          >
            {t("confirm")}</Button>
        )}
        {showArrive && (
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
            onClick={runArrive}
          >
            {t("arrive")}</Button>
        )}
        {showStartSession && (
          <Button
            size="sm"
            variant="default"
            className={cn(
              "h-6 px-2 text-[10px] font-semibold",
              "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600 shadow-sm",
            )}
            disabled={hasPendingAction}
            onClick={runStartSession}
          >
            {t("startSession")}</Button>
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
            {t("complete")}</Button>
        )}
        {showNoShow && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
            onClick={() => setNoShowOpen(true)}
          >
            {t("noShow")}</Button>
        )}
        {showCancel && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
            onClick={() => setCancelOpen(true)}
          >
            {t("cancel")}</Button>
        )}
        {showReplace && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[10px] font-semibold"
            disabled={hasPendingAction}
            onClick={() => setReplaceOpen(true)}
          >
            <Repeat className="size-3" aria-hidden="true" />
            {t("replace")}</Button>
        )}
      </div>

      {showReplace && scheduledAt && doctorId && (
        <ReplaceAppointmentDialog
          open={replaceOpen}
          onOpenChange={setReplaceOpen}
          appointmentId={appointmentId}
          doctorId={doctorId}
          defaultScheduledAt={scheduledAt}
          defaultDurationMinutes={durationMinutes ?? 30}
          onReplaced={() => {
            onActionComplete?.();
            router.refresh();
          }}
        />
      )}

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
              triggerLabel={t("paySeparately")}
            />
          ) : null
        }
        patientName={ctx?.patientName}
        departmentName={ctx?.departmentName ?? null}
        departmentColor={ctx?.departmentColor ?? null}
        packageInfo={ctx?.packageInfo ?? null}
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

      <ConflictResolutionModal
        open={conflictModalOpen}
        onOpenChange={setConflictModalOpen}
        appointmentId={appointmentId}
        conflicts={conflicts}
        onConfirmed={() => setOptimisticStatus("confirmed")}
      />
    </>
  );
}

export const AppointmentActions = memo(AppointmentActionsInner);
