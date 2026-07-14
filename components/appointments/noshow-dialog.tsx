"use client";

import { useEffect, useState } from "react";
import { Loader2, UserX } from "lucide-react";
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
  { value: "Patient did not arrive", key: "noShowReasonDidNotArrive" },
  { value: "Patient arrived too late", key: "noShowReasonArrivedLate" },
  { value: "Patient unreachable on the phone", key: "noShowReasonUnreachable" },
  { value: "Patient went to a different clinic", key: "noShowReasonDifferentClinic" },
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

export function NoShowDialog({
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
            <UserX className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            {t("markAsNoShow")}</DialogTitle>
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
                        ? "border-amber-500/60 bg-amber-500/10 text-foreground"
                        : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                    )}
                  >
                    <span>{t(key)}</span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-3 w-3 rounded-full border",
                        active
                          ? "border-amber-500 bg-amber-500/30 justify-end"
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
              <Label htmlFor="noshow-other-reason" className="text-xs">
                {t("describeWhatHappened")}</Label>
              <Textarea
                id="noshow-other-reason"
                rows={3}
                maxLength={500}
                placeholder={t("eGPatientCalledFromHospital")}
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
            variant="default"
            onClick={submit}
            disabled={!canSubmit || isPending}
            className="gap-2 bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("confirmNoShow")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
