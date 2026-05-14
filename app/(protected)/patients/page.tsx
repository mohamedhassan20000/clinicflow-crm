import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientTable } from "@/components/patients/patient-table";
import { PatientsFilterBar } from "@/components/patients/filter-bar";
import { formatDoctorName } from "@/lib/format-doctor";
import { PrintHeader } from "@/components/shared/print-header";

export const metadata: Metadata = { title: "Patients" };

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    q?: string;
    name?: string;
    file?: string;
    nat?: string;
    phone?: string;
    page?: string;
    dept?: string;
    doctor?: string;
  }>;
}

export default async function PatientsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const isDoctor = user.role === "doctor";

  const {
    q = "",
    name = "",
    file = "",
    nat = "",
    phone = "",
    page: pageStr = "1",
    dept,
    doctor,
  } = await searchParams;
  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("patients")
    .select(
      "id, file_number, full_name, national_id, phone, blood_type, department_id, assigned_doctor_id, avatar_path, departments(id, name, color), assigned_doctor:profiles!assigned_doctor_id(id, full_name)",
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
  if (name.trim()) query = query.ilike("full_name", `%${name.trim()}%`);
  if (file.trim()) query = query.ilike("file_number", `%${file.trim()}%`);
  if (nat.trim()) query = query.ilike("national_id", `%${nat.trim()}%`);
  if (phone.trim()) query = query.ilike("phone", `%${phone.trim()}%`);

  // Doctors are always scoped to their own department
  if (isDoctor && user.departmentId) {
    query = query.eq("department_id", user.departmentId);
  } else {
    if (dept) query = query.eq("department_id", dept);
    if (doctor) query = query.eq("assigned_doctor_id", doctor);
  }

  const [{ data: patients, count }, { data: departments }, { data: doctors }] =
    await Promise.all([
      query,
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      isDoctor
        ? Promise.resolve({ data: [] })
        : supabase
            .from("profiles")
            .select("id, full_name")
            .eq("clinic_id", user.clinicId)
            .eq("role", "doctor")
            .eq("is_active", true)
            .order("full_name"),
    ]);

  const activeDept = departments?.find((d) =>
    isDoctor ? d.id === user.departmentId : d.id === dept,
  ) ?? null;
  const activeDoctor = isDoctor ? null : (doctors?.find((d) => d.id === doctor) ?? null);
  const visiblePatients = patients ?? [];
  const outstandingPatientIds = new Set<string>();
  const avatarUrls = new Map<string, string>();
  const avatarPaths = visiblePatients
    .map((patient) => patient.avatar_path)
    .filter((path): path is string => Boolean(path));

  if (avatarPaths.length > 0) {
    const { data } = await supabase.storage
      .from("patient-assets")
      .createSignedUrls(avatarPaths, 60 * 60);
    const signedUrls = new Map(
      (data ?? [])
        .filter((item) => item.path && item.signedUrl)
        .map((item) => [item.path, item.signedUrl] as const),
    );
    for (const patient of visiblePatients) {
      if (!patient.avatar_path) continue;
      const signedUrl = signedUrls.get(patient.avatar_path);
      if (signedUrl) avatarUrls.set(patient.id, signedUrl);
    }
  }

  if (!isDoctor && visiblePatients.length > 0) {
    const { data: outstandingRows } = await supabase
      .from("appointments")
      .select("patient_id")
      .eq("clinic_id", user.clinicId)
      .in(
        "patient_id",
        visiblePatients.map((patient) => patient.id),
      )
      .gt("outstanding_amount", 0)
      .is("deleted_at", null);

    for (const row of outstandingRows ?? []) {
      outstandingPatientIds.add(row.patient_id);
    }
  }

  const patientsWithBalance = visiblePatients.map((patient) => ({
    ...patient,
    avatar_url: avatarUrls.get(patient.id) ?? null,
    has_outstanding_balance: outstandingPatientIds.has(patient.id),
  }));

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, address, phone, logo_url")
    .eq("id", user.clinicId)
    .single();

  const generatedAt = new Date().toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName="Patient Roster"
        generatedAt={generatedAt}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
          <p className="text-sm text-muted-foreground">
            {count ?? 0} patient{count !== 1 ? "s" : ""}
            {isDoctor ? " in your department" : " in your clinic"}
            {activeDept && ` · ${activeDept.name}`}
            {activeDoctor && ` · ${formatDoctorName(activeDoctor.full_name)}`}.
          </p>
        </div>
      </div>

      <div className="print:hidden">
        <PatientsFilterBar
          doctors={doctors ?? []}
          departments={departments ?? []}
          showScopeFilters={!isDoctor}
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
              ? `Doctor: ${formatDoctorName(activeDoctor.full_name)}`
              : "All patients"}
          {activeDept &&
            activeDoctor &&
            ` · Doctor: ${formatDoctorName(activeDoctor.full_name)}`}
          {" · "}
          Printed {new Date().toLocaleDateString("en-GB")}
        </p>
      </div>

      <PatientTable
        data={patientsWithBalance}
        total={count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        canCreate={!isDoctor && user.role !== "manager"}
      />
    </div>
  );
}
