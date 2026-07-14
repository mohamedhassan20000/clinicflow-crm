import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations("protected");
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">{t("pageNotFound")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("thePageYouReLookingFor")}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">{t("goToDashboard")}</Link>
      </Button>
    </div>
  );
}
