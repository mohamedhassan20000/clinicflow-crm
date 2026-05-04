"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2, PhoneOff } from "lucide-react";
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
import {
  deleteFollowup,
  recordFollowup,
  restoreFollowup,
  updateFollowup,
} from "@/actions/followups";
import type { DoneRow, PendingRow } from "./followups-view";

type Outcome = "all_fine" | "has_problem" | "no_response";

const OPTIONS: {
  value: Outcome;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  className: string;
}[] = [
  {
    value: "all_fine",
    label: "Everything is fine",
    icon: CheckCircle2,
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "has_problem",
    label: "Reported a problem",
    icon: AlertCircle,
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    value: "no_response",
    label: "No response",
    icon: PhoneOff,
    className: "border-border bg-muted/40 text-muted-foreground",
  },
];

interface Props {
  row: PendingRow | null;
  followup?: DoneRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUndoReopen?: () => void;
  mode?: "create" | "edit";
}

export function RecordFollowupDialog({
  row,
  followup = null,
  open,
  onOpenChange,
  onUndoReopen,
  mode = "create",
}: Props) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState("");
  const action = mode === "edit" ? updateFollowup : recordFollowup;
  const [state, formAction, isPending] = useActionState(action, null);
  // Track which `state` object we've already shown a toast for. Without this,
  // any parent re-render (e.g. the live search updating the URL) recreates
  // `onOpenChange` and re-fires the success effect, spamming the toast.
  const handledStateRef = useRef<typeof state>(null);
  // Stable ref for the parent close callback so the success effect doesn't
  // depend on its identity.
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setOutcome((followup?.outcome as Outcome | undefined) ?? null);
      setNotes(followup?.notes ?? "");
    });
  }, [open, followup]);

  useEffect(() => {
    if (!state) return;
    if (handledStateRef.current === state) return;
    handledStateRef.current = state;
    if (state.error) {
      toast.error(state.error);
    } else {
      const saved = state.followup;
      const draftOutcome = outcome;
      const draftNotes = notes;
      const previous =
        mode === "edit" && followup
          ? {
              id: followup.id,
              appointment_id: followup.appointment_id,
              patient_id: followup.patient_id,
              outcome: followup.outcome,
              notes: followup.notes,
            }
          : null;
      toast.success(mode === "edit" ? "Follow-up updated." : "Follow-up recorded.", {
        duration: 10000,
        action: saved
          ? {
              label: "Undo",
              onClick: async () => {
                const res =
                  mode === "edit" && previous
                    ? await restoreFollowup(previous)
                    : await deleteFollowup(saved.id);
                if (res.error) {
                  toast.error(res.error);
                  return;
                }
                setOutcome(draftOutcome);
                setNotes(draftNotes);
                onUndoReopen?.();
                router.refresh();
              },
            }
          : undefined,
      });
      queueMicrotask(() => onOpenChangeRef.current(false));
      router.refresh();
    }
  }, [state, mode, followup, outcome, notes, router]);

  if (!row && !followup) return null;

  const patientName = row?.patients?.full_name ?? followup?.patients?.full_name;
  const patientPhone = row?.patients?.phone ?? followup?.patients?.phone;
  const departmentName =
    row?.departments?.name ?? followup?.appointment?.departments?.name;
  const patientId = row?.patient_id ?? followup?.patient_id ?? "";
  const appointmentId = row?.id ?? followup?.appointment_id ?? "";

  const requiresNote = outcome === "has_problem";
  const canSubmit =
    !!outcome && !isPending && (!requiresNote || notes.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit follow-up" : "Record follow-up"}
          </DialogTitle>
          <DialogDescription>
            {patientName} ·{" "}
            {patientPhone && (
              <span className="font-mono">{patientPhone}</span>
            )}
            {departmentName && (
              <span className="ml-1">· {departmentName}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4 py-1">
          {followup && (
            <input type="hidden" name="followup_id" value={followup.id} />
          )}
          <input type="hidden" name="appointment_id" value={appointmentId} />
          <input type="hidden" name="patient_id" value={patientId} />
          {outcome && (
            <input type="hidden" name="outcome" value={outcome} />
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Outcome</Label>
            <div className="grid gap-1.5">
              {OPTIONS.map(({ value, label, icon: Icon, className }) => {
                const active = outcome === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={isPending}
                    onClick={() => setOutcome(value)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? `${className} ring-2 ring-primary/30`
                        : "border-border/60 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      {label}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-3 w-3 rounded-full border",
                        active ? "border-primary bg-primary" : "border-border",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="followup-notes" className="text-xs">
              Notes
              {requiresNote && (
                <span className="ml-1 text-destructive">*</span>
              )}
              <span className="ml-2 font-normal text-muted-foreground">
                {requiresNote
                  ? "Describe what the patient reported"
                  : "Optional context"}
              </span>
            </Label>
            <Textarea
              id="followup-notes"
              name="notes"
              rows={3}
              maxLength={1000}
              placeholder={
                requiresNote
                  ? "e.g. swelling at incision site, fever 38°C…"
                  : "e.g. Patient picking up labs Wed."
              }
              value={notes}
              disabled={isPending}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none text-sm"
            />
            <p className="text-right text-[10px] text-muted-foreground">
              {notes.length}/1000
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} className="gap-2">
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "edit" ? "Save changes" : "Save follow-up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
