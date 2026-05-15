"use client";

import { useState } from "react";
import { User } from "lucide-react";
import { AppointmentForm } from "./appointment-form";
import type {
  PatientWithDoctor,
  Doctor,
  Department,
  InsuranceProvider,
} from "./appointment-form";
import type { ActionResult } from "@/actions/appointments";

interface NewAppointmentLayoutProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  patients: PatientWithDoctor[];
  doctors: Doctor[];
  departments: Department[];
  insuranceProviders: InsuranceProvider[];
  defaultPatientId?: string;
  defaultDoctorId?: string;
  defaultDepartmentId?: string;
  defaultInsuranceId?: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("");
}

function PatientPreviewPanel({
  patient,
  departments,
  doctors,
  insuranceProviders,
}: {
  patient: PatientWithDoctor | null;
  departments: Department[];
  doctors: Doctor[];
  insuranceProviders: InsuranceProvider[];
}) {
  if (!patient) {
    return (
      <div className="rounded-xl border border-border/50 bg-card p-6 flex flex-col items-center justify-center gap-3 text-center min-h-[200px]">
        <div className="rounded-full bg-muted p-4">
          <User className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">
          Select a patient to preview their profile.
        </p>
      </div>
    );
  }

  const department = departments.find((d) => d.id === patient.department_id);
  const assignedDoctor = (() => {
    const rel = patient.assigned_doctor;
    if (!rel) return null;
    return Array.isArray(rel) ? (rel[0] ?? null) : rel;
  })();
  const doctorName =
    assignedDoctor?.full_name ??
    doctors.find((d) => d.id === patient.assigned_doctor_id)?.full_name;
  const insurance = insuranceProviders.find(
    (ip) => ip.id === patient.insurance_provider_id,
  );

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
          {getInitials(patient.full_name)}
        </div>
        <div className="min-w-0">
          <p className="font-semibold truncate">{patient.full_name}</p>
          <p className="text-xs text-muted-foreground">Patient profile</p>
        </div>
      </div>

      <div className="h-px bg-border/50" />

      <dl className="space-y-2.5">
        {patient.file_number && (
          <div>
            <dt className="text-xs text-muted-foreground">File number</dt>
            <dd className="text-sm font-mono">#{patient.file_number}</dd>
          </div>
        )}
        {patient.national_id && (
          <div>
            <dt className="text-xs text-muted-foreground">National ID</dt>
            <dd className="text-sm font-mono">{patient.national_id}</dd>
          </div>
        )}
        {patient.phone && (
          <div>
            <dt className="text-xs text-muted-foreground">Phone</dt>
            <dd className="text-sm">{patient.phone}</dd>
          </div>
        )}
        {department && (
          <div>
            <dt className="text-xs text-muted-foreground">Department</dt>
            <dd className="text-sm">{department.name}</dd>
          </div>
        )}
        {doctorName && (
          <div>
            <dt className="text-xs text-muted-foreground">Treating doctor</dt>
            <dd className="text-sm">{doctorName}</dd>
          </div>
        )}
        {insurance && (
          <div>
            <dt className="text-xs text-muted-foreground">Insurance</dt>
            <dd className="text-sm">{insurance.name}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function NewAppointmentLayout({
  action,
  patients,
  doctors,
  departments,
  insuranceProviders,
  defaultPatientId,
  defaultDoctorId,
  defaultDepartmentId,
  defaultInsuranceId,
}: NewAppointmentLayoutProps) {
  const [selectedPatient, setSelectedPatient] =
    useState<PatientWithDoctor | null>(
      defaultPatientId
        ? (patients.find((p) => p.id === defaultPatientId) ?? null)
        : null,
    );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_320px] xl:items-start">
      <div className="rounded-xl border border-border/50 bg-card p-6">
        <AppointmentForm
          action={action}
          patients={patients}
          doctors={doctors}
          departments={departments}
          insuranceProviders={insuranceProviders}
          defaultPatientId={defaultPatientId}
          defaultDoctorId={defaultDoctorId}
          defaultDepartmentId={defaultDepartmentId}
          defaultInsuranceId={defaultInsuranceId}
          onPatientChange={setSelectedPatient}
        />
      </div>
      <PatientPreviewPanel
        patient={selectedPatient}
        departments={departments}
        doctors={doctors}
        insuranceProviders={insuranceProviders}
      />
    </div>
  );
}
