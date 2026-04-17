"use client";

import { useActionState, useEffect } from "react";
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
import { insuranceSchema, type InsuranceValues } from "@/lib/validations/settings";
import type { ActionResult } from "@/actions/settings";

interface InsuranceFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  defaultValues?: Partial<InsuranceValues>;
  submitLabel?: string;
  onSuccess?: () => void;
}

export function InsuranceForm({
  action,
  defaultValues,
  submitLabel = "Create provider",
  onSuccess,
}: InsuranceFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);

  const form = useForm<InsuranceValues>({
    resolver: zodResolver(insuranceSchema),
    defaultValues: {
      name: "",
      code: null,
      ...defaultValues,
    },
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Insurance provider saved.");
      onSuccess?.();
    }
  }, [state, onSuccess]);

  function onSubmit(values: InsuranceValues) {
    const fd = new FormData();
    fd.set("name", values.name);
    if (values.code) fd.set("code", values.code);
    formAction(fd);
  }

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
              <FormLabel>Provider name</FormLabel>
              <FormControl>
                <Input {...field} disabled={isPending} placeholder="SGK" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Code (optional)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  disabled={isPending}
                  placeholder="SGK-01"
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
