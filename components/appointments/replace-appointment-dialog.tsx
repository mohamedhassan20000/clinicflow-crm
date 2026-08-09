"use client";

import { useEffect, useState } from "react";
import { Check, Clock3, Loader2, Repeat } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SingleDatePicker } from "@/components/ui/clinic-date-picker";
import {
  getReplacementAvailability,
  getReplacementDoctorOptions,
  replaceAppointment,
  type ReplacementDoctorOption,
} from "@/actions/appointments";
import type { AvailabilityResult, SlotInfo } from "@/lib/booking/availability";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The dedicated Replace workflow: pick a new date/time; the server creates a
 * linked replacement, marks this appointment `replaced`, and keeps it in history.
 * Only offered for a FUTURE pending/confirmed appointment.
 */
export function ReplaceAppointmentDialog({
  open,
  onOpenChange,
  appointmentId,
  doctorId,
  defaultScheduledAt,
  defaultDurationMinutes,
  onReplaced,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string;
  doctorId: string;
  defaultScheduledAt: string;
  defaultDurationMinutes: number;
  onReplaced?: (newId: string) => void;
}) {
  const t = useTranslations("appointments");
  const { formatSlotTime, locale } = useClinicSettings();
  const [scheduledAt, setScheduledAt] = useState(() =>
    toLocalInputValue(defaultScheduledAt),
  );
  const [selectedDoctorId, setSelectedDoctorId] = useState(doctorId);
  const [doctorOptions, setDoctorOptions] = useState<
    ReplacementDoctorOption[]
  >([]);
  const [loadingDoctors, setLoadingDoctors] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedDate = scheduledAt.slice(0, 10);
  const selectedTime = scheduledAt.slice(11, 16);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoadingDoctors(true);
      getReplacementDoctorOptions(appointmentId)
        .then((result) => {
          if (!active) return;
          if (result.error) {
            toast.error(result.error);
            setDoctorOptions([]);
            return;
          }
          setDoctorOptions(result.data ?? []);
        })
        .catch(() => {
          if (active) {
            setDoctorOptions([]);
            toast.error(t("failedToLoadReplacementDoctors"));
          }
        })
        .finally(() => {
          if (active) setLoadingDoctors(false);
        });
    });
    return () => {
      active = false;
    };
  }, [appointmentId, open, t]);

  useEffect(() => {
    if (!open || !selectedDoctorId || !selectedDate) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSlotsLoading(true);
      setSlotsError(null);
      getReplacementAvailability(
        appointmentId,
        selectedDoctorId,
        selectedDate,
        defaultDurationMinutes,
      )
        .then((result) => {
          if (!active) return;
          if (result.error || !result.data) {
            setAvailability(null);
            setSlotsError(result.error ?? t("availabilityUnableToCalculate"));
            return;
          }
          setAvailability(result.data);
        })
        .catch(() => {
          if (!active) return;
          setAvailability(null);
          setSlotsError(t("availabilityUnableToCalculate"));
        })
        .finally(() => {
          if (active) setSlotsLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [appointmentId, defaultDurationMinutes, open, selectedDate, selectedDoctorId, t]);

  function handleOpenChange(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) {
      setSelectedDoctorId(doctorId);
      setScheduledAt(toLocalInputValue(defaultScheduledAt));
      setDoctorOptions([]);
      setAvailability(null);
      setSlotsError(null);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    if (submitting) return;
    const parsedTime = new Date(scheduledAt);
    if (isNaN(parsedTime.getTime())) {
      toast.error(t("pleaseChooseAValidDateAndTime"));
      return;
    }
    const iso = parsedTime.toISOString();
    if (new Date(iso) <= new Date()) {
      toast.error(t("replacementTimeMustBeInTheFuture"));
      return;
    }
    setSubmitting(true);
    const result = await replaceAppointment({
      original_id: appointmentId,
      doctor_id: selectedDoctorId,
      scheduled_at: iso,
      duration_minutes: defaultDurationMinutes,
    });
    setSubmitting(false);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    toast.success(t("appointmentReplaced"));
    onOpenChange(false);
    if (result.appointmentId) onReplaced?.(result.appointmentId);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[min(90vh,48rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="size-4" aria-hidden="true" />
            {t("replaceAppointment")}
          </DialogTitle>
          <DialogDescription>
            {t("replaceAppointmentDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="replace-doctor">{t("replacementDoctor")}</Label>
          <Select
            value={selectedDoctorId}
            onValueChange={setSelectedDoctorId}
            disabled={submitting || loadingDoctors}
          >
            <SelectTrigger id="replace-doctor" className="w-full">
              <SelectValue
                placeholder={
                  loadingDoctors ? t("loadingDoctors") : t("selectDoctor")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {doctorOptions.map((doctor) => (
                <SelectItem key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
          <div className="space-y-2">
            <Label htmlFor="replace-date">{t("date")}</Label>
            <SingleDatePicker
              id="replace-date"
              value={selectedDate}
              label={t("newDateAndTime")}
              disabled={submitting}
              onChange={(date) => {
                const time = selectedTime || "09:00";
                setScheduledAt(`${date}T${time}`);
              }}
            />
            {availability?.workingHours.length ? (
              <p className="rounded-lg border border-border/60 bg-muted/35 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground">{t("workingHours")}</span>{" "}
                {availability.workingHours
                  .map((window) => `${formatSlotTime(window.start)} – ${formatSlotTime(window.end)}`)
                  .join(" · ")}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label id="replace-time-label">{t("time")}</Label>
              {!slotsLoading && availability?.slots.some((slot) => !slot.disabled) ? (
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                  {t("availableTimeCount", {
                    count: availability.slots.filter((slot) => !slot.disabled).length,
                  })}
                </span>
              ) : null}
            </div>
            <div
              className="min-h-32 rounded-xl border border-border/70 bg-muted/20 p-2.5"
              role="group"
              aria-labelledby="replace-time-label"
              aria-busy={slotsLoading}
              aria-live="polite"
            >
              {slotsLoading ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {Array.from({ length: 12 }, (_, index) => (
                    <span key={index} className="h-9 animate-pulse rounded-lg bg-muted" />
                  ))}
                </div>
              ) : availability?.slots.length ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {availability.slots.map((slot) => (
                    <TimeSlotButton
                      key={slot.time}
                      slot={slot}
                      selected={selectedTime === slot.time}
                      label={formatSlotTime(slot.time)}
                      disabledLabel={slotDisabledLabel(slot, t)}
                      disabled={submitting}
                      onClick={() => setScheduledAt(`${selectedDate}T${slot.time}`)}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid min-h-27 place-items-center px-4 text-center">
                  <div>
                    <Clock3 className="mx-auto mb-2 size-5 text-muted-foreground/60" aria-hidden="true" />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {slotsError ?? availabilityMessage(
                        availability,
                        t,
                        locale.locale,
                        selectedDate,
                        defaultDurationMinutes,
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={submitting || loadingDoctors || slotsLoading || !selectedDoctorId}
            onClick={handleSubmit}
            className="gap-2"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("confirmReplacement")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimeSlotButton({
  slot,
  selected,
  label,
  disabledLabel,
  disabled,
  onClick,
}: {
  slot: SlotInfo;
  selected: boolean;
  label: string;
  disabledLabel: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const unavailable = slot.disabled || disabled;
  return (
    <button
      type="button"
      disabled={unavailable}
      aria-pressed={selected}
      aria-label={disabledLabel ? `${label}, ${disabledLabel}` : label}
      title={disabledLabel ?? undefined}
      onClick={onClick}
      className={cn(
        "group/slot relative flex h-9 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-background px-2 text-xs font-semibold tabular-nums text-foreground shadow-xs outline-none transition-[border-color,background-color,color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/8 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 active:translate-y-0 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-muted/70 disabled:text-muted-foreground/45 disabled:shadow-none motion-reduce:transform-none",
        selected && !slot.disabled && "border-primary bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/20 hover:bg-primary",
        selected && slot.disabled && "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      {selected && !slot.disabled ? <Check className="me-1 size-3" aria-hidden="true" /> : null}
      {/* i18n-allow: Tailwind utility class names; not user-facing copy. */}
      <span className={cn(slot.disabled && "line-through decoration-muted-foreground/40")}>{label}</span>
      {slot.disabled ? (
        <span className="absolute inset-x-1 bottom-0.5 truncate text-[7px] font-medium leading-none no-underline opacity-0 transition-opacity group-hover/slot:opacity-100">
          {disabledLabel}
        </span>
      ) : null}
    </button>
  );
}

function slotDisabledLabel(
  slot: SlotInfo,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!slot.disabled) return null;
  if (slot.label === "break" || slot.disabledReason === "break") return t("calendarBreak");
  if (slot.disabledReason === "booked") return t("slotBooked");
  if (slot.disabledReason === "blocked") return t("slotBlocked");
  if (slot.disabledReason === "elapsed") return t("slotElapsed");
  return t("slotUnavailable");
}

function availabilityMessage(
  availability: AvailabilityResult | null,
  t: ReturnType<typeof useTranslations>,
  locale: string,
  selectedDate: string,
  durationMinutes: number,
): string {
  if (!availability) return t("selectADoctorAndDateFirst");
  const doctor = availability.doctorName ?? t("thisDoctor");
  const weekday = selectedDate
    ? new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(`${selectedDate}T12:00:00`))
    : "";
  return {
    available: t("selectTime"),
    doctor_required: t("selectADoctorAndDateFirst"),
    doctor_not_found: t("availabilityDoctorUnavailable"),
    no_schedule_configured: t("availabilityNoSchedule", { doctor }),
    doctor_off_weekday: t("availabilityDoctorDoesNotWorkWeekday", { doctor, weekday }),
    schedule_disabled: t("availabilityScheduleDisabled", { doctor }),
    outside_schedule_range: t("availabilityOutsideSchedule", { doctor }),
    clinic_closed: t("availabilityClinicClosed"),
    on_leave: t("availabilityDoctorOnLeave", { doctor }),
    working_hours_passed: t("availabilityWorkingHoursPassed"),
    all_slots_booked: t("availabilityAllBooked"),
    all_slots_blocked: t("availabilityAllBlocked"),
    duration_unavailable: t("availabilityDurationUnavailable", { duration: durationMinutes }),
    unable_to_calculate: t("availabilityUnableToCalculate"),
  }[availability.reason];
}

/** ISO → the existing local wall-time string contract used by the Replace action. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
