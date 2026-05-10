import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientForm } from "@/components/patients/patient-form";
import { updatePatient } from "@/actions/patients";

export const metadata: Metadata = { title: "Edit Patient" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPatientPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const [
    { data: patient },
    { data: departments },
    { data: doctors },
    { data: insuranceProviders },
  ] = await Promise.all([
    supabase
      .from("patients")
      .select("*")
      .eq("id", id)
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false)
      .single(),
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

  if (!patient) notFound();

  const action = updatePatient.bind(null, id);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/patients/${id}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {patient.full_name}
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit patient</h1>
        <p className="text-sm text-muted-foreground">
          Update {patient.full_name}&apos;s record.
        </p>
      </div>

      <div className="max-w-2xl rounded-xl border border-border/50 bg-card p-6">
        <PatientForm
          action={action}
          departments={departments ?? []}
          doctors={doctors ?? []}
          insuranceProviders={insuranceProviders ?? []}
          patient={patient}
          defaultValues={{
            full_name: patient.full_name,
            national_id: patient.national_id,
            date_of_birth: patient.date_of_birth,
            phone: patient.phone,
            email: patient.email,
            blood_type: patient.blood_type,
            department_id: patient.department_id,
            assigned_doctor_id: patient.assigned_doctor_id,
            insurance_provider_id: patient.insurance_provider_id,
          }}
        />
      </div>
    </div>
  );
}
