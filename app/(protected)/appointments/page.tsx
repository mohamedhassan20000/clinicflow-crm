import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { WeekCalendar } from "@/components/appointments/week-calendar";
import { AppointmentsFilterBar } from "@/components/appointments/filter-bar";

export const metadata: Metadata = { title: "Appointments" };

interface PageProps {
  searchParams: Promise<{
    week?: string;
    doctor?: string;
    dept?: string;
    file?: string;
    nat?: string;
    phone?: string;
    name?: string;
  }>;
}

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Parse "YYYY-MM-DD" as local-midnight (not UTC) so week navigation
// is stable regardless of server timezone.
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

export default async function AppointmentsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const { week, doctor, dept, file, nat, phone, name } = await searchParams;

  const weekStart = getMonday(week ? parseLocalDate(week) : new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const supabase = await createClient();

  // Load doctor + department lists for the filter bar (always shown)
  const [{ data: doctors }, { data: departments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
  ]);

  // If any patient-level filter (file/nat/phone/name) is active, resolve
  // matching patient IDs first and filter the appointment query by them.
  // This keeps the query logic simple and honors RLS naturally.
  let patientIds: string[] | null = null;
  const patientFilters = { file, nat, phone, name };
  const hasPatientFilter =
    !!file || !!nat || !!phone || !!name;

  if (hasPatientFilter) {
    let pq = supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false);

    if (patientFilters.file) {
      pq = pq.ilike("file_number", `%${patientFilters.file}%`);
    }
    if (patientFilters.nat) {
      pq = pq.ilike("national_id", `%${patientFilters.nat}%`);
    }
    if (patientFilters.phone) {
      pq = pq.ilike("phone", `%${patientFilters.phone}%`);
    }
    if (patientFilters.name) {
      pq = pq.ilike("full_name", `%${patientFilters.name}%`);
    }

    const { data: pats } = await pq.limit(500);
    patientIds = (pats ?? []).map((p) => p.id);
    if (patientIds.length === 0) patientIds = ["__none__"];
  }

  let query = supabase
    .from("appointments")
    .select(
      "*, patients(full_name, file_number), profiles!doctor_id(full_name), departments(name, color)",
    )
    .eq("clinic_id", user.clinicId)
    .gte("scheduled_at", weekStart.toISOString())
    .lt("scheduled_at", weekEnd.toISOString())
    .order("scheduled_at");

  if (doctor) query = query.eq("doctor_id", doctor);
  if (dept) query = query.eq("department_id", dept);
  if (patientIds) query = query.in("patient_id", patientIds);

  const { data: appointments } = await query;

  const total = appointments?.length ?? 0;
  const activeFilterCount =
    Number(!!doctor) +
    Number(!!dept) +
    Number(!!file) +
    Number(!!nat) +
    Number(!!phone) +
    Number(!!name);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
        <p className="text-sm text-muted-foreground">
          {total} appointment{total !== 1 ? "s" : ""} this week
          {activeFilterCount > 0 && " matching filters"}.
        </p>
      </div>

      <AppointmentsFilterBar
        doctors={doctors ?? []}
        departments={departments ?? []}
      />

      <WeekCalendar
        appointments={(appointments ?? []) as Parameters<typeof WeekCalendar>[0]["appointments"]}
        weekStart={weekStart}
        canEdit={user.role !== "manager"}
      />
    </div>
  );
}
