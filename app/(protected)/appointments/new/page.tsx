import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments, getCachedInsuranceProviders, getCachedStaff } from "@/lib/cache/reference-data";
import { NewAppointmentLayout } from "@/components/appointments/new-appointment-layout";
import { createAppointment } from "@/actions/appointments";
import { getClinicWorkingHours } from "@/actions/settings";

export const metadata: Metadata = { title: "New Appointment" };

interface PageProps {
  searchParams: Promise<{
    patient_id?: string;
    doctor_id?: string;
    dept_id?: string;
    insurance_id?: string;
  }>;
}

export default async function NewAppointmentPage({ searchParams }: PageProps) {
  const user = await requireRole(["admin", "receptionist"]);
  const { patient_id, doctor_id, dept_id, insurance_id } = await searchParams;
  const supabase = await createClient();

  const [{ data: patients }, cachedStaff, cachedDepartments, cachedInsurance, clinicWorkingHours] =
    await Promise.all([
      supabase
        .from("patients")
        .select(
          "id, full_name, phone, department_id, assigned_doctor_id, insurance_provider_id, national_id, file_number, assigned_doctor:profiles!assigned_doctor_id(id, full_name, department_id)",
        )
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .order("full_name"),
      getCachedStaff(user.clinicId),
      getCachedDepartments(user.clinicId),
      getCachedInsuranceProviders(user.clinicId),
      getClinicWorkingHours(),
    ]);

  const doctors = cachedStaff
    .filter((s) => s.role === "doctor" && s.is_active && !s.deleted_at)
    .map((s) => ({ id: s.id, full_name: s.full_name, department_id: s.department_id }));
  const departments = cachedDepartments
    .filter((d) => !d.deleted_at && d.is_active)
    .map((d) => ({ id: d.id, name: d.name }));
  const insurance = cachedInsurance
    .filter((p) => !p.deleted_at && p.is_active)
    .map((p) => ({ id: p.id, name: p.name }));

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

      <NewAppointmentLayout
        action={createAppointment}
        patients={patients ?? []}
        doctors={doctors ?? []}
        departments={departments ?? []}
        insuranceProviders={insurance ?? []}
        defaultPatientId={patient_id}
        defaultDoctorId={doctor_id}
        defaultDepartmentId={dept_id}
        defaultInsuranceId={insurance_id}
        clinicWorkingHours={clinicWorkingHours}
      />
    </div>
  );
}
