"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("protected");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold">{t("somethingWentWrong")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("thisPageHitAnUnexpectedError")}</p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {t("errorId")}{error.digest}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={reset} variant="default" size="sm">
          {t("tryAgain")}</Button>
        <Button asChild variant="outline" size="sm">
          <a href="/dashboard">{t("goToDashboard")}</a>
        </Button>
      </div>
    </div>
  );
}
