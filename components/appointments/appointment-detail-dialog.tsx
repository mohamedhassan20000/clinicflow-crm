"use client";

import { useState, useTransition } from "react";
import { Phone, Stethoscope, Calendar, Clock, FileText, Hash, Trash2, Package } from "lucide-react";
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
import { DeleteConfirmDialog } from "@/components/appointments/delete-confirm-dialog";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

export type AppointmentForDetail = Pick<
  Tables<"appointments">,
  | "id"
  | "scheduled_at"
  | "status"
  | "insurance_provider_id"
  | "notes"
  | "duration_minutes"
  | "package_id"
  | "package_session_number"
> & {
  patients: {
    full_name: string;
    phone: string;
    file_number: string | null;
  } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
  patient_packages: {
    name: string;
    total_sessions: number;
    used_sessions: number;
    price_per_session: number | null;
  } | null;
};

interface Props {
  appointment: AppointmentForDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  onDeleted?: () => void;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function AppointmentDetailDialog({
  appointment: appt,
  open,
  onOpenChange,
  canEdit,
  onDeleted,
}: Props) {
  const { formatTime } = useClinicSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();

  if (!appt) return null;

  const deptColor = appt.departments?.color ?? "#94a3b8";
  const patientName = appt.patients?.full_name ?? "Unknown patient";
  const apptId = appt.id;
  const packageInfo = appt.patient_packages;
  const packageRemaining = packageInfo
    ? Math.max(0, Number(packageInfo.total_sessions) - Number(packageInfo.used_sessions))
    : 0;

  function handleDelete() {
    startDelete(async () => {
      const res = await softDeleteAppointment(apptId);
      if (res.error) {
        toast.error(res.error);
      } else {
        onOpenChange(false);
        onDeleted?.();
        toast.success(`${patientName} moved to trash.`, {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => {
              restoreAppointment(apptId).then((r) => {
                if (r.error) toast.error(r.error);
              });
            },
          },
        });
      }
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          {canEdit && (appt.status === "pending" || appt.status === "confirmed") && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-10 h-7 w-7 text-muted-foreground/40 hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={isDeleting}
              title="Move to trash"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <DialogHeader>
            <div className="flex items-center gap-2 pr-2">
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: deptColor }}
              />
              <DialogTitle className="flex-1 text-base leading-snug">
                {patientName}
              </DialogTitle>
            </div>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            {/* Patient info */}
            <section className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Patient
              </p>
              <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-3 space-y-2">
                {appt.patients?.file_number && (
                  <div className="flex items-center gap-2 text-sm">
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs text-muted-foreground">
                      {appt.patients.file_number}
                    </span>
                  </div>
                )}
                {appt.patients?.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm">{appt.patients.phone}</span>
                  </div>
                )}
              </div>
            </section>

            {/* Appointment info */}
            <section className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Appointment
              </p>
              <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{fmtDate(appt.scheduled_at)}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {formatTime(appt.scheduled_at)}
                  </span>
                </div>
                {appt.profiles?.full_name && (
                  <div className="flex items-center gap-2 text-sm">
                    <Stethoscope className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>{formatDoctorName(appt.profiles.full_name)}</span>
                  </div>
                )}
                {appt.departments?.name && (
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: deptColor }}
                    />
                    <span
                      className="text-sm font-medium"
                      style={{ color: deptColor }}
                    >
                      {appt.departments.name}
                    </span>
                  </div>
                )}
                {appt.duration_minutes != null && (
                  <div className="flex items-center gap-2 text-sm">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">{appt.duration_minutes} min</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <StatusBadge status={appt.status} />
                </div>
              </div>
            </section>

            {packageInfo && (
              <section className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Package
                </p>
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3 text-sm">
                  <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-emerald-800 dark:text-emerald-300">
                      {packageInfo.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Session {appt.package_session_number ?? "—"} of{" "}
                      {packageInfo.total_sessions} · {packageRemaining} remaining
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* Notes */}
            {appt.notes && (
              <section className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Notes
                </p>
                <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-3">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {appt.notes}
                  </p>
                </div>
              </section>
            )}

            {/* Status actions */}
            {canEdit && (
              <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                <AppointmentActions
                  appointmentId={appt.id}
                  currentStatus={appt.status}
                  onActionComplete={() => onOpenChange(false)}
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleDelete}
        disabled={isDeleting}
      />
    </>
  );
}
