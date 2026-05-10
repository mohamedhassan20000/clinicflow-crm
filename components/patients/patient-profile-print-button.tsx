"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

function printPatientProfile() {
  const className = "patient-profile-print";
  const cleanup = () => {
    document.body.classList.remove(className);
    window.removeEventListener("afterprint", cleanup);
  };

  document.body.classList.add(className);
  window.addEventListener("afterprint", cleanup);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      setTimeout(cleanup, 1000);
    });
  });
}

export function PatientProfilePrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={printPatientProfile}
    >
      <Printer className="h-3.5 w-3.5" />
      Print
    </Button>
  );
}
