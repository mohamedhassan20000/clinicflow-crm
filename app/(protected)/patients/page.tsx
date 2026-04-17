import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientTable } from "@/components/patients/patient-table";

export const metadata: Metadata = { title: "Patients" };

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

export default async function PatientsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const { q = "", page: pageStr = "1" } = await searchParams;
  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("patients")
    .select("*", { count: "exact" })
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .order("full_name", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (q.trim()) {
    query = query.or(
      `full_name.ilike.%${q.trim()}%,phone.ilike.%${q.trim()}%`,
    );
  }

  const { data: patients, count } = await query;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
        <p className="text-sm text-muted-foreground">
          {count ?? 0} patient{count !== 1 ? "s" : ""} in your clinic.
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
