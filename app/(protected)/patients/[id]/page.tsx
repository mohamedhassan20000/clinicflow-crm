import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, ChevronLeft, Pencil, Receipt } from "lucide-react";
import { StatusBadge } from "@/components/appointments/status-badge";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";
import { AppointmentPaymentRow } from "@/components/patients/appointment-payment-row";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";
import { AddDepositDialog } from "@/components/patients/add-deposit-dialog";
import { PatientAvatarControls } from "@/components/patients/patient-avatar-controls";
import { PatientDocumentsSection } from "@/components/patients/patient-documents-section";
import { PatientAvatarPreview } from "@/components/patients/patient-avatar-preview";
import { PatientProfilePrintButton } from "@/components/patients/patient-profile-print-button";
import { listPatientDocuments, type PatientDocumentsData } from "@/actions/patient-documents";
import { formatDoctorName } from "@/lib/format-doctor";

export const metadata: Metadata = { title: "Patient" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PatientDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "*, departments(id, name, color), assigned_doctor:profiles!assigned_doctor_id(id, full_name), insurance_providers(name)",
    )
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  const isDoctor = user.role === "doctor";
  const isAdmin = user.role === "admin";
  const canViewDocuments =
    (isAdmin || user.role === "receptionist") && !patient.is_deleted;
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
  ] = await Promise.all([
    supabase
      .from("medical_notes")
      .select("*, profiles!doctor_id(full_name)")
      .eq("patient_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("appointments")
      .select(
        "id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, secondary_payment_method, payment_note, cancellation_reason, cancelled_at, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name), appointment_services(id, name, price, quantity)",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: false })
      .limit(30),
    // Follow-ups recorded for this patient (any of their sessions).
    supabase
      .from("follow_ups")
      .select(
        "id, recorded_at, outcome, notes, appointment_id, recorded_by:profiles!recorded_by(full_name), appointment:appointments!appointment_id(scheduled_at, departments(name, color), profiles!doctor_id(full_name))",
      )
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .order("recorded_at", { ascending: false }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appointments = appointmentsResult.data as any[] | null;

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
    <div className="space-y-6" data-patient-profile-print-root>
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 print:hidden" data-patient-profile-print-hide>
        <Link
          href="/patients"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Patients
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
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

        <div className="flex items-center gap-2 print:hidden" data-patient-profile-print-hide>
          <PatientProfilePrintButton />
          {canEdit && (
            <>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`/patients/${id}/edit`}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Link>
            </Button>
            {isAdmin && !patient.is_deleted && (
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
        <div className="lg:col-span-2 space-y-6" data-patient-profile-print-hide>
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
              <BillingCell label="Billed" amount={billingTotals.billed} />
              <BillingCell
                label="Collected"
                amount={billingTotals.collected}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <BillingCell
                label="Outstanding"
                amount={billingTotals.outstanding}
                accent={
                  billingTotals.outstanding > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                }
              />
              <BillingCell
                label="Account balance"
                amount={accountBalance}
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
                  {fmtTRY(billingTotals.outstanding)}
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

          {/* Appointments */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Appointments
              </h2>
              <span className="text-xs text-muted-foreground">
                {appointments?.length ?? 0} record
                {appointments?.length !== 1 ? "s" : ""}
              </span>
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
              <span className="text-xs text-muted-foreground">
                {followups?.length ?? 0} record{followups?.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
              {!followups || followups.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                  No follow-up notes yet.
                </div>
              ) : (
                <ul className="divide-y divide-border/30">
                  {followups.map((f) => {
                    const meta = FOLLOWUP_META[f.outcome];
                    const dept = f.appointment?.departments;
                    return (
                      <li key={f.id} className="px-4 py-3 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(f.recorded_at).toLocaleString("en-GB", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </span>
                          {f.appointment?.scheduled_at && (
                            <span className="text-[11px] text-muted-foreground">
                              · session{" "}
                              {new Date(
                                f.appointment.scheduled_at,
                              ).toLocaleDateString("en-GB", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                              })}
                            </span>
                          )}
                          {dept?.name && (
                            <span
                              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                              style={{
                                backgroundColor: `color-mix(in oklab, ${dept.color} 14%, transparent)`,
                                color: dept.color,
                              }}
                            >
                              {dept.name}
                            </span>
                          )}
                        </div>
                        {f.notes && (
                          <p className="text-sm text-foreground">
                            &ldquo;{f.notes}&rdquo;
                          </p>
                        )}
                        {f.recorded_by?.full_name && (
                          <p className="text-[10px] text-muted-foreground">
                            Recorded by {f.recorded_by.full_name}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Medical notes */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Medical Notes
            </h2>
            <span className="text-xs text-muted-foreground">
              {notes?.length ?? 0} note{notes?.length !== 1 ? "s" : ""}
            </span>
          </div>

          {(isAdmin || isDoctor) && !patient.is_deleted && (
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <NoteComposer patientId={id} />
            </div>
          )}

          {!isAdmin && !isDoctor && (
            <div className="rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Medical notes are visible to admins and doctors only.
            </div>
          )}

          {(isAdmin || isDoctor) && (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <MedicalNotesList notes={(notes ?? []) as any} />
          )}
        </div>
      </div>
    </div>
  );
}

const FOLLOWUP_META: Record<
  "all_fine" | "has_problem" | "no_response",
  { label: string; className: string }
> = {
  all_fine: {
    label: "Everything is fine",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  has_problem: {
    label: "Reported a problem",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  no_response: {
    label: "No response",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
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
            timeZone: "Europe/Istanbul",
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          Dr. {a.profiles?.full_name ?? "—"}
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
  accent,
}: {
  label: string;
  amount: number;
  accent?: string;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${accent ?? ""}`}>
        {fmtTRY(amount)}
      </p>
    </div>
  );
}
