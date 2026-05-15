"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Image from "next/image";
import { Loader2, Maximize2, Save, Upload, X } from "lucide-react";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
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
import { updateClinic, uploadClinicLogo } from "@/actions/settings";
import type { ActionResult } from "@/actions/settings";

interface ClinicFormProps {
  defaultValues: ClinicValues;
  logoUrl: string | null;
  readOnly?: boolean;
}

export function ClinicForm({ defaultValues, logoUrl: initialLogoUrl, readOnly = false }: ClinicFormProps) {
  const [state, formAction, isPending] = useActionState(
    updateClinic as (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>,
    null,
  );

  const { setTimeFormat } = useClinicSettings();

  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);
  const [logoLoadError, setLogoLoadError] = useState(false);
  const [logoDialogOpen, setLogoDialogOpen] = useState(false);
  const [logoUploading, startLogoTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<ClinicValues>({
    resolver: zodResolver(clinicSchema) as never,
    defaultValues,
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Clinic settings saved.");
      const tf = form.getValues("time_format");
      if (tf) setTimeFormat(tf);
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSubmit(values: ClinicValues) {
    const fd = new FormData();
    fd.set("name", values.name);
    if (values.phone) fd.set("phone", values.phone);
    if (values.address) fd.set("address", values.address);
    fd.set("time_format", values.time_format ?? "24h");
    startTransition(() => formAction(fd));
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    startLogoTransition(async () => {
      const fd = new FormData();
      fd.set("logo", file);
      const result = await uploadClinicLogo(fd);
      if (result.error) {
        toast.error(result.error);
      } else if (result.url) {
        setLogoLoadError(false);
        setLogoUrl(result.url);
        toast.success("Logo updated.");
      }
    });
  }

  return (
    <div className="space-y-8">
      {/* Logo upload */}
      <div className="rounded-xl border border-border/50 bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold">Clinic logo</h3>
        <div className="flex items-center gap-5">
          {logoUrl && !logoLoadError ? (
            <>
              <button
                type="button"
                aria-label="Preview clinic logo"
                onClick={() => setLogoDialogOpen(true)}
                className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Image
                  src={logoUrl}
                  alt="Clinic logo"
                  fill
                  onError={() => setLogoLoadError(true)}
                  className="object-contain p-1"
                />
                <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 transition group-hover:bg-black/20">
                  <Maximize2 className="h-4 w-4 text-white opacity-0 drop-shadow transition group-hover:opacity-100" />
                </span>
              </button>

              <Dialog open={logoDialogOpen} onOpenChange={setLogoDialogOpen}>
                <DialogContent className="max-w-[calc(100%-2rem)] p-4 sm:max-w-lg">
                  <DialogTitle>Clinic logo</DialogTitle>
                  <DialogDescription className="sr-only">
                    Full-size preview of the clinic logo
                  </DialogDescription>
                  <Image
                    src={logoUrl}
                    alt="Clinic logo full size"
                    width={800}
                    height={800}
                    className="max-h-[70vh] w-full rounded-lg object-contain"
                  />
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-xs text-muted-foreground">
              No logo
            </div>
          )}
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              PNG, JPEG, or SVG · max 500 KB
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={logoUploading || readOnly}
                onClick={() => fileInputRef.current?.click()}
              >
                {logoUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {logoUploading ? "Uploading…" : "Upload logo"}
              </Button>
              {logoUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-destructive hover:text-destructive"
                  disabled={logoUploading}
                  onClick={() => { setLogoUrl(null); setLogoLoadError(false); }}
                >
                  <X className="h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              className="hidden"
              onChange={handleLogoChange}
            />
          </div>
        </div>
      </div>

      {/* Clinic info form */}
      <div className="rounded-xl border border-border/50 bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold">Clinic information</h3>
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
                    <Input {...field} disabled={isPending || readOnly} />
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
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      disabled={isPending || readOnly}
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
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      disabled={isPending || readOnly}
                      rows={3}
                      className="resize-none text-sm"
                      placeholder="Full address…"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Time format toggle */}
            <FormField
              control={form.control}
              name="time_format"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Time format</FormLabel>
                  <FormControl>
                    <div className="flex gap-2">
                      {(["24h", "12h"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          disabled={isPending || readOnly}
                          onClick={() => field.onChange(fmt)}
                          className={[
                            "rounded-lg border px-4 py-1.5 text-sm font-medium transition",
                            field.value === fmt
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                          ].join(" ")}
                        >
                          {fmt === "24h" ? "24h (14:30)" : "12h (2:30 PM)"}
                        </button>
                      ))}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={isPending || readOnly} className="gap-2">
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save settings
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
