"use client";

import { startTransition, useActionState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { departmentSchema, type DepartmentValues } from "@/lib/validations/settings";
import type { ActionResult } from "@/actions/settings";
import { useTranslations } from "next-intl";

const PRESET_COLORS = [
  "#0D9488", "#6366F1", "#F59E0B", "#EF4444", "#10B981",
  "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#64748B",
];

interface DepartmentFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  defaultValues?: Partial<DepartmentValues>;
  submitLabel?: string;
  onSuccess?: () => void;
}

export function DepartmentForm({
  action,
  defaultValues,
  submitLabel = "Create department",
  onSuccess,
}: DepartmentFormProps) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);

  const form = useForm<DepartmentValues>({
    resolver: zodResolver(departmentSchema),
    defaultValues: {
      name: "",
      color: "#0D9488",
      description: null,
      ...defaultValues,
    },
  });

  useEffect(() => {
    if (state?.success) {
      toast.success(t("departmentSaved"));
      onSuccess?.();
    }
  }, [state, onSuccess]);

  function onSubmit(values: DepartmentValues) {
    const fd = new FormData();
    fd.set("name", values.name);
    fd.set("color", values.color);
    if (values.description) fd.set("description", values.description);
    startTransition(() => formAction(fd));
  }

  const currentColor = form.watch("color");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("name")}</FormLabel>
              <FormControl>
                <Input {...field} disabled={isPending} placeholder={t("cardiology")} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("color")}</FormLabel>
              <div className="space-y-2">
                {/* Preset palette */}
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1"
                      style={{
                        backgroundColor: c,
                        borderColor: field.value === c ? "white" : "transparent",
                        boxShadow: field.value === c ? `0 0 0 2px ${c}` : "none",
                      }}
                      onClick={() => field.onChange(c)}
                    />
                  ))}
                </div>
                {/* Manual hex input */}
                <FormControl>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-9 w-9 shrink-0 rounded-md border border-border"
                      style={{ backgroundColor: currentColor }}
                    />
                    <Input
                      {...field}
                      disabled={isPending}
                      placeholder="#0D9488"
                      className="font-mono uppercase"
                    />
                  </div>
                </FormControl>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("descriptionOptional")}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  disabled={isPending}
                  placeholder={t("briefDescription")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}
