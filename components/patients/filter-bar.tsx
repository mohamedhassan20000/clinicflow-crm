"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";
import { useTranslations } from "next-intl";

interface Props {
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  showScopeFilters?: boolean;
}

export function PatientsFilterBar({
  doctors,
  departments,
  showScopeFilters = true,
}: Props) {
  return (
    <PatientScopeFilterBar
      basePath="/patients"
      doctors={doctors}
      departments={departments}
      hideDoctorFilter={!showScopeFilters}
      hideDeptFilter={!showScopeFilters}
      fallbackParams={{ name: ["q"] }}
      resetParamsOnApply={["page"]}
      clearExtraParams={["q"]}
      actions={<PrintRosterButton />}
    />
  );
}

function PrintRosterButton() {
  const t = useTranslations("patients");
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => window.print()}
    >
      <Printer className="h-3.5 w-3.5" />
      {t("printRoster")}</Button>
  );
}
