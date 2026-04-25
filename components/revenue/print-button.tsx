"use client";

import { Printer, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

function printWithMode(modeClass: string | null) {
  const cleanup = () => {
    if (modeClass) document.body.classList.remove(modeClass);
    window.removeEventListener("afterprint", cleanup);
  };

  if (modeClass) {
    document.body.classList.add(modeClass);
    window.addEventListener("afterprint", cleanup);
  }

  // Two RAFs ensure the new className is committed to layout before the
  // (synchronous) print dialog opens — Safari/Firefox can otherwise race.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      // Fallback in case afterprint never fires (some browsers).
      if (modeClass) setTimeout(cleanup, 1000);
    });
  });
}

export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => printWithMode(null)}
    >
      <Printer className="h-3.5 w-3.5" />
      Print statement
    </Button>
  );
}

/**
 * Prints ONLY the settlement payments section by hiding everything marked
 * with `data-print-hide-when-settlements` for the duration of the print call.
 */
export function PrintSettlementsButton({ disabled }: { disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      className="gap-1.5"
      onClick={() => printWithMode("print-settlements-only")}
    >
      <FileText className="h-3.5 w-3.5" />
      Print settlements
    </Button>
  );
}
