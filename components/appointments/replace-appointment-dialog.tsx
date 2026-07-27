"use client";

import { useEffect, useState } from "react";
import { Loader2, Repeat } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getReplacementDoctorOptions,
  replaceAppointment,
  type ReplacementDoctorOption,
} from "@/actions/appointments";
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
  const [scheduledAt, setScheduledAt] = useState(() =>
    toLocalInputValue(defaultScheduledAt),
  );
  const [selectedDoctorId, setSelectedDoctorId] = useState(doctorId);
  const [doctorOptions, setDoctorOptions] = useState<
    ReplacementDoctorOption[]
  >([]);
  const [loadingDoctors, setLoadingDoctors] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  function handleOpenChange(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) {
      setSelectedDoctorId(doctorId);
      setScheduledAt(toLocalInputValue(defaultScheduledAt));
      setDoctorOptions([]);
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
      <DialogContent>
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
          <Label htmlFor="replace-scheduled-at">{t("newDateAndTime")}</Label>
          <Input
            id="replace-scheduled-at"
            type="datetime-local"
            value={scheduledAt}
            disabled={submitting}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="replace-doctor">{t("replacementDoctor")}</Label>
          <Select
            value={selectedDoctorId}
            onValueChange={setSelectedDoctorId}
            disabled={submitting || loadingDoctors}
          >
            <SelectTrigger id="replace-doctor">
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
            disabled={submitting || loadingDoctors || !selectedDoctorId}
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

/** ISO → value accepted by <input type="datetime-local"> in local time. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
