"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PackageTemplateActionResult } from "@/actions/package-templates";
import { useTranslations } from "next-intl";

export interface PackageTemplateFormDefaults {
  id?: string;
  department_id?: string;
  name?: string;
  total_sessions?: number;
  price_per_session?: number | null;
  total_price?: number | null;
  notes?: string | null;
}

interface Props {
  action: (
    prev: PackageTemplateActionResult | null,
    fd: FormData,
  ) => Promise<PackageTemplateActionResult>;
  departments: { id: string; name: string; color: string }[];
  defaults?: PackageTemplateFormDefaults;
  submitLabel: string;
  onSuccess?: () => void;
}

export function PackageTemplateForm({
  action,
  departments,
  defaults,
  submitLabel,
  onSuccess,
}: Props) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);

  useEffect(() => {
    if (!state) return;
    if (state.error) toast.error(state.error);
    else if (state.fieldErrors) {
      const first = Object.values(state.fieldErrors).flat()[0];
      if (first) toast.error(first);
    } else if (state.success) {
      toast.success(t("saved"));
      onSuccess?.();
    }
  }, [state, onSuccess]);

  return (
    <form action={formAction} className="space-y-4">
      {defaults?.id ? (
        <input type="hidden" name="template_id" value={defaults.id} />
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-department" className="text-xs">
          {t("department")}</Label>
        <Select
          name="department_id"
          defaultValue={defaults?.department_id}
          disabled={isPending}
          required
        >
          <SelectTrigger id="pkg-tpl-department">
            <SelectValue placeholder={t("selectDepartment")} />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-name" className="text-xs">
          {t("templateName")}</Label>
        <Input
          id="pkg-tpl-name"
          name="name"
          placeholder={t("eG10SessionPhysioPackage")}
          defaultValue={defaults?.name}
          required
          minLength={1}
          maxLength={120}
          disabled={isPending}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="pkg-tpl-sessions" className="text-xs">
            {t("totalSessions")}</Label>
          <Input
            id="pkg-tpl-sessions"
            name="total_sessions"
            type="number"
            min={1}
            max={10000}
            step={1}
            defaultValue={defaults?.total_sessions}
            required
            disabled={isPending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pkg-tpl-price-each" className="text-xs">
            {t("priceSession")}</Label>
          <Input
            id="pkg-tpl-price-each"
            name="price_per_session"
            type="number"
            min={0}
            step="0.01"
            placeholder="optional"
            defaultValue={defaults?.price_per_session ?? ""}
            disabled={isPending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pkg-tpl-price-total" className="text-xs">
            {t("totalPrice")}</Label>
          <Input
            id="pkg-tpl-price-total"
            name="total_price"
            type="number"
            min={0}
            step="0.01"
            placeholder="optional"
            defaultValue={defaults?.total_price ?? ""}
            disabled={isPending}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-notes" className="text-xs">
          {t("notes")}</Label>
        <Textarea
          id="pkg-tpl-notes"
          name="notes"
          maxLength={500}
          rows={3}
          placeholder={t("optionalInternalNotes")}
          defaultValue={defaults?.notes ?? ""}
          disabled={isPending}
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending} className="gap-2">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? t("saving") : submitLabel}
        </Button>
      </div>
    </form>
  );
}
