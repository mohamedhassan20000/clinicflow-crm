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

const PRESET_REASONS = [
  "Patient requested cancellation",
  "Patient no longer needs the appointment",
  "Doctor unavailable",
  "Rescheduled to another date",
  "Duplicate booking",
  "Clinic closure / emergency",
  "Other",
] as const;

type PresetReason = (typeof PRESET_REASONS)[number];

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
  const [selected, setSelected] = useState<PresetReason | null>(null);
  const [other, setOther] = useState("");

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setOther("");
    }
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
            Cancel appointment
          </DialogTitle>
          <DialogDescription>
            Please pick a reason so we can keep an accurate record
            {patientName ? ` for ${patientName}` : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">Reason</Label>
            <div className="mt-2 grid gap-1.5">
              {PRESET_REASONS.map((reason) => {
                const active = selected === reason;
                return (
                  <button
                    key={reason}
                    type="button"
                    disabled={isPending}
                    onClick={() => setSelected(reason)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/60 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    <span>{reason}</span>
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

          {selected === "Other" && (
            <div className="space-y-1.5">
              <Label htmlFor="cancel-other-reason" className="text-xs">
                Describe the reason
              </Label>
              <Textarea
                id="cancel-other-reason"
                rows={3}
                maxLength={500}
                placeholder="e.g. Patient hospitalised — will reschedule next week"
                value={other}
                disabled={isPending}
                onChange={(e) => setOther(e.target.value)}
                autoFocus
                className="resize-none text-sm"
              />
              <p className="text-right text-[10px] text-muted-foreground">
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
            Keep appointment
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={!canSubmit || isPending}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
