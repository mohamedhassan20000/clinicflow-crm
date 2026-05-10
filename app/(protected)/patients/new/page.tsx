import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientForm } from "@/components/patients/patient-form";
import { createPatient } from "@/actions/patients";

export const metadata: Metadata = { title: "New Patient" };

export default async function NewPatientPage() {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const [
    { data: departments },
    { data: doctors },
    { data: insuranceProviders },
  ] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("profiles")
      .select("id, full_name, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("insurance_providers")
      .select("id, name")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name"),
  ]);

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
        <PatientForm
          action={createPatient}
          departments={departments ?? []}
          doctors={doctors ?? []}
          insuranceProviders={insuranceProviders ?? []}
        />
      </div>
    </div>
  );
}
