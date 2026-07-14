import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("metadataSetNewPassword") };
}

export default function ChangePasswordPage() {
  const t = useTranslations("auth");
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("setANewPassword")}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("yourAccountRequiresAPasswordChange")}</p>
        </div>
      </div>

      <ChangePasswordForm />
    </div>
  );
}
