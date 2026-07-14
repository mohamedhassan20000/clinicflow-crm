import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, ArrowLeft } from "lucide-react";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("metadataForgotPassword") };
}

export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("forgotYourPassword")}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("enterYourEmailAndWeLl")}</p>
        </div>
      </div>

      <ForgotPasswordForm />

      <Link
        href="/login"
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        {t("backToSignIn")}</Link>
    </div>
  );
}
