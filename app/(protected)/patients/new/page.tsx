import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { PatientForm } from "@/components/patients/patient-form";
import { createPatient } from "@/actions/patients";

export const metadata: Metadata = { title: "New Patient" };

export default async function NewPatientPage() {
  await requireRole(["admin", "receptionist"]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/patients"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Patients
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New patient</h1>
        <p className="text-sm text-muted-foreground">
          Add a new patient record to the clinic.
        </p>
      </div>

      <div className="max-w-2xl rounded-xl border border-border/50 bg-card p-6">
        <PatientForm action={createPatient} />
      </div>
    </div>
  );
}
