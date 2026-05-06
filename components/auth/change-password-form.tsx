"use client";

import { useActionState, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";

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
import { changePassword } from "@/actions/auth";

const schema = z
  .object({
    password: z
      .string()
      .min(8, "At least 8 characters")
      .regex(/[A-Z]/, "Must include an uppercase letter")
      .regex(/[0-9]/, "Must include a number"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

export function ChangePasswordForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [actionState, formAction, isPending] = useActionState(
    changePassword,
    null,
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const isSubmitting = isPending || form.formState.isSubmitting;

  useEffect(() => {
    if (actionState?.error) {
      toast.error(actionState.error);
    }
  }, [actionState]);

  function onSubmit(values: FormValues) {
    const fd = new FormData();
    fd.set("password", values.password);
    fd.set("confirmPassword", values.confirmPassword);
    formAction(fd);
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        {actionState?.debug && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
            <div className="mb-1 font-medium">Temporary password-change debug</div>
            <dl className="space-y-1">
              <div className="flex justify-between gap-3">
                <dt>Action version</dt>
                <dd className="break-all text-right">
                  {actionState.debug.actionVersion}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Trace ID</dt>
                <dd className="break-all text-right">
                  {actionState.debug.traceId}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>RPC succeeded</dt>
                <dd>{String(actionState.debug.rpcSucceeded)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Flag became false</dt>
                <dd>{String(actionState.debug.profileFlagCleared)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>User profile flag</dt>
                <dd>
                  {String(actionState.debug.profileMustChangePassword)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Admin profile flag</dt>
                <dd>
                  {String(actionState.debug.adminProfileMustChangePassword)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Final step</dt>
                <dd className="text-right">{actionState.debug.finalStep}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Redirect target</dt>
                <dd>{actionState.debug.finalRedirectTarget ?? "none"}</dd>
              </div>
              {actionState.debug.rpcError && (
                <div className="pt-1">
                  <dt>RPC error</dt>
                  <dd className="break-words">{actionState.debug.rpcError}</dd>
                </div>
              )}
            </dl>
            {actionState.ok && actionState.redirectTo && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-8"
                onClick={() => {
                  window.location.href = actionState.redirectTo!;
                }}
              >
                Continue to login
              </Button>
            )}
          </div>
        )}

        {actionState?.error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionState.error}
          </div>
        )}

        {actionState?.fieldErrors && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {Object.values(actionState.fieldErrors).flat().join(" ")}
          </div>
        )}

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={isSubmitting}
                    className="h-10 pr-10 transition-shadow focus-visible:shadow-[0_0_0_3px_oklch(0.6_0.14_208_/_0.15)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={isSubmitting}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showConfirm ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={isSubmitting}
                    className="h-10 pr-10 transition-shadow focus-visible:shadow-[0_0_0_3px_oklch(0.6_0.14_208_/_0.15)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    disabled={isSubmitting}
                    aria-label={showConfirm ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  >
                    {showConfirm ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          className="mt-2 h-10 w-full gap-2 transition-all duration-200 active:scale-[0.98]"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Updating…
            </>
          ) : (
            <>
              <KeyRound className="h-4 w-4" />
              Set new password
            </>
          )}
        </Button>
      </form>
    </Form>
  );
}
