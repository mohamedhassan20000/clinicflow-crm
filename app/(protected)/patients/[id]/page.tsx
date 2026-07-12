import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DEFAULT_TIME_ZONE,
  clinicLocaleFromRow,
} from "@/lib/datetime";
import { getServerMoneyFormatter } from "@/lib/currency/server";
import { AlertCircle, Archive, CalendarPlus, ChevronLeft, FileText, Pencil, Receipt, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/appointments/status-badge";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import {
  MedicalNotesList,
  type MedicalNoteWithAttachments,
} from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";
import { AppointmentPaymentRow } from "@/components/patients/appointment-payment-row";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";
import { AddDepositDialog } from "@/components/patients/add-deposit-dialog";
import { PatientAvatarControls } from "@/components/patients/patient-avatar-controls";
import { PatientDocumentsSection } from "@/components/patients/patient-documents-section";
import {
  PatientPackagesSection,
  type PatientPackageDepartment,
  type PatientPackageItem,
  type PatientPackageService,
  type PatientPackageTemplate,
} from "@/components/patients/patient-packages-section";
import { FollowupsList, type FollowupItem } from "@/components/patients/followups-list";
import { PatientAvatarPreview } from "@/components/patients/patient-avatar-preview";
import { listPatientDocuments, type PatientDocumentsData } from "@/actions/patient-documents";
import type { MedicalNoteAttachmentItem } from "@/actions/medical-note-attachments";
import { formatDoctorName } from "@/lib/format-doctor";

export const metadata: Metadata = { title: "Patient" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PatientDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();
  const { data: clinic } = await supabase
    .from("clinics")
    .select("time_format, timezone, currency, locale, country, week_start, digits")
    .eq("id", user.clinicId)
    .single();
  const clinicLocale = clinicLocaleFromRow(clinic);
  const fmtMoney = await getServerMoneyFormatter(user.id, clinicLocale);

  // Base columns: always available, no migration dependency.
  const PATIENT_SELECT_BASE =
    "id, full_name, file_number, national_id, phone, email, date_of_birth, blood_type, created_at, is_deleted, avatar_path, assigned_doctor_id, department_id, departments(id, name, color), assigned_doctor:profiles!assigned_doctor_id(id, full_name), insurance_providers(name)";

  // Full columns: base + trash/archive fields added by migration 20260517100000.
  // Only used in the admin fallback (which only runs for deleted/archived rows,
  // which only exist after the migration is applied).
  const PATIENT_SELECT_FULL = PATIENT_SELECT_BASE + ", is_archived, deleted_at, archived_at";

  // Shape that covers both the regular query (base) and admin fallback (full).
  // Archive/trash fields are optional — absent for active patients, present for deleted/archived.
  type PatientData = {
    id: string;
    full_name: string;
    file_number: string | null;
    national_id: string | null;
    phone: string;
    email: string | null;
    date_of_birth: string;
    blood_type: string | null;
    created_at: string;
    is_deleted: boolean;
    is_archived?: boolean | null;
    deleted_at?: string | null;
    archived_at?: string | null;
    avatar_path: string | null;
    assigned_doctor_id: string | null;
    department_id: string | null;
    departments: { id: string; name: string; color: string } | null;
    assigned_doctor: { id: string; full_name: string | null } | null;
    insurance_providers: { name: string } | null;
  };

  let patient: PatientData | null = null;
  let patientError: { code: string } | null = null;

  {
    const result = await supabase
      .from("patients")
      .select(PATIENT_SELECT_BASE)
      .eq("id", id)
      .eq("clinic_id", user.clinicId)
      .single();
    patient = result.data as PatientData | null;
    patientError = result.error as { code: string } | null;
  }

  // Only use the admin fallback when RLS returned "no rows" (PGRST116), which
  // means the patient exists but is deleted/archived. Other error codes (schema
  // errors, auth) are not retried — they will correctly fall through to notFound().
  if (
    patientError?.code === "PGRST116" &&
    (user.role === "admin" || user.role === "receptionist")
  ) {
    const adminClient = createClinicScopedAdminClient(user.clinicId);
    const { data: adminPatient } = await adminClient
      .from("patients")
      .select(PATIENT_SELECT_FULL)
      .eq("id", id)
      .eq("clinic_id", user.clinicId)
      .single();
    patient = adminPatient as PatientData | null;
  }

  if (!patient) notFound();

  const isDoctor = user.role === "doctor";
  const isAdmin = user.role === "admin";
  const isReceptionist = user.role === "receptionist";
  const canManageMedicalNotes = isAdmin || isDoctor;
  const canViewMedicalNotes = canManageMedicalNotes || isReceptionist;
  const canViewDocuments =
    (isAdmin || isReceptionist) && !patient.is_deleted;
  const doctorCanAccessPatient =
    patient.assigned_doctor_id === user.id ||
    (!!user.departmentId && patient.department_id === user.departmentId);

  if (isDoctor && !doctorCanAccessPatient) notFound();

  let avatarUrl: string | null = null;
  if (patient.avatar_path) {
    const { data } = await supabase.storage
      .from("patient-assets")
      .createSignedUrl(patient.avatar_path, 60 * 60);
    avatarUrl = data?.signedUrl ?? null;
  }

  const [
    { data: notes },
    appointmentsResult,
    { data: followups },
    { data: packageRows },
    { data: packageTemplates },
    { data: packageDepartments },
    { data: packageServices },
  ] = await Promise.all([
    supabase
      .from("medical_notes")
      .select("id, patient_id, doctor_id, note, created_at, created_by, deleted_at, profiles!doctor_id(full_name)")
      .eq("patient_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("appointments")
      .select(
        "id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, secondary_payment_method, payment_note, cancellation_reason, cancelled_at, package_id, package_session_number, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name), patient_packages(name, total_sessions, used_sessions, price_per_session), appointment_services(id, name, price, quantity)",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: false })
      .limit(3),
    // Follow-ups recorded for this patient (any of their sessions).
    supabase
      .from("follow_ups")
      .select(
        "id, recorded_at, outcome, notes, appointment_id, recorded_by:profiles!recorded_by(full_name), appointment:appointments!appointment_id(scheduled_at, departments(name, color), profiles!doctor_id(full_name))",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .order("recorded_at", { ascending: false })
      .limit(3),
    supabase
      .from("patient_packages")
      .select(
        "id, patient_id, department_id, service_id, name, total_sessions, used_sessions, price_per_session, notes, is_active, departments(id, name, color), services(id, name)",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .order("is_active", { ascending: false })
      .order("updated_at", { ascending: false }),
    supabase
      .from("package_templates")
      .select(
        "id, department_id, name, total_sessions, price_per_session, total_price, notes, is_active",
      )
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true }),
    supabase
      .from("services")
      .select("id, name, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appointments = appointmentsResult.data as any[] | null;
  const patientPackages = (packageRows ?? []) as PatientPackageItem[];
  const activePackageTemplates = (packageTemplates ??
    []) as PatientPackageTemplate[];
  const packageDepartmentOptions = (packageDepartments ??
    []) as PatientPackageDepartment[];
  const packageServiceOptions = (packageServices ?? []) as PatientPackageService[];
  const noteRows = (notes ?? []) as MedicalNoteWithAttachments[];
  const noteIds = noteRows.map((note) => note.id);
  const attachmentsByNote = new Map<string, MedicalNoteAttachmentItem[]>();

  if (canViewMedicalNotes && noteIds.length > 0) {
    const { data: attachmentRows } = await supabase
      .from("medical_note_attachments")
      .select(
        "id, note_id, file_name, mime_type, size_bytes, created_at, uploaded_by, uploaded_by_profile:profiles!medical_note_attachments_uploaded_by_fkey(full_name)",
      )
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", id)
      .in("note_id", noteIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    for (const row of (attachmentRows ?? []) as {
      id: string;
      note_id: string;
      file_name: string;
      mime_type: string;
      size_bytes: number;
      created_at: string;
      uploaded_by: string | null;
      uploaded_by_profile?: { full_name: string | null } | null;
    }[]) {
      const list = attachmentsByNote.get(row.note_id) ?? [];
      list.push({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        createdAt: row.created_at,
        uploadedById: row.uploaded_by,
        uploadedByName: row.uploaded_by_profile?.full_name ?? null,
      });
      attachmentsByNote.set(row.note_id, list);
    }
  }

  const notesWithAttachments = noteRows.map((note) => ({
    ...note,
    attachments: attachmentsByNote.get(note.id) ?? [],
  }));

  // Financial data — only loaded for non-doctor roles
  const settlementsByAppt = new Map<
    string,
    {
      id: string;
      settled_at: string;
      amount: number;
      payment_method: string;
      note: string | null;
    }[]
  >();
  let billingTotals = { billed: 0, collected: 0, outstanding: 0 };
  let accountBalance = 0;

  if (!isDoctor) {
    const [
      { data: settlements },
      { data: deposits },
      { data: spentRows },
    ] = await Promise.all([
      supabase
        .from("outstanding_settlements")
        .select("id, appointment_id, settled_at, amount, payment_method, note")
        .eq("patient_id", id)
        .eq("clinic_id", user.clinicId)
        .order("settled_at", { ascending: true }),
      supabase
        .from("patient_deposits")
        .select("amount")
        .eq("patient_id", id)
        .eq("clinic_id", user.clinicId),
      supabase
        .from("appointments")
        .select("deposit_amount")
        .eq("patient_id", id)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null),
    ]);

    for (const s of settlements ?? []) {
      if (!s.appointment_id) continue;
      const list = settlementsByAppt.get(s.appointment_id) ?? [];
      list.push({
        id: s.id,
        settled_at: s.settled_at,
        amount: Number(s.amount ?? 0),
        payment_method: s.payment_method,
        note: s.note,
      });
      settlementsByAppt.set(s.appointment_id, list);
    }

    const totalDeposited = (deposits ?? []).reduce(
      (s, r) => s + Number(r.amount ?? 0),
      0,
    );
    const totalSpent = (spentRows ?? []).reduce(
      (s, r) => s + Number(r.deposit_amount ?? 0),
      0,
    );
    accountBalance = Math.max(0, Number((totalDeposited - totalSpent).toFixed(2)));

    const completed = (appointments ?? []).filter((a) => a.status === "completed");
    billingTotals = completed.reduce(
      (acc, a) => {
        acc.billed += (a as { total_amount?: number }).total_amount ?? 0;
        acc.collected +=
          ((a as { paid_amount?: number }).paid_amount ?? 0) +
          ((a as { insurance_amount?: number }).insurance_amount ?? 0) +
          ((a as { secondary_amount?: number }).secondary_amount ?? 0) +
          ((a as { deposit_amount?: number }).deposit_amount ?? 0);
        acc.outstanding += (a as { outstanding_amount?: number }).outstanding_amount ?? 0;
        return acc;
      },
      { billed: 0, collected: 0, outstanding: 0 },
    );
  }

  const canEdit = !isDoctor && user.role !== "manager" && !patient.is_deleted;
  let patientDocuments: PatientDocumentsData | null = null;
  let patientDocumentsLoadFailed = false;
  if (canViewDocuments) {
    const result = await listPatientDocuments(id);
    patientDocumentsLoadFailed = Boolean(result.error);
    patientDocuments = result.data ?? {
      nationalId: null,
      insurance: null,
      other: [],
    };
  }
  const age =
    new Date().getFullYear() - new Date(patient.date_of_birth).getFullYear();

  const doctorName = patient.assigned_doctor?.full_name ?? null;
  const deptInfo = patient.departments;
  const insuranceProviderName = patient.insurance_providers?.name ?? null;
  const initials = patient.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 print:hidden">
        <Link
          href="/patients"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Patients
        </Link>
      </div>

      {/* Status banner — shown for deleted / archived patients */}
      {patient.is_archived && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3">
          <Archive className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800">Archived patient</p>
            <p className="text-xs text-amber-700 mt-0.5">
              This patient was archived on{" "}
              {patient.archived_at
                ? new Date(patient.archived_at).toLocaleDateString("en-GB", { dateStyle: "long" })
                : "an unknown date"}
              . Their full history is preserved below in read-only mode.
            </p>
          </div>
          <Link href="/patients/archive" className="shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900 underline underline-offset-2">
            Archive
          </Link>
        </div>
      )}
      {patient.is_deleted && !patient.is_archived && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-4 py-3">
          <Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-destructive">Patient is in Trash</p>
            <p className="text-xs text-destructive/80 mt-0.5">
              Moved to trash on{" "}
              {patient.deleted_at
                ? new Date(patient.deleted_at).toLocaleDateString("en-GB", { dateStyle: "long" })
                : "an unknown date"}
              . Their full history is preserved below in read-only mode. Restore the patient to make edits.
            </p>
          </div>
          <Link href="/patients/trash" className="shrink-0 text-xs font-medium text-destructive hover:text-destructive/80 underline underline-offset-2">
            Trash
          </Link>
        </div>
      )}

      {/* Header */}
      <div
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div className="flex min-w-0 items-start gap-3">
          <PatientAvatarPreview
            avatarUrl={avatarUrl}
            fullName={patient.full_name}
            initials={initials}
          />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {patient.full_name}
              </h1>
              {patient.file_number && (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] tracking-wider"
                >
                  {patient.file_number}
                </Badge>
              )}
              {patient.is_deleted && (
                <Badge variant="destructive" className="text-xs">
                  Deleted
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {age} years old ·{" "}
              {new Date(patient.date_of_birth).toLocaleDateString("en-GB")}
              {patient.blood_type && ` · ${patient.blood_type}`}
            </p>
            {canEdit && (
              <PatientAvatarControls
                patientId={id}
                hasAvatar={Boolean(patient.avatar_path)}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 print:hidden">
          {!isDoctor && !patient.is_deleted && (
            <Button asChild size="sm" className="gap-1.5">
              <Link href={`/appointments/new?patient_id=${id}`}>
                <CalendarPlus className="h-3.5 w-3.5" />
                Book appointment
              </Link>
            </Button>
          )}
          {canEdit && (
            <>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`/patients/${id}/edit`}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Link>
            </Button>
            {!patient.is_deleted && (
              <DeletePatientButton patientId={id} />
            )}
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile card */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Profile
            </h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">File number</dt>
                <dd className="font-mono font-medium">
                  {patient.file_number ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">National ID</dt>
                <dd className="font-mono font-medium">
                  {patient.national_id ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Birth date</dt>
                <dd className="font-medium">
                  {new Date(patient.date_of_birth).toLocaleDateString("en-GB")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Phone</dt>
                <dd className="font-medium">{patient.phone}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="font-medium break-all">{patient.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Department</dt>
                <dd className="font-medium">
                  {deptInfo ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: deptInfo.color }}
                      />
                      {deptInfo.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">Unassigned</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Treating doctor</dt>
                <dd className="font-medium">
                  {doctorName ? (
                    formatDoctorName(doctorName)
                  ) : (
                    <span className="text-muted-foreground/60">Unassigned</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Insurance</dt>
                <dd className="font-medium">
                  {insuranceProviderName ?? (
                    <span className="text-muted-foreground/60">
                      No insurance
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Registered</dt>
                <dd className="font-medium">
                  {new Date(patient.created_at).toLocaleDateString("en-GB")}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Right column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Billing summary strip — hidden for doctors */}
          {!isDoctor && <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Receipt className="h-4 w-4" />
                Billing
              </h2>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <AddDepositDialog
                    patientId={id}
                    patientName={patient.full_name}
                  />
                  {billingTotals.outstanding > 0 && (
                    <SettleOutstandingDialog
                      patientId={id}
                      outstanding={billingTotals.outstanding}
                      patientName={patient.full_name}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl border border-border/50 bg-border/40 overflow-hidden">
              <BillingCell
                label="Billed"
                amount={billingTotals.billed}
                formatAmount={fmtMoney}
              />
              <BillingCell
                label="Collected"
                amount={billingTotals.collected}
                formatAmount={fmtMoney}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <BillingCell
                label="Outstanding"
                amount={billingTotals.outstanding}
                formatAmount={fmtMoney}
                accent={
                  billingTotals.outstanding > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                }
              />
              <BillingCell
                label="Account balance"
                amount={accountBalance}
                formatAmount={fmtMoney}
                accent={
                  accountBalance > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                }
              />
            </div>
            {billingTotals.outstanding > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                This patient has an outstanding balance of{" "}
                <span className="font-semibold tabular-nums">
                  {fmtMoney(billingTotals.outstanding)}
                </span>
                .
              </div>
            )}
          </div>}

          {canViewDocuments && patientDocuments && (
            <PatientDocumentsSection
              patientId={id}
              initialDocuments={patientDocuments}
              hasLoadError={patientDocumentsLoadFailed}
            />
          )}

          <PatientPackagesSection
            patientId={id}
            packages={patientPackages}
            departments={packageDepartmentOptions}
            services={packageServiceOptions}
            packageTemplates={activePackageTemplates}
            patientDepartmentId={patient.department_id}
            canManage={canEdit}
          />

          {/* Appointments */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Appointments
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {appointments?.length ?? 0} record
                  {appointments?.length !== 1 ? "s" : ""}
                </span>
                <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <Link href={`/patients/${id}/appointments-report`}>
                    <FileText className="h-3 w-3" />
                    Full report
                  </Link>
                </Button>
              </div>
            </div>
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              {appointments && appointments.length > 0 ? (
                <div>
                  {appointments.map((a) =>
                    isDoctor ? (
                      <SimpleApptRow key={a.id} a={a as Parameters<typeof SimpleApptRow>[0]["a"]} />
                    ) : (
                      <AppointmentPaymentRow
                        key={a.id}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        a={a as any}
                        settlements={settlementsByAppt.get(a.id) ?? []}
                      />
                    )
                  )}
                </div>
              ) : (
                <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                  No appointments yet.
                </div>
              )}
            </div>
            {!isDoctor && (appointments ?? []).some((a) => a.status === "completed") && (
              <p className="text-[11px] text-muted-foreground">
                Tip: click a completed appointment to see its payment breakdown.
              </p>
            )}
          </div>

          {/* Follow-up notes — receptionist phone-back records */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Follow-up Notes
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {followups?.length ?? 0} record{followups?.length !== 1 ? "s" : ""}
                </span>
                <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <Link href={`/patients/${id}/followups-report`}>
                    <FileText className="h-3 w-3" />
                    Full report
                  </Link>
                </Button>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
              <FollowupsList followups={(followups ?? []) as FollowupItem[]} />
            </div>
          </div>

          {/* Medical notes */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Medical Notes
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {notes?.length ?? 0} note{notes?.length !== 1 ? "s" : ""}
              </span>
              {canViewMedicalNotes && (
                <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <Link href={`/patients/${id}/medical-notes-report`}>
                    <FileText className="h-3 w-3" />
                    Full report
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {canManageMedicalNotes && !patient.is_deleted && (
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <NoteComposer patientId={id} />
            </div>
          )}

          {!canViewMedicalNotes && (
            <div className="rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Medical notes are visible to clinical and reception staff only.
            </div>
          )}

          {canViewMedicalNotes && (
            <MedicalNotesList
              notes={notesWithAttachments}
              patientId={id}
              currentUserId={user.id}
              canManageAllAttachments={isAdmin}
              canMutateNotes={canManageMedicalNotes}
              canUploadAttachments={canManageMedicalNotes}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SimpleApptRow({
  a,
}: {
  a: {
    id: string;
    scheduled_at: string;
    status: string;
    cancellation_reason?: string | null;
    profiles?: { full_name: string } | null;
    departments?: { name: string; color: string } | null;
    insurance_providers?: { name: string } | null;
    appointment_services?: { id: string; name: string; price: number; quantity: number }[];
  };
}) {
  const dept = a.departments;
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium tabular-nums text-xs">
          {new Date(a.scheduled_at).toLocaleString("en-GB", {
            timeZone: DEFAULT_TIME_ZONE,
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDoctorName(a.profiles?.full_name)}
          {dept?.name && (
            <>
              {" · "}
              <span
                style={{ color: dept.color }}
                className="font-medium"
              >
                {dept.name}
              </span>
            </>
          )}
        </p>
      </div>
      <StatusBadge status={a.status as Parameters<typeof StatusBadge>[0]["status"]} />
    </div>
  );
}

function BillingCell({
  label,
  amount,
  formatAmount,
  accent,
}: {
  label: string;
  amount: number;
  formatAmount: (amount: number) => string;
  accent?: string;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${accent ?? ""}`}>
        {formatAmount(amount)}
      </p>
    </div>
  );
}
