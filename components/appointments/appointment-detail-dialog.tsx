"use client";

import { useState, useTransition } from "react";
import { Phone, Stethoscope, Calendar, Clock, FileText, Hash, Trash2, Package, ShieldCheck, Bot } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { ReplacementChain } from "@/components/appointments/replacement-chain";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DeleteConfirmDialog } from "@/components/appointments/delete-confirm-dialog";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";
import { isOverduePending } from "@/lib/appointments/overdue-pending";

export type AppointmentForDetail = Pick<
  Tables<"appointments">,
  | "id"
  | "patient_id"
  | "doctor_id"
  | "scheduled_at"
  | "status"
  | "insurance_provider_id"
  | "notes"
  | "duration_minutes"
  | "package_id"
  | "package_session_number"
  | "replaces_appointment_id"
  | "replaced_by_appointment_id"
> & {
  ai_patient_conversation_id?: string | null;
  total_amount?: number | null;
  insurance_amount?: number | null;
  insurance_calculation_mode?: string | null;
  insurance_percentage?: number | null;
  patient_responsibility?: number | null;
  paid_amount?: number | null;
  secondary_amount?: number | null;
  deposit_amount?: number | null;
  outstanding_amount?: number | null;
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
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
  onDeleted?: () => void;
}

export function AppointmentDetailDialog({
  appointment: appt,
  open,
  onOpenChange,
  canEdit,
  currentUserId,
  currentUserRole,
  onDeleted,
}: Props) {
  const t = useTranslations("appointments");
  const protectedT = useTranslations("protected");
  const { formatCurrency, formatDate, formatTime } = useClinicSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [billingRevision, setBillingRevision] = useState(0);

  if (!appt) return null;

  const overduePending = isOverduePending(appt);
  const deptColor = appt.departments?.color ?? "#94a3b8";
  const patientName = appt.patients?.full_name ?? t("unknownPatient");
  const apptId = appt.id;
  const packageInfo = appt.patient_packages;
  const packageRemaining = packageInfo
    ? Math.max(0, Number(packageInfo.total_sessions) - Number(packageInfo.used_sessions))
    : 0;
  const invoiceTotal = appt.total_amount ?? 0;
  const insuranceAmount = appt.insurance_amount ?? 0;
  const patientResponsibility =
    appt.patient_responsibility ??
    Math.max(0, invoiceTotal - insuranceAmount);
  const totalPatientPaid =
    (appt.paid_amount ?? 0) + (appt.secondary_amount ?? 0);

  function handleDelete() {
    startDelete(async () => {
      const res = await softDeleteAppointment(apptId);
      if (res.error) {
        toast.error(res.error);
      } else {
        onOpenChange(false);
        onDeleted?.();
        toast.success(t("appointmentMovedToTrashForPatient", { patient: patientName }), {
          duration: 10000,
          action: {
            label: t("undo"),
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
        <DialogContent
          layout="flex"
          className="max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:max-w-md"
          data-testid="appointment-detail-dialog"
        >
          {canEdit && (appt.status === "pending" || appt.status === "confirmed") && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 end-10 h-7 w-7 text-muted-foreground/40 hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={isDeleting}
              title={t("moveToTrash")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <DialogHeader className="shrink-0 border-b border-border/40 px-4 pb-3 pe-20 pt-4">
            <div className="flex items-center gap-2">
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

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
            data-testid="appointment-detail-scroll-area"
          >
            <div className="space-y-4">
              {/* Patient info */}
              <section className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("patient")}
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
                  {t("appointment")}
                </p>
                <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {formatDate(appt.scheduled_at, {
                        weekday: "long",
                        day: "2-digit",
                        month: "long",
                        year: "numeric",
                      })}
                    </span>
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
                      <span className="text-muted-foreground">
                        {t("durationMinutes", {
                          count: appt.duration_minutes,
                        })}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <StatusBadge status={appt.status} />
                    {appt.ai_patient_conversation_id && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary">
                        <Bot className="size-3" aria-hidden="true" />
                        {protectedT("aiAssistant")}
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {(appt.replaced_by_appointment_id ||
                appt.replaces_appointment_id) && (
                <ReplacementChain key={appt.id} appointmentId={appt.id} />
              )}

              {packageInfo && (
                <section className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("package")}
                  </p>
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3 text-sm">
                    <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium text-emerald-800 dark:text-emerald-300">
                        {packageInfo.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("packageSessionProgress", {
                          session: appt.package_session_number ?? "—",
                          total: packageInfo.total_sessions,
                          remaining: packageRemaining,
                        })}
                      </p>
                    </div>
                  </div>
                </section>
              )}

              {appt.status === "completed" && invoiceTotal > 0 && (
                <section className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("billingSummary")}
                  </p>
                  <div className="space-y-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-3 text-sm">
                    <FinancialLine
                      label={t("invoiceTotal")}
                      value={formatCurrency(invoiceTotal)}
                    />
                    <FinancialLine
                      label={
                        appt.insurance_calculation_mode === "percentage" &&
                        appt.insurance_percentage != null
                          ? t("insuranceContributionWithPercentage", {
                              percentage: appt.insurance_percentage,
                            })
                          : t("insuranceContribution")
                      }
                      value={formatCurrency(insuranceAmount)}
                      icon={<ShieldCheck className="size-3.5 text-sky-700 dark:text-sky-400" aria-hidden />}
                    />
                    <FinancialLine
                      label={t("patientResponsibility")}
                      value={formatCurrency(patientResponsibility)}
                    />
                    <FinancialLine
                      label={t("totalPatientPaid")}
                      value={formatCurrency(totalPatientPaid)}
                    />
                    {(appt.deposit_amount ?? 0) > 0 && (
                      <FinancialLine
                        label={t("depositApplied")}
                        value={formatCurrency(appt.deposit_amount ?? 0)}
                      />
                    )}
                    <FinancialLine
                      label={t("remainingPatientBalance")}
                      value={formatCurrency(appt.outstanding_amount ?? 0)}
                    />
                  </div>
                </section>
              )}

              {/* Notes */}
              {appt.notes && (
                <section className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("notes")}
                  </p>
                  <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-3">
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {appt.notes}
                    </p>
                  </div>
                </section>
              )}

              {/* Activity trail (Phase 8D) */}
              <ActivityTimeline
                key={`${apptId}:${billingRevision}`}
                entityType="appointment"
                entityId={apptId}
              />
            </div>
          </div>

          {/* Status actions stay visible while the appointment details scroll. */}
          {(canEdit || currentUserRole === "doctor") && (
            <DialogFooter
              flush
              className="shrink-0 rounded-none empty:hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <AppointmentActions
                appointmentId={appt.id}
                currentStatus={appt.status}
                patientId={appt.patient_id}
                doctorId={appt.doctor_id}
                scheduledAt={appt.scheduled_at}
                durationMinutes={appt.duration_minutes}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
                onActionComplete={() => onOpenChange(false)}
                onBillingChanged={() =>
                  setBillingRevision((revision) => revision + 1)
                }
                showBillingUndo
                overduePending={overduePending}
              />
            </DialogFooter>
          )}
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

function FinancialLine({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
