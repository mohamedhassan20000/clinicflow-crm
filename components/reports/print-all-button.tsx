"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReportPrintSection =
  | "cancellation"
  | "no-show"
  | "revenue"
  | "my-performance"
  | "my-assistant-performance"
  | "followups"
  | "doctor-performance"
  | "receptionist-performance";

export function printReportSection(section: ReportPrintSection) {
  const cleanup = () => {
    document.body.removeAttribute("data-printing");
    window.removeEventListener("afterprint", cleanup);
  };

  document.body.setAttribute("data-printing", section);
  window.addEventListener("afterprint", cleanup);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      window.setTimeout(cleanup, 1500);
    });
  });
}

export function PrintSectionButton({
  section,
  label = "Print",
}: {
  section: ReportPrintSection;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => printReportSection(section)}
      className="print:hidden"
    >
      <Printer className="h-3.5 w-3.5" aria-hidden />
      {label}
    </Button>
  );
}
