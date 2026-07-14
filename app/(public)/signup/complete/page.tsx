import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function SignupCompletePage() {
  const t = useTranslations("public");
  return (
    <section className="rounded-2xl border bg-card p-8 text-center">
      <h1 className="text-2xl font-semibold">{t("checkYourEmail")}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {t("confirmYourEmailAddressThenSign")}</p>
      <Button asChild className="mt-6">
        <Link href="/login">{t("goToSignIn")}</Link>
      </Button>
    </section>
  );
}
