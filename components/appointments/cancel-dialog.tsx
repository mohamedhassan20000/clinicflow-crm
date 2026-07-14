"use client";

import { useEffect, useState } from "react";
import { Loader2, XCircle } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const PRESET_REASONS = [
  { value: "Patient requested cancellation", key: "cancelReasonPatientRequested" },
  { value: "Patient no longer needs the appointment", key: "cancelReasonNoLongerNeeded" },
  { value: "Doctor unavailable", key: "cancelReasonDoctorUnavailable" },
  { value: "Rescheduled to another date", key: "cancelReasonRescheduled" },
  { value: "Duplicate booking", key: "cancelReasonDuplicate" },
  { value: "Clinic closure / emergency", key: "cancelReasonClinicClosure" },
  { value: "Other", key: "other" },
] as const;

type PresetReason = (typeof PRESET_REASONS)[number]["value"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending?: boolean;
  patientName?: string;
}

export function CancelAppointmentDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  patientName,
}: Props) {
  const t = useTranslations("appointments");
  const [selected, setSelected] = useState<PresetReason | null>(null);
  const [other, setOther] = useState("");

  useEffect(() => {
    if (open) return;
    queueMicrotask(() => {
      setSelected(null);
      setOther("");
    });
  }, [open]);

  const finalReason =
    selected === "Other" ? other.trim() : (selected ?? "").trim();
  const canSubmit = finalReason.length > 0 && finalReason.length <= 500;

  function submit() {
    if (!canSubmit) return;
    onConfirm(finalReason);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-destructive" />
            {t("cancelAppointment")}</DialogTitle>
          <DialogDescription>
            {t("pleasePickAReasonSoWe")}{patientName ? ` for ${patientName}` : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">{t("reason")}</Label>
            <div className="mt-2 grid gap-1.5">
              {PRESET_REASONS.map(({ value, key }) => {
                const active = selected === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={isPending}
                    onClick={() => setSelected(value)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border px-3 py-2 text-start text-sm transition-colors",
                      active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                    )}
                  >
                    <span>{t(key)}</span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-3 w-3 rounded-full border",
                        active
                          ? "border-primary bg-primary"
                          : "border-border",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* i18n-allow: canonical stored reason code; the visible label is translated above */}
          {selected === "Other" && (
            <div className="space-y-1.5">
              <Label htmlFor="cancel-other-reason" className="text-xs">
                {t("describeTheReason")}</Label>
              <Textarea
                id="cancel-other-reason"
                rows={3}
                maxLength={500}
                placeholder={t("eGPatientHospitalisedWillReschedule")}
                value={other}
                disabled={isPending}
                onChange={(e) => setOther(e.target.value)}
                autoFocus
                className="resize-none text-sm"
              />
              <p className="text-end text-[10px] text-muted-foreground">
                {other.length}/500
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t("keepAppointment")}</Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={!canSubmit || isPending}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("confirmCancellation")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
