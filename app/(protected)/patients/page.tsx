import type { Metadata } from "next";
import Link from "next/link";
import { Archive, FileText, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PatientTable } from "@/components/patients/patient-table";
import { PatientsFilterBar } from "@/components/patients/filter-bar";
import { formatDoctorName } from "@/lib/format-doctor";
import { Button } from "@/components/ui/button";
import { getTranslations } from "next-intl/server";
import { DocumentTriggerLabel } from "@/components/documents/document-trigger-label";
import { AiIntakeReviewSection } from "@/components/patients/ai-intake-review-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataPatients") };
}

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
  const t = await getTranslations("protected");
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const isAssistant = user.role === "assistant";
  const isScopedViewer = isDoctor || isAssistant;
  const canManagePatients =
    user.role === "admin" || user.role === "receptionist";
  const canReviewAiIntakes = canManagePatients || user.role === "manager";
  const canViewPatientBalances = canManagePatients;

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
  } else if (!isAssistant) {
    if (dept) query = query.eq("department_id", dept);
    if (doctor) query = query.eq("assigned_doctor_id", doctor);
  }

  const [
    { data: patients, count },
    { data: departments },
    { data: doctors },
    { data: aiIntakes },
  ] =
    await Promise.all([
      query,
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      isScopedViewer
        ? Promise.resolve({ data: [] })
        : supabase
            .from("profiles")
            .select("id, full_name")
            .eq("clinic_id", user.clinicId)
            .eq("role", "doctor")
            .eq("is_active", true)
            .order("full_name"),
      canReviewAiIntakes
        ? supabase
            .from("ai_patient_intakes")
            .select(
              "id, conversation_id, full_name, date_of_birth, phone, email, national_id, created_at, department:departments!ai_patient_intakes_department_clinic_fkey(name), doctor:profiles!ai_patient_intakes_doctor_clinic_fkey(full_name), ai_appointment_requests(id, status)",
            )
            .eq("clinic_id", user.clinicId)
            .eq("review_status", "pending_review")
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] }),
    ]);

  const activeDept = departments?.find((d) =>
    isDoctor ? d.id === user.departmentId : d.id === dept,
  ) ?? null;
  const activeDoctor = isScopedViewer
    ? null
    : (doctors?.find((d) => d.id === doctor) ?? null);
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

  if (canViewPatientBalances && visiblePatients.length > 0) {
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

  const patientScope = isDoctor
    ? t("inYourDepartment")
    : isAssistant
      ? t("inYourAssignedScope")
      : t("inYourClinic");
  const documentQuery = new URLSearchParams();
  if (q.trim()) documentQuery.set("q", q.trim());
  if (dept) documentQuery.set("department", dept);
  if (doctor) documentQuery.set("doctor", doctor);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("patients")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("patientCountScope", {
              count: count ?? 0,
              scope: patientScope,
              department: activeDept ? ` · ${activeDept.name}` : "",
              doctor: activeDoctor ? ` · ${formatDoctorName(activeDoctor.full_name)}` : "",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href={`/documents/roster-profile/patient-list?${documentQuery}`}>
              <FileText className="h-3.5 w-3.5" />
              <DocumentTriggerLabel kind="patient-list" />
            </Link>
          </Button>
          {canManagePatients && (<>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/patients/trash">
                <Trash2 className="h-3.5 w-3.5" />
                {t("trash")}</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/patients/archive">
                <Archive className="h-3.5 w-3.5" />
                {t("archive")}</Link>
            </Button>
          </>)}
        </div>
      </div>

      <div className="print:hidden">
        <PatientsFilterBar
          doctors={doctors ?? []}
          departments={departments ?? []}
          showScopeFilters={!isScopedViewer}
        />
      </div>

      <PatientTable
        data={patientsWithBalance}
        total={count ?? 0}
        page={page}
        pageSize={PAGE_SIZE}
        canCreate={canManagePatients}
      />

      {canReviewAiIntakes && (
        <AiIntakeReviewSection
          intakes={(aiIntakes ?? []).map((intake) => ({
            id: intake.id,
            conversationId: intake.conversation_id,
            fullName: intake.full_name,
            dateOfBirth: intake.date_of_birth,
            phone: intake.phone,
            email: intake.email,
            nationalId: intake.national_id,
            departmentName: intake.department?.name ?? "—",
            doctorName: intake.doctor?.full_name ?? "—",
            createdAt: intake.created_at,
            hasAppointmentRequest: intake.ai_appointment_requests.some(
              (request) => request.status === "pending",
            ),
          }))}
        />
      )}
    </div>
  );
}
