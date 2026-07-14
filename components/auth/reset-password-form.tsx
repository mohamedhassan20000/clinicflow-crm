"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
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
import { setNewPassword } from "@/actions/auth";
import { useTranslations } from "next-intl";

const schema = z
  .object({
    password: z
      .string()
      .min(8, "validation.passwordMinLength")
      .regex(/[A-Z]/, "validation.passwordUppercase")
      .regex(/[0-9]/, "validation.passwordNumber"),
    confirmPassword: z.string().min(1, "validation.passwordConfirmationRequired"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "validation.passwordsDoNotMatch",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

export function ResetPasswordForm() {
  const t = useTranslations("auth");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [state, formAction, isPending] = useActionState(setNewPassword, null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);

  function onSubmit(values: FormValues) {
    const fd = new FormData();
    fd.set("password", values.password);
    fd.set("confirmPassword", values.confirmPassword);
    startTransition(() => formAction(fd));
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("newPassword")}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={isPending}
                    className="h-10 pe-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={isPending}
                    aria-label={showPassword ? t("hidepassword") : t("showpassword")}
                    className="absolute end-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
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
              <FormLabel>{t("confirmNewPassword")}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showConfirm ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={isPending}
                    className="h-10 pe-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    disabled={isPending}
                    aria-label={showConfirm ? t("hidepassword") : t("showpassword")}
                    className="absolute end-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
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
          disabled={isPending}
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("setting")}</>
          ) : (
            <>
              <KeyRound className="h-4 w-4" />
              {t("setNewPassword")}</>
          )}
        </Button>
      </form>
    </Form>
  );
}
