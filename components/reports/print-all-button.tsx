"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ReportPrintSection =
  | "all"
  | "cancellation"
  | "no-show"
  | "revenue"
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

export function PrintAllButton() {
  return (
    <Button type="button" onClick={() => printReportSection("all")} className="print:hidden">
      <Printer className="h-4 w-4" aria-hidden />
      Print all
    </Button>
  );
}

export function PrintSectionButton({
  section,
  label = "Print",
}: {
  section: Exclude<ReportPrintSection, "all">;
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
