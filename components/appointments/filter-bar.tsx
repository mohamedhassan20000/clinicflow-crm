"use client";

import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";

interface Props {
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  hideDoctorFilter?: boolean;
  hideDeptFilter?: boolean;
}

export function AppointmentsFilterBar({
  doctors,
  departments,
  hideDoctorFilter = false,
  hideDeptFilter = false,
}: Props) {
  return (
    <PatientScopeFilterBar
      basePath="/appointments"
      doctors={doctors}
      departments={departments}
      hideDoctorFilter={hideDoctorFilter}
      hideDeptFilter={hideDeptFilter}
    />
  );
}
