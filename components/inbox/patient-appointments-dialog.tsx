"use client";

import { useCallback, useState } from "react";
import { CalendarDays, CheckCircle2, Loader2, PhoneOff, AlertCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import {
  listConversationPatientAppointments,
  type InboxPastAppointment,
} from "@/actions/inbox-patient-appointments";
import { StatusBadge } from "@/components/appointments/status-badge";
import { RecordFollowupDialog } from "@/components/followups/record-dialog";
import type { PendingRow } from "@/components/followups/followups-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const OUTCOME_META = {
  all_fine: {
    labelKey: "outcomeAllFine",
    icon: CheckCircle2,
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  has_problem: {
    labelKey: "outcomeHasProblem",
    icon: AlertCircle,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  no_response: {
    labelKey: "outcomeNoResponse",
    icon: PhoneOff,
    className: "border-border/60 bg-muted/40 text-muted-foreground",
  },
} as const;

type LoadedPatient = {
  id: string;
  fullName: string;
  phone: string;
  fileNumber: string | null;
  nationalId: string | null;
  departmentId: string | null;
};

/**
 * P12 — the patient's visits, without leaving the thread.
 *
 * ### Why a dialog and not a link to Appointments
 *
 * The question ("when was she last in? did anyone call her after?") is asked
 * *while* typing a reply. A link answers it by throwing away the reply, the
 * scroll position and the selected conversation. The panel closes and the
 * thread is still exactly where it was.
 *
 * ### Why the follow-up here is the Follow-ups page's own dialog
 *
 * `RecordFollowupDialog` already owns what a follow-up is: the three outcomes,
 * the note that `has_problem` requires, the `recordFollowup` action with its
 * role gate, the undo toast, and the `router.refresh()` afterwards. This file
 * builds the {@link PendingRow} that dialog expects out of the appointment it
 * already has and hands it over. There is no second follow-up code path, no
 * second validation of the outcome, and no second write.
 *
 * It is rendered as a *sibling* of this panel rather than inside it: two
 * nested Radix dialogs fight over the focus trap, and closing the inner one on
 * save would take the outer one's focus with it.
 *
 * That dialog navigates nowhere on save — it calls `onOpenChange(false)` and
 * `router.refresh()` — which is exactly what keeps the Inbox open underneath:
 * a refresh re-renders the page's server component in place, and this panel's
 * own state (which is client state, in this component) survives it. Reloading
 * the list afterwards is this component's job, and it does it by calling the
 * same read action again rather than by a navigation.
 */
export function PatientAppointmentsDialog({
  conversationId,
  patientId,
  patientName,
  open,
  onOpenChange,
}: {
  conversationId: string;
  /** The conversation's authoritative patient link. Null means no history. */
  patientId: string | null;
  patientName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("inbox");
  const followupsT = useTranslations("followups");
  const format = useFormatter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patient, setPatient] = useState<LoadedPatient | null>(null);
  const [appointments, setAppointments] = useState<InboxPastAppointment[]>([]);
  const [followupFor, setFollowupFor] = useState<InboxPastAppointment | null>(null);

  /**
   * Depends on the conversation and nothing else, deliberately.
   *
   * `t` from `useTranslations` is a fresh function on every render. Closing
   * over it here would make `load` a new function on every render too, the
   * effect below would re-run on every render, and each run would set state and
   * cause the next one: a spinner that never stops. So the generic failure is
   * carried as an empty string and translated at the point it is rendered.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await listConversationPatientAppointments({ conversationId });
    setLoading(false);
    if (result.error || !result.appointments || !result.patient) {
      setError(result.error ?? "");
      setAppointments([]);
      return;
    }
    setPatient(result.patient);
    setAppointments(result.appointments);
  }, [conversationId]);

  /**
   * The row `RecordFollowupDialog` was written against, built from what this
   * panel already holds. Nothing is invented: every field is either the
   * appointment's own column or the patient the conversation is linked to.
   */
  function pendingRow(appointment: InboxPastAppointment): PendingRow | null {
    if (!patient) return null;
    return {
      id: appointment.id,
      scheduled_at: appointment.scheduledAt,
      paid_at: appointment.paidAt,
      patient_id: patient.id,
      department_id: appointment.departmentId,
      doctor_id: appointment.doctorId,
      total_amount: appointment.totalAmount,
      payment_note: appointment.paymentNote,
      patients: {
        id: patient.id,
        full_name: patient.fullName,
        phone: patient.phone,
        file_number: patient.fileNumber,
        national_id: patient.nationalId,
        department_id: patient.departmentId,
      },
      profiles: appointment.doctorName ? { full_name: appointment.doctorName } : null,
      departments: appointment.departmentId
        ? {
            id: appointment.departmentId,
            name: appointment.departmentName ?? "",
            color: appointment.departmentColor ?? "#94a3b8",
          }
        : null,
    };
  }

  const activeRow = followupFor ? pendingRow(followupFor) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-2xl"
          data-testid="past-appointments-panel"
          /*
           * The read is hung off the panel opening, not off an effect that
           * watches `open`. Opening is an event, and treating it as one keeps
           * the fetch out of the render path entirely — no synchronous state
           * write inside an effect, and no chance of the read re-firing because
           * something above re-rendered. It runs again on every re-open, which
           * is what stops a follow-up recorded elsewhere in the app from
           * leaving a stale "Add follow-up" here.
           */
          onOpenAutoFocus={() => {
            if (!patientId) return;
            void load();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("pastAppointments.title")}</DialogTitle>
            <DialogDescription>
              {patientName
                ? t("pastAppointments.descriptionFor", { name: patientName })
                : t("pastAppointments.description")}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("pastAppointments.loading")}
            </p>
          ) : error ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-destructive">
                {error || t("pastAppointments.error")}
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {t("pastAppointments.retry")}
              </Button>
            </div>
          ) : appointments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("pastAppointments.empty")}
            </p>
          ) : (
            <ul className="max-h-[26rem] space-y-2 overflow-y-auto">
              {appointments.map((appointment) => {
                const outcome = appointment.followup
                  ? OUTCOME_META[appointment.followup.outcome]
                  : null;
                const OutcomeIcon = outcome?.icon;
                return (
                  <li
                    key={appointment.id}
                    className="rounded-lg border bg-card p-3"
                    data-testid="past-appointment-row"
                    data-appointment-id={appointment.id}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                      <span className="text-sm font-medium">
                        {format.dateTime(new Date(appointment.scheduledAt), {
                          dateStyle: "medium",
                        })}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {format.dateTime(new Date(appointment.scheduledAt), {
                          timeStyle: "short",
                        })}
                      </span>
                      <StatusBadge status={appointment.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground" dir="auto">
                      {appointment.doctorName ?? t("pastAppointments.noDoctor")}
                      {appointment.departmentName ? ` · ${appointment.departmentName}` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {outcome && OutcomeIcon ? (
                        <Badge
                          variant="outline"
                          className={cn("gap-1", outcome.className)}
                          data-testid="past-appointment-followup-done"
                        >
                          <OutcomeIcon className="size-3" aria-hidden />
                          {followupsT(outcome.labelKey)}
                        </Badge>
                      ) : appointment.followupPending ? (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="past-appointment-add-followup"
                          onClick={() => setFollowupFor(appointment)}
                        >
                          {t("pastAppointments.addFollowup")}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("pastAppointments.noFollowup")}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <RecordFollowupDialog
        row={activeRow}
        open={Boolean(activeRow)}
        onOpenChange={(next) => {
          if (next) return;
          setFollowupFor(null);
          // Whatever happened in there — saved, cancelled, or undone — the
          // truth about this appointment now lives in the database. Re-read it
          // rather than guessing, and do it without leaving the Inbox.
          void load();
        }}
      />
    </>
  );
}
