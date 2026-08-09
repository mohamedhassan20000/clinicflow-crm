"use client";

import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";

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
  // P7 Phase 4 — the Print Roster button was removed; roster printing now happens
  // only through the patient-list document Preview (the document-trigger entry
  // point on the patients page header).
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
    />
  );
}
