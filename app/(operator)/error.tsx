"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function OperatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("operator");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      </div>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold">{t("operatorPageCouldNotBeLoaded")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("thisPageHitAnUnexpectedError")}</p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {t("errorId")}{error.digest}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={reset} size="sm">
          {t("tryAgain")}</Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/operator">{t("goToMissionControl")}</Link>
        </Button>
      </div>
    </div>
  );
}
