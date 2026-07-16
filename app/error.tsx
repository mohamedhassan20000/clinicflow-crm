"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tAuth = useTranslations("auth");
  const tPublic = useTranslations("public");
  const tNotFound = useTranslations("notFound");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      </div>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold">{tAuth("somethingWentWrong")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {tPublic("thisPageHitAnUnexpectedError")}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {tAuth("errorId")} {error.digest}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={reset} size="sm">
          {tAuth("tryAgain")}
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/">{tNotFound("home")}</Link>
        </Button>
      </div>
    </div>
  );
}
