import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function OperatorNotFound() {
  const t = useTranslations("operator");
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">{t("operatorPageNotFound")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("theOperatorPageYouReLooking")}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/operator">{t("goToMissionControl")}</Link>
      </Button>
    </div>
  );
}
