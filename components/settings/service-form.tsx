"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/actions/settings";
import { useTranslations } from "next-intl";

interface Department {
  id: string;
  name: string;
  color: string;
}

interface ServiceFormProps {
  action: (
    prev: ActionResult | null,
    fd: FormData,
  ) => Promise<ActionResult>;
  departments: Department[];
  defaults?: {
    department_id?: string;
    name?: string;
    price?: number;
    name_ar?: string | null;
    name_en?: string | null;
  };
  submitLabel: string;
  onSuccess?: () => void;
}

export function ServiceForm({
  action,
  departments,
  defaults,
  submitLabel,
  onSuccess,
}: ServiceFormProps) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);

  useEffect(() => {
    if (!state) return;
    if (state.error) toast.error(state.error);
    else if (state.success) {
      toast.success(t("saved"));
      onSuccess?.();
    }
  }, [state, onSuccess]);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="svc-department" className="text-xs">
          {t("department")}
        </Label>
        <Select
          name="department_id"
          defaultValue={defaults?.department_id}
          disabled={isPending}
        >
          <SelectTrigger id="svc-department">
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
        <Label htmlFor="svc-name" className="text-xs">
          {t("serviceName")}
        </Label>
        <Input
          id="svc-name"
          name="name"
          placeholder={t("eGConsultation")}
          defaultValue={defaults?.name}
          disabled={isPending}
          required
          minLength={2}
          maxLength={100}
        />
      </div>

      {/* The names patients see, in each language. `name` above stays the
          clinic's canonical record; blank here means "use the stored name",
          and nothing is ever generated to fill it. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="svc-name-ar" className="text-xs">
            {t("displayNameArabic")}
          </Label>
          <Input
            id="svc-name-ar"
            name="name_ar"
            dir="rtl"
            defaultValue={defaults?.name_ar ?? ""}
            disabled={isPending}
            maxLength={160}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-name-en" className="text-xs">
            {t("displayNameEnglish")}
          </Label>
          <Input
            id="svc-name-en"
            name="name_en"
            dir="ltr"
            defaultValue={defaults?.name_en ?? ""}
            disabled={isPending}
            maxLength={160}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("displayNameHint")}</p>

      <div className="space-y-1.5">
        <Label htmlFor="svc-price" className="text-xs">
          {t("price")}
        </Label>
        <Input
          id="svc-price"
          name="price"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.00"
          defaultValue={defaults?.price ?? ""}
          disabled={isPending}
          required
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
