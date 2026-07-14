"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";

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
import { signIn } from "@/actions/auth";
import { useTranslations } from "next-intl";

const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const isSubmitting = isSigningIn || form.formState.isSubmitting;

  async function onSubmit(values: LoginValues) {
    setIsSigningIn(true);
    try {
      const fd = new FormData();
      fd.set("email", values.email);
      fd.set("password", values.password);

      const result = await signIn(fd);

      if (result.error) {
        toast.error(result.error);
        setIsSigningIn(false);
        return;
      }

      if (result.fieldErrors) {
        Object.entries(result.fieldErrors).forEach(([name, messages]) => {
          if (messages?.[0]) {
            form.setError(name as keyof LoginValues, {
              type: "server",
              message: messages[0],
            });
          }
        });
        setIsSigningIn(false);
        return;
      }

      if (result.ok && result.redirectTo) {
        // Force fresh RSC payload so middleware sees the new session cookie
        // and the protected layout renders immediately — no manual reload.
        router.replace(result.redirectTo);
        router.refresh();
        return;
      }

      setIsSigningIn(false);
    } catch (err) {
      console.error("Sign-in failed:", err);
      toast.error(t("somethingWentWrongPleaseTryAgain"));
      setIsSigningIn(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {/* Email */}
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("emailAddress")}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="email"
                  autoComplete="email"
                  placeholder={t("nameClinicCom")}
                  disabled={isSubmitting}
                  className="h-11 rounded-lg transition-all duration-200 focus-visible:ring-4 focus-visible:ring-primary/15 focus-visible:border-primary/60"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Password */}
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>{t("password")}</FormLabel>
                <a
                  href="/forgot-password"
                  className="text-xs font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:underline"
                  tabIndex={0}
                >
                  {t("forgotPassword")}</a>
              </div>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    disabled={isSubmitting}
                    className="h-11 rounded-lg pe-10 transition-all duration-200 focus-visible:ring-4 focus-visible:ring-primary/15 focus-visible:border-primary/60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={isSubmitting}
                    aria-label={showPassword ? t("hidePassword") : t("showPassword")}
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

        {/* Submit */}
        <Button
          type="submit"
          className="mt-2 h-11 w-full gap-2 rounded-lg bg-gradient-to-r from-primary to-[oklch(0.62_0.14_195)] text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-primary/40 active:scale-[0.98] active:translate-y-0"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("signingIn")}</>
          ) : (
            <>
              <LogIn className="h-4 w-4 rtl:rotate-180" />
              {t("signIn")}</>
          )}
        </Button>

        {/* Divider / hint */}
        <p className="pt-1 text-center text-xs text-muted-foreground">
          {t("accessIsRestrictedToAuthorisedClinic")}</p>
      </form>
    </Form>
  );
}
