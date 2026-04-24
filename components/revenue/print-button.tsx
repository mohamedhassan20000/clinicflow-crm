"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => window.print()}
    >
      <Printer className="h-3.5 w-3.5" />
      Print statement
    </Button>
  );
}
