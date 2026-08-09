import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  clinicLocaleFromRow,
  formatClinicDate,
} from "@/lib/datetime";
import { getServerMoneyFormatter } from "@/lib/currency/server";
import { AlertCircle, Archive, CalendarPlus, FileText, Package, Pencil, Receipt, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";
import { PatientAvatarControls } from "@/components/patients/patient-avatar-controls";
import { PatientDocumentsSection } from "@/components/patients/patient-documents-section";
import {
  PatientPackagesSection,
  type PatientPackageDepartment,
  type PatientPackageItem,
  type PatientPackageService,
  type PatientPackageTemplate,
} from "@/components/patients/patient-packages-section";
import { PatientAvatarPreview } from "@/components/patients/patient-avatar-preview";
import { AppointmentHistorySection } from "@/components/patients/file/appointment-history-section";
import { PatientDepositsSection } from "@/components/patients/file/patient-deposits-section";
import { PatientFileClinicalActions } from "@/components/patients/file/patient-file-clinical-actions";
import {
  computeBillingTotals,
  loadAppointmentHistory,
  loadPatientDeposits,
  PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT,
} from "@/lib/patients/file-data";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import {
  listClinicalAuthoringOptions,
  type ClinicalAuthoringOptions,
} from "@/actions/clinical/authoring";
import { listPatientDocuments, type PatientDocumentsData } from "@/actions/patient-documents";
import { formatDoctorName } from "@/lib/format-doctor";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo, withReturnTo } from "@/lib/navigation/return-url";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { DocumentTriggerLabel } from "@/components/documents/document-trigger-label";

const DEPOSITS_PREVIEW_LIMIT = 5;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataPatient") };
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ returnTo?: string }>;
}

export default async function PatientDetailPage({ params, searchParams }: PageProps) {
  const t = await getTranslations("protected");
  const tp = await getTranslations("patients");
  const { id } = await params;
  const pageSearchParams: { returnTo?: string } = searchParams ? await searchParams : {};
  const { returnTo } = pageSearchParams;
  const user = await requireUser();
  const allowedParentPaths = user.role === "admin" || user.role === "receptionist"
    ? ["/patients", "/patients/archive", "/patients/trash"]
    : ["/patients"];
  const patientsUrl = resolveReturnTo(returnTo, "/patients", allowedParentPaths);
  const parentPath = new URL(patientsUrl, "https://clinicflow.local").pathname;
  const parentLabel = parentPath === "/patients/archive"
    ? "archive"
    : parentPath === "/patients/trash"
      ? "trash"
      : "patients";
  const patientPath = `/patients/${id}`;
  const patientUrl = withReturnTo(patientPath, patientsUrl);
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
  const PATIENT_SELECT_FULL = PATIENT_SELECT_BASE + ", is_archived, deleted_at, archived_at";

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
  const isAssistant = user.role === "assistant";
  const isScopedClinical = isDoctor || isAssistant;
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

  const patientAssistantContext = { type: "patient", patientId: patient.id } as const;
  const assistantPromise = isScopedClinical && !patient.is_deleted
    ? resolveAssistantLauncher({ user, context: patientAssistantContext })
    : null;

  let avatarUrl: string | null = null;
  if (patient.avatar_path) {
    const { data } = await supabase.storage
      .from("patient-assets")
      .createSignedUrl(patient.avatar_path, 60 * 60);
    avatarUrl = data?.signedUrl ?? null;
  }

  const [
    { data: packageRows },
    { data: packageTemplates },
    { data: packageDepartments },
    { data: packageServices },
    history,
    docTypeLabels,
  ] = await Promise.all([
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
      .select("id, department_id, name, total_sessions, price_per_session, total_price, notes, is_active")
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
    loadAppointmentHistory(supabase, {
      clinicId: user.clinicId,
      patientId: id,
      isScopedClinical,
      limit: PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT,
      includeNoteAttachments: canViewMedicalNotes,
    }),
    getDocumentTypeLabels(),
  ]);

  const patientPackages = (packageRows ?? []) as PatientPackageItem[];
  const activePackageTemplates = (packageTemplates ?? []) as PatientPackageTemplate[];
  const packageDepartmentOptions = (packageDepartments ?? []) as PatientPackageDepartment[];
  const packageServiceOptions = (packageServices ?? []) as PatientPackageService[];

  // Financial data is never loaded for scoped clinical roles.
  let billingTotals = { billed: 0, collected: 0, outstanding: 0 };
  let accountBalance = 0;
  let recentDeposits: Awaited<ReturnType<typeof loadPatientDeposits>>["transactions"] = [];

  if (!isScopedClinical) {
    const [{ data: billableRows }, deposits] = await Promise.all([
      supabase
        .from("appointments")
        .select(
          "status, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount",
        )
        .eq("patient_id", id)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null)
        .eq("status", "completed"),
      loadPatientDeposits(supabase, { clinicId: user.clinicId, patientId: id }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    billingTotals = computeBillingTotals((billableRows ?? []) as any[]);
    accountBalance = deposits.state.accountBalance;
    recentDeposits = deposits.transactions.slice(0, DEPOSITS_PREVIEW_LIMIT);
  }

  const canEdit =
    (isAdmin || isReceptionist) && !patient.is_deleted;

  // Contextual clinical authoring is available to any authorized preparer for an
  // active patient. Loading is best-effort — a failure never breaks the page.
  let clinicalOptions: ClinicalAuthoringOptions | null = null;
  if (!patient.is_deleted) {
    try {
      clinicalOptions = await listClinicalAuthoringOptions();
    } catch {
      clinicalOptions = null;
    }
  }
  const clinicalActionsNode = clinicalOptions ? (
    <PatientFileClinicalActions
      patientId={id}
      patientName={patient.full_name}
      fileNumber={patient.file_number}
      options={{
        ...clinicalOptions,
        appointments: clinicalOptions.appointments.filter(
          (a) => a.patientId === id,
        ),
      }}
      locale={clinicLocale.locale === "ar" ? "ar" : "en"}
    />
  ) : null;

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
  const assistant = assistantPromise ? await assistantPromise : null;
  const initials = patient.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const billingSummaryNode = !isScopedClinical ? (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Receipt className="h-4 w-4" />
          {t("billing")}
        </h3>
        {canEdit && billingTotals.outstanding > 0 && (
          <SettleOutstandingDialog
            patientId={id}
            outstanding={billingTotals.outstanding}
            patientName={patient.full_name}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/40 sm:grid-cols-4">
        <BillingCell label={t("billed")} amount={billingTotals.billed} formatAmount={fmtMoney} />
        <BillingCell
          label={t("collected")}
          amount={billingTotals.collected}
          formatAmount={fmtMoney}
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <BillingCell
          label={t("outstanding")}
          amount={billingTotals.outstanding}
          formatAmount={fmtMoney}
          accent={billingTotals.outstanding > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
        />
        <BillingCell
          label={t("accountBalance")}
          amount={accountBalance}
          formatAmount={fmtMoney}
          accent={accountBalance > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}
        />
      </div>
      {billingTotals.outstanding > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {t("thisPatientHasAnOutstandingBalance")} {" "}
          <span className="font-semibold tabular-nums">{fmtMoney(billingTotals.outstanding)}</span>.
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: patientsUrl, label: parentLabel }}
        breadcrumbs={[
          { label: parentLabel[0].toUpperCase() + parentLabel.slice(1), href: patientsUrl },
          { label: patient.full_name },
        ]}
        leading={
          <PatientAvatarPreview
            avatarUrl={avatarUrl}
            fullName={patient.full_name}
            initials={initials}
          />
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{patient.full_name}</span>
            {patient.file_number ? (
              <Badge variant="secondary" className="font-mono text-[11px] tracking-wider">
                {patient.file_number}
              </Badge>
            ) : null}
            {patient.is_deleted ? <Badge variant="destructive">{t("deleted")}</Badge> : null}
          </span>
        }
        description={
          <div className="space-y-1">
            <p>
          {age} {t("yearsOld")}{formatClinicDate(patient.date_of_birth, clinicLocale)}
              {patient.blood_type && ` · ${patient.blood_type}`}
            </p>
            {canEdit ? (
              <PatientAvatarControls patientId={id} hasAvatar={Boolean(patient.avatar_path)} />
            ) : null}
          </div>
        }
        actions={
          <>
            {!patient.is_deleted ? (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link href={`/documents/roster-profile/patient-file?patientId=${encodeURIComponent(id)}`}>
                  <FileText className="size-3.5" aria-hidden="true" />
                  <DocumentTriggerLabel kind="patient-file" />
                </Link>
              </Button>
            ) : null}
            {assistant ? (
              <AssistantLauncherEntry
                resolution={assistant}
                contextLabel={patient.full_name}
                role={user.role}
              />
            ) : null}
            {!isDoctor && !patient.is_deleted ? (
              <Button asChild size="sm" className="gap-1.5">
                <Link href={withReturnTo(`/appointments/new?patient_id=${id}`, patientUrl)}>
                  <CalendarPlus className="size-3.5" aria-hidden="true" />
                  {t("bookAppointment")}</Link>
              </Button>
            ) : null}
            {canEdit ? (
              <>
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <Link href={withReturnTo(`${patientPath}/edit`, patientUrl)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    {t("edit")}</Link>
                </Button>
                {!patient.is_deleted ? <DeletePatientButton patientId={id} /> : null}
              </>
            ) : null}
          </>
        }
      />

      {/* Status banner — shown for deleted / archived patients */}
      {patient.is_archived && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3">
          <Archive className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800">{t("archivedPatient")}</p>
            <p className="text-xs text-amber-700 mt-0.5">
              {t("thisPatientWasArchivedOn")}{" "}
              {patient.archived_at
                ? new Date(patient.archived_at).toLocaleDateString(t("enGb"), { dateStyle: "long" })
                : t("anunknowndate")}
              {t("theirFullHistoryIsPreservedBelow")}</p>
          </div>
          <Link href="/patients/archive" className="shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900 underline underline-offset-2">
            {t("archive")}</Link>
        </div>
      )}
      {patient.is_deleted && !patient.is_archived && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-4 py-3">
          <Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-destructive">{t("patientIsInTrash")}</p>
            <p className="text-xs text-destructive/80 mt-0.5">
              {t("movedToTrashOn")}{" "}
              {patient.deleted_at
                ? new Date(patient.deleted_at).toLocaleDateString(t("enGb"), { dateStyle: "long" })
                : t("anunknowndate")}
              {t("theirFullHistoryIsPreservedBelow2")}</p>
          </div>
          <Link href="/patients/trash" className="shrink-0 text-xs font-medium text-destructive hover:text-destructive/80 underline underline-offset-2">
            {t("trash")}</Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile card */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("profile")}</h2>
            <dl className="space-y-3 text-sm">
              <ProfileRow label={t("fileNumber")}>
                <span className="font-mono font-medium">{patient.file_number ?? "—"}</span>
              </ProfileRow>
              <ProfileRow label={t("nationalId")}>
                <span className="font-mono font-medium">{patient.national_id ?? "—"}</span>
              </ProfileRow>
              <ProfileRow label={t("birthDate")}>
                <span className="font-medium">{formatClinicDate(patient.date_of_birth, clinicLocale)}</span>
              </ProfileRow>
              <ProfileRow label={t("phone")}>
                <span className="font-medium">{patient.phone}</span>
              </ProfileRow>
              <ProfileRow label={t("email")}>
                <span className="font-medium break-all">{patient.email}</span>
              </ProfileRow>
              <ProfileRow label={t("department")}>
                {deptInfo ? (
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: deptInfo.color }} />
                    {deptInfo.name}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">{t("unassigned")}</span>
                )}
              </ProfileRow>
              <ProfileRow label={t("treatingDoctor")}>
                {doctorName ? (
                  <span className="font-medium">{formatDoctorName(doctorName)}</span>
                ) : (
                  <span className="text-muted-foreground/60">{t("unassigned")}</span>
                )}
              </ProfileRow>
              <ProfileRow label={t("insurance")}>
                {insuranceProviderName ? (
                  <span className="font-medium">{insuranceProviderName}</span>
                ) : (
                  <span className="text-muted-foreground/60">{t("noInsurance")}</span>
                )}
              </ProfileRow>
              <ProfileRow label={t("registered")}>
                <span className="font-medium">{formatClinicDate(patient.created_at, clinicLocale)}</span>
              </ProfileRow>
            </dl>
          </div>
        </div>

        {/* Right column — timeline workspace */}
        <div className="lg:col-span-2 space-y-6">
          {/* Unified appointment history — latest 5 + contextual clinical actions */}
          <AppointmentHistorySection
            t={tp}
            entries={history.entries}
            settlementsByAppointment={history.settlementsByAppointment}
            isScopedClinical={isScopedClinical}
            docTypeLabels={docTypeLabels}
            totalCount={history.totalCount}
            patientId={id}
            currentUserId={user.id}
            canManageAllAttachments={isAdmin}
            canMutateNotes={canManageMedicalNotes}
            canViewNoteAttachments={canViewMedicalNotes}
            canUploadNoteAttachments={canManageMedicalNotes}
            canAuthorNotes={canManageMedicalNotes && !patient.is_deleted}
            viewAllHref={withReturnTo(`${patientPath}/history`, patientUrl)}
            actions={clinicalActionsNode}
          />

          {/* Deposits — recent + dedicated page (financial) */}
          {!isScopedClinical && (
            <PatientDepositsSection
              t={tp}
              patientId={id}
              patientName={patient.full_name}
              accountBalance={accountBalance}
              transactions={recentDeposits}
              formatMoney={fmtMoney}
              clinicLocale={clinicLocale}
              canManage={canEdit}
              viewAllHref={withReturnTo(`${patientPath}/deposits`, patientUrl)}
              billingSummary={billingSummaryNode}
            />
          )}

          {/* Packages — recent/current + dedicated page */}
          <div className="space-y-2">
            <div className="flex justify-end print:hidden">
              <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                <Link href={withReturnTo(`${patientPath}/packages`, patientUrl)}>
                  <Package className="h-3 w-3" />
                  {tp("viewAllPackages")}
                </Link>
              </Button>
            </div>
            <PatientPackagesSection
              patientId={id}
              packages={patientPackages}
              departments={packageDepartmentOptions}
              services={packageServiceOptions}
              packageTemplates={activePackageTemplates}
              patientDepartmentId={patient.department_id}
              canManage={canEdit}
            />
          </div>

          {canViewDocuments && patientDocuments && (
            <PatientDocumentsSection
              patientId={id}
              initialDocuments={patientDocuments}
              hasLoadError={patientDocumentsLoadFailed}
            />
          )}

          {/* Patient activity trail */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("patientActivity")}</h2>
            <ActivityTimeline patientId={id} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
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
