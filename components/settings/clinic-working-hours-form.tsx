"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { upsertClinicWorkingHours } from "@/actions/settings";
import type { ActionResult } from "@/actions/settings";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Display order: Mon–Sun (1–6, then 0)
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface Props {
  defaultValues: ClinicWorkingHoursValues;
  readOnly?: boolean;
}

export function ClinicWorkingHoursForm({ defaultValues, readOnly = false }: Props) {
  const [state, formAction, isPending] = useActionState(
    upsertClinicWorkingHours as (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>,
    null,
  );

  const [schedule, setSchedule] = useState<ClinicWorkingHoursValues>(defaultValues);

  useEffect(() => {
    if (state?.success) toast.success("Working hours saved.");
  }, [state]);

  function toggleDay(dow: number, open: boolean) {
    setSchedule((prev) =>
      prev.map((d) =>
        d.day_of_week === dow
          ? { ...d, open, shifts: open && d.shifts.length === 0 ? [{ shift_start: "09:00", shift_end: "17:00" }] : d.shifts }
          : d,
      ),
    );
  }

  function updateShift(dow: number, idx: number, field: "shift_start" | "shift_end", value: string) {
    setSchedule((prev) =>
      prev.map((d) => {
        if (d.day_of_week !== dow) return d;
        const shifts = d.shifts.map((s, i) => (i === idx ? { ...s, [field]: value } : s));
        return { ...d, shifts };
      }),
    );
  }

  function addShift(dow: number) {
    setSchedule((prev) =>
      prev.map((d) => {
        if (d.day_of_week !== dow || d.shifts.length >= 2) return d;
        const last = d.shifts[d.shifts.length - 1];
        return {
          ...d,
          shifts: [...d.shifts, { shift_start: last?.shift_end ?? "14:00", shift_end: "18:00" }],
        };
      }),
    );
  }

  function removeShift(dow: number, idx: number) {
    setSchedule((prev) =>
      prev.map((d) => {
        if (d.day_of_week !== dow) return d;
        const shifts = d.shifts.filter((_, i) => i !== idx);
        return { ...d, shifts, open: shifts.length > 0 };
      }),
    );
  }

  function onSave() {
    const fd = new FormData();
    fd.set("working_hours", JSON.stringify(schedule));
    startTransition(() => formAction(fd));
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <h3 className="mb-1 text-sm font-semibold">Working hours</h3>
      <p className="mb-5 text-xs text-muted-foreground">
        Set which days the clinic is open and configure up to 2 shifts per day.
      </p>

      {state?.error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      <div className="space-y-3">
        {DAY_ORDER.map((dow) => {
          const day = schedule.find((d) => d.day_of_week === dow);
          if (!day) return null;

          return (
            <div key={dow} className="rounded-lg border border-border/40 bg-muted/20 p-3">
              {/* Day header row */}
              <div className="flex items-center gap-3">
                <Checkbox
                  id={`day-${dow}`}
                  checked={day.open}
                  onCheckedChange={(v) => !readOnly && toggleDay(dow, !!v)}
                  disabled={readOnly || isPending}
                />
                <Label
                  htmlFor={`day-${dow}`}
                  className="w-24 cursor-pointer text-sm font-medium select-none"
                >
                  {DAY_NAMES[dow]}
                </Label>

                {!day.open && (
                  <span className="text-xs text-muted-foreground">Closed</span>
                )}
              </div>

              {/* Shifts */}
              {day.open && (
                <div className="mt-3 space-y-2 pl-7">
                  {day.shifts.map((shift, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-5 text-center text-xs text-muted-foreground">
                        {idx + 1}.
                      </span>
                      <input
                        type="time"
                        value={shift.shift_start}
                        disabled={readOnly || isPending}
                        onChange={(e) => updateShift(dow, idx, "shift_start", e.target.value)}
                        className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      />
                      <span className="text-xs text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={shift.shift_end}
                        disabled={readOnly || isPending}
                        onChange={(e) => updateShift(dow, idx, "shift_end", e.target.value)}
                        className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      />
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => removeShift(dow, idx)}
                          disabled={isPending}
                          className="text-muted-foreground/40 hover:text-destructive transition-colors disabled:opacity-50"
                          aria-label="Remove shift"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}

                  {!readOnly && day.shifts.length < 2 && (
                    <button
                      type="button"
                      onClick={() => addShift(dow)}
                      disabled={isPending}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" />
                      Add shift
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div className="mt-5 flex justify-end">
          <Button onClick={onSave} disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save working hours
          </Button>
        </div>
      )}
    </div>
  );
}
