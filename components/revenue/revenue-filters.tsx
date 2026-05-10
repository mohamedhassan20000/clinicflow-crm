"use client";

import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";

interface Props {
  departments: { id: string; name: string; color: string }[];
  doctors: { id: string; full_name: string }[];
  actions?: React.ReactNode;
}

export function RevenueFilters({ departments, doctors, actions }: Props) {
  return (
    <PatientScopeFilterBar
      basePath="/revenue"
      doctors={doctors}
      departments={departments}
      fallbackParams={{ name: ["q"] }}
      resetParamsOnApply={["page"]}
      clearExtraParams={["q"]}
      actions={actions}
    />
  );
}
