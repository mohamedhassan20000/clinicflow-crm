"use client";

import { useActionState, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { clinicSchema, type ClinicValues } from "@/lib/validations/settings";
import { createClinic, type ActionResult } from "@/actions/settings";

export function AddClinicDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    createClinic as (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>,
    null,
  );

  const form = useForm<ClinicValues>({
    resolver: zodResolver(clinicSchema),
    defaultValues: { name: "", phone: "", address: "" },
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Clinic created.");
      form.reset();
      setOpen(false);
    }
  }, [state, form]);

  function onSubmit(values: ClinicValues) {
    const fd = new FormData();
    fd.set("name", values.name);
    if (values.phone) fd.set("phone", values.phone);
    if (values.address) fd.set("address", values.address);
    formAction(fd);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <Plus className="h-4 w-4" />
          Add clinic
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            Add new clinic
          </DialogTitle>
          <DialogDescription>
            Create an additional clinic workspace. Staff, patients, and
            appointments are isolated per clinic.
          </DialogDescription>
        </DialogHeader>

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
                  <FormLabel>Clinic name</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={isPending} placeholder="e.g. ClinicFlow Kadıköy" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone (optional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      disabled={isPending}
                      placeholder="0212 000 00 00"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      disabled={isPending}
                      rows={3}
                      className="resize-none text-sm"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} className="gap-2">
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create clinic
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
