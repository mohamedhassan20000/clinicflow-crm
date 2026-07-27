"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";
import { DeleteConfirmDialog } from "@/components/appointments/delete-confirm-dialog";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

// ── Single appointment row inside the popup ───────────────────────────────────

function PopupAppointmentRow({
  appt,
  canEdit,
  currentUserId,
  currentUserRole,
  onDeleted,
}: {
  appt: AppointmentForDetail;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("appointments");
  const { formatTime } = useClinicSettings();
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();

  const time = formatTime(appt.scheduled_at);
  const deptColor = appt.departments?.color ?? "#64748b";
  const deptName = appt.departments?.name ?? t("general");
  const patientName = appt.patients?.full_name ?? t("unknown");

  function handleDelete() {
    startDelete(async () => {
      const res = await softDeleteAppointment(appt.id);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success(t("appointmentMovedToTrashForPatient", { patient: patientName }), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => {
              restoreAppointment(appt.id).then((r) => {
                if (r.error) toast.error(r.error);
              });
            },
          },
        });
        onDeleted(appt.id);
      }
    });
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setDetailOpen(true);
        }}
        className="flex items-start gap-3 px-3 py-3 cursor-pointer hover:brightness-[0.97] transition-[filter]"
        style={{
          backgroundColor: `color-mix(in oklab, ${deptColor} 4%, transparent)`,
        }}
      >
        {/* Colored vertical bar */}
        <span
          aria-hidden
          className="mt-1 h-10 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: deptColor }}
        />

        {/* Time */}
        <div className="w-14 shrink-0 font-mono text-sm font-semibold tabular-nums leading-snug">
          {time}
        </div>

        {/* Patient + info */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate font-medium text-foreground">
              {patientName}
            </span>
            <span
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
                color: deptColor,
              }}
            >
              {deptName}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {appt.profiles?.full_name
              ? formatDoctorName(appt.profiles.full_name)
              : t("unassigned")}
          </div>
          <StatusBadge status={appt.status} />
          {(canEdit || currentUserRole === "doctor") && (
            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
              <AppointmentActions
                appointmentId={appt.id}
                currentStatus={appt.status}
                patientId={appt.patient_id}
                doctorId={appt.doctor_id}
                scheduledAt={appt.scheduled_at}
                durationMinutes={appt.duration_minutes}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
                hasInsurance={Boolean(appt.insurance_provider_id)}
              />
            </div>
          )}
        </div>

        {/* Trash */}
        {canEdit && (appt.status === "pending" || appt.status === "confirmed") && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground/40 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
            disabled={isDeleting}
            title={t("moveToTrash")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <AppointmentDetailDialog
        appointment={appt}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        canEdit={canEdit}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        onDeleted={() => onDeleted(appt.id)}
      />
      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleDelete}
        disabled={isDeleting}
      />
    </>
  );
}

// ── Exported dialog ───────────────────────────────────────────────────────────

export function HourAppointmentsDialog({
  appointments: initialAppointments,
  bucketMin,
  open,
  onOpenChange,
  canEdit,
  currentUserId,
  currentUserRole,
}: {
  appointments: AppointmentForDetail[];
  bucketMin: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
}) {
  const t = useTranslations("appointments");
  const { formatSlotTime } = useClinicSettings();
  const [appointments, setAppointments] = useState(initialAppointments);

  const sorted = [...appointments].sort((a, b) => {
    const deptA = a.departments?.name ?? "";
    const deptB = b.departments?.name ?? "";
    if (deptA !== deptB) return deptA.localeCompare(deptB);
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });

  const h = Math.floor(bucketMin / 60);
  const hourLabel = formatSlotTime(`${String(h).padStart(2, "0")}:00`);

  function handleDeleted(id: string) {
    setAppointments((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[50vw] min-w-[600px] h-[70vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/40 px-4 pb-3 pt-4">
          <DialogTitle>
              {t("appointmentsAtHour", { count: appointments.length, hour: hourLabel })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 divide-y divide-border/20 overflow-y-auto">
          {sorted.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t("allAppointmentsHaveBeenRemoved")}</div>
          ) : (
            sorted.map((appt) => (
              <PopupAppointmentRow
                key={appt.id}
                appt={appt}
                canEdit={canEdit}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
                onDeleted={handleDeleted}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
