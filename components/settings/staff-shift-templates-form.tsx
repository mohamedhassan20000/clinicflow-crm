"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimePicker } from "@/components/ui/clinic-date-picker";
import { upsertStaffShiftTemplates } from "@/actions/settings";
import type { ActionResult } from "@/actions/settings";
import { MAX_ENABLED_SHIFT_TEMPLATES } from "@/lib/scheduling/clock";
import type { StaffShiftTemplatesValues } from "@/lib/validations/settings";

interface Props {
  defaultValues: StaffShiftTemplatesValues;
  readOnly?: boolean;
}

/**
 * Reusable staff shift definitions. Deliberately separate from the clinic's
 * opening intervals: two templates MAY overlap (Morning 09:00–17:00 with
 * Evening 15:00–22:00), so this card never runs the clinic overlap check.
 */
export function StaffShiftTemplatesForm({ defaultValues, readOnly = false }: Props) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(
    upsertStaffShiftTemplates as (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>,
    null,
  );

  const [templates, setTemplates] = useState<StaffShiftTemplatesValues>(defaultValues);

  useEffect(() => {
    if (state?.success) toast.success(t("staffShiftTemplatesSaved"));
  }, [state]);

  const enabledCount = templates.filter((template) => template.is_enabled).length;
  const overEnabledLimit = enabledCount > MAX_ENABLED_SHIFT_TEMPLATES;

  function update(index: number, patch: Partial<StaffShiftTemplatesValues[number]>) {
    setTemplates((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addTemplate() {
    setTemplates((prev) => [
      ...prev,
      {
        id: null,
        name: "",
        start_time: "09:00",
        end_time: "17:00",
        is_enabled: prev.filter((item) => item.is_enabled).length < MAX_ENABLED_SHIFT_TEMPLATES,
        sort_order: prev.length,
      },
    ]);
  }

  function removeTemplate(index: number) {
    setTemplates((prev) =>
      prev.filter((_, i) => i !== index).map((item, i) => ({ ...item, sort_order: i })),
    );
  }

  function move(index: number, delta: number) {
    setTemplates((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index]!, next[target]!] = [next[target]!, next[index]!];
      return next.map((item, i) => ({ ...item, sort_order: i }));
    });
  }

  function onSave() {
    const fd = new FormData();
    fd.set(
      "templates",
      JSON.stringify(templates.map((item, index) => ({ ...item, sort_order: index }))),
    );
    startTransition(() => formAction(fd));
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <h3 className="mb-1 text-sm font-semibold">{t("staffShiftTemplates")}</h3>
      <p className="mb-5 text-xs text-muted-foreground">
        {t("staffShiftTemplatesDescription")}
      </p>

      {state?.error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      {overEnabledLimit && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t("staffShiftTemplatesLimit", { count: MAX_ENABLED_SHIFT_TEMPLATES })}
        </div>
      )}

      <div className="space-y-3">
        {templates.length === 0 && (
          <p className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("noStaffShiftTemplates")}
          </p>
        )}

        {templates.map((template, index) => (
          <div
            key={template.id ?? `new-${index}`}
            className="rounded-lg border border-border/40 bg-muted/20 p-3"
          >
            <div className="flex items-center gap-2">
              <Checkbox
                id={`shift-template-${index}`} // i18n-allow: technical checkbox DOM id
                checked={template.is_enabled}
                onCheckedChange={(v) => !readOnly && update(index, { is_enabled: !!v })}
                disabled={readOnly || isPending}
              />
              {/* i18n-allow: htmlFor must match the technical checkbox DOM id */}
              <Label htmlFor={`shift-template-${index}`} className="sr-only">
                {t("shiftTemplateEnabled")}
              </Label>
              <Input
                value={template.name}
                disabled={readOnly || isPending}
                onChange={(event) => update(index, { name: event.target.value })}
                placeholder={t("shiftTemplateNamePlaceholder")}
                aria-label={t("shiftTemplateName")}
                className="h-8 flex-1 text-sm"
              />
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={isPending || index === 0}
                    aria-label={t("moveUp")}
                    className="text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={isPending || index === templates.length - 1}
                    aria-label={t("moveDown")}
                    className="text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTemplate(index)}
                    disabled={isPending}
                    aria-label={t("removeShiftTemplate")}
                    className="text-muted-foreground/40 transition-colors hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2 ps-7">
              <TimePicker
                value={template.start_time}
                disabled={readOnly || isPending}
                onChange={(time) => update(index, { start_time: time })}
                label={t("startTime")}
                compact
                className="h-8 w-32 rounded-md px-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">{t("to")}</span>
              <TimePicker
                value={template.end_time}
                disabled={readOnly || isPending}
                onChange={(time) => update(index, { end_time: time })}
                label={t("endTime")}
                compact
                className="h-8 w-32 rounded-md px-2 text-sm"
              />
            </div>
          </div>
        ))}

        {!readOnly && (
          <button
            type="button"
            onClick={addTemplate}
            disabled={isPending || templates.length >= 10}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {t("addShiftTemplate")}
          </button>
        )}
      </div>

      {!readOnly && (
        <div className="mt-5 flex justify-end">
          <Button onClick={onSave} disabled={isPending || overEnabledLimit} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("saveShiftTemplates")}
          </Button>
        </div>
      )}
    </div>
  );
}
