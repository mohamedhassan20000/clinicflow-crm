import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientTable } from "@/components/patients/patient-table";
import { PatientsFilterBar } from "@/components/patients/filter-bar";

export const metadata: Metadata = { title: "Patients" };

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    q?: string;
    page?: string;
    dept?: string;
    doctor?: string;
  }>;
}

export default async function PatientsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const { q = "", page: pageStr = "1", dept, doctor } = await searchParams;
  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("patients")
    .select(
      "*, departments(id, name, color), assigned_doctor:profiles!assigned_doctor_id(id, full_name)",
      { count: "exact" },
    )
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .order("full_name", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (q.trim()) {
    const term = q.trim();
    query = query.or(
      `full_name.ilike.%${term}%,phone.ilike.%${term}%,file_number.ilike.%${term}%,national_id.ilike.%${term}%`,
    );
  }
  if (dept) query = query.eq("department_id", dept);
  if (doctor) query = query.eq("assigned_doctor_id", doctor);

  const [{ data: patients, count }, { data: departments }, { data: doctors }] =
    await Promise.all([
      query,
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .eq("role", "doctor")
        .eq("is_active", true)
        .order("full_name"),
    ]);

  const activeDept = departments?.find((d) => d.id === dept) ?? null;
  const activeDoctor = doctors?.find((d) => d.id === doctor) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
          <p className="text-sm text-muted-foreground">
            {count ?? 0} patient{count !== 1 ? "s" : ""} in your clinic
            {activeDept && ` · Department: ${activeDept.name}`}
            {activeDoctor && ` · Doctor: Dr. ${activeDoctor.full_name}`}.
          </p>
        </div>
      </div>

      <div className="print:hidden">
        <PatientsFilterBar
          doctors={doctors ?? []}
          departments={departments ?? []}
        />
      </div>

      {/* Print-only header */}
      <div className="hidden print:block print:mb-4">
        <h1 className="text-xl font-semibold">Patient roster</h1>
        <p className="text-xs text-muted-foreground">
          {count ?? 0} patient{count !== 1 ? "s" : ""}
          {" · "}
          {activeDept
            ? `Department: ${activeDept.name}`
            : activeDoctor
              ? `Doctor: Dr. ${activeDoctor.full_name}`
              : "All patients"}
          {activeDept && activeDoctor && ` · Doctor: Dr. ${activeDoctor.full_name}`}
          {" · "}
          Printed {new Date().toLocaleDateString("en-GB")}
        </p>
      </div>

      <PatientTable
        data={patients ?? []}
        total={count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        canCreate={user.role !== "manager"}
      />
    </div>
  );
}
