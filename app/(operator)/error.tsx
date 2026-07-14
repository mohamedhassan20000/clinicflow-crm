"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function OperatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      </div>
      <div className="max-w-md">
        <h2 className="text-lg font-semibold">Operator page could not be loaded</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This page hit an unexpected error while loading. No data was changed.
          Try again, or return to Mission Control. If the problem continues,
          include the error ID below when contacting support.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Error ID: {error.digest}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={reset} size="sm">
          Try again
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/operator">Go to Mission Control</Link>
        </Button>
      </div>
    </div>
  );
}
