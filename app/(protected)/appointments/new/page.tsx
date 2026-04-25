import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { AppointmentForm } from "@/components/appointments/appointment-form";
import { createAppointment } from "@/actions/appointments";

export const metadata: Metadata = { title: "New Appointment" };

interface PageProps {
  searchParams: Promise<{ patient_id?: string }>;
}

export default async function NewAppointmentPage({ searchParams }: PageProps) {
  const user = await requireRole(["admin", "receptionist"]);
  const { patient_id } = await searchParams;
  const supabase = await createClient();

  const [{ data: patients }, { data: doctors }, { data: departments }, { data: insurance }] =
    await Promise.all([
      supabase
        .from("patients")
        .select("id, full_name, phone, department_id, national_id, file_number")
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .order("full_name"),
      supabase
        .from("profiles")
        .select("id, full_name, department_id")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .eq("role", "doctor")
        .order("full_name"),
      supabase
        .from("departments")
        .select("id, name")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("insurance_providers")
        .select("id, name")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
    ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/appointments"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Appointments
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New appointment</h1>
        <p className="text-sm text-muted-foreground">
          Book a new appointment for a patient.
        </p>
      </div>

      <div className="max-w-2xl rounded-xl border border-border/50 bg-card p-6">
        <AppointmentForm
          action={createAppointment}
          patients={patients ?? []}
          doctors={doctors ?? []}
          departments={departments ?? []}
          insuranceProviders={insurance ?? []}
          defaultPatientId={patient_id}
        />
      </div>
    </div>
  );
}
