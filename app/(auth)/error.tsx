"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("auth");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">{t("somethingWentWrong")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("anUnexpectedErrorOccurredPleaseTry")}</p>
        {error.digest && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("errorId")}{error.digest}
          </p>
        )}
      </div>
      <Button onClick={reset} variant="outline" size="sm">
        {t("tryAgain")}</Button>
    </div>
  );
}
