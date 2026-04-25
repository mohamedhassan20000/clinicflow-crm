"use client";

import { Printer, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

function withPrintMode(className: string | null, fn: () => void) {
  if (className) document.body.classList.add(className);
  // Defer to next frame so the class is applied before the print dialog opens.
  requestAnimationFrame(() => {
    fn();
    if (className) document.body.classList.remove(className);
  });
}

export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => withPrintMode(null, () => window.print())}
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
      onClick={() =>
        withPrintMode("print-settlements-only", () => window.print())
      }
    >
      <FileText className="h-3.5 w-3.5" />
      Print settlements
    </Button>
  );
}
