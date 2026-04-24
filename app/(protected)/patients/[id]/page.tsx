import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, ChevronLeft, Pencil, Receipt } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";
import { AppointmentPaymentRow } from "@/components/patients/appointment-payment-row";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";

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
      "*, departments(id, name, color), assigned_doctor:profiles!assigned_doctor_id(id, full_name)",
    )
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  const { data: notes } = await supabase
    .from("medical_notes")
    .select("*, profiles!doctor_id(full_name)")
    .eq("patient_id", id)
    .order("created_at", { ascending: false });

  const { data: appointments } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, secondary_payment_method, payment_note, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name)",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .order("scheduled_at", { ascending: false })
    .limit(30);

  // Aggregate billing across completed appointments
  const completed = (appointments ?? []).filter((a) => a.status === "completed");
  const billingTotals = completed.reduce(
    (acc, a) => {
      acc.billed += a.total_amount ?? 0;
      acc.collected +=
        (a.paid_amount ?? 0) +
        (a.insurance_amount ?? 0) +
        (a.secondary_amount ?? 0) +
        (a.deposit_amount ?? 0);
      acc.outstanding += a.outstanding_amount ?? 0;
      return acc;
    },
    { billed: 0, collected: 0, outstanding: 0 },
  );

  const isAdmin = user.role === "admin";
  const canEdit = user.role !== "manager" && !patient.is_deleted;
  const age =
    new Date().getFullYear() - new Date(patient.date_of_birth).getFullYear();

  const doctorName = patient.assigned_doctor?.full_name ?? null;
  const deptInfo = patient.departments;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
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
        <div className="space-y-1">
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
            {new Date(patient.date_of_birth).toLocaleDateString("tr-TR")}
            {patient.blood_type && ` · ${patient.blood_type}`}
          </p>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Link href={`/patients/${id}/edit`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
            {isAdmin && !patient.is_deleted && (
              <DeletePatientButton patientId={id} />
            )}
          </div>
        )}
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
                    `Dr. ${doctorName}`
                  ) : (
                    <span className="text-muted-foreground/60">Unassigned</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Registered</dt>
                <dd className="font-medium">
                  {new Date(patient.created_at).toLocaleDateString("tr-TR")}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Right column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Billing summary strip */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Receipt className="h-4 w-4" />
                Billing
              </h2>
              {canEdit && billingTotals.outstanding > 0 && (
                <SettleOutstandingDialog
                  patientId={id}
                  outstanding={billingTotals.outstanding}
                  patientName={patient.full_name}
                />
              )}
            </div>
            <div className="grid grid-cols-3 gap-px rounded-xl border border-border/50 bg-border/40 overflow-hidden">
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
          </div>

          {/* Appointments — click completed rows to see payment breakdown */}
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
                  {appointments.map((a) => (
                    <AppointmentPaymentRow
                      key={a.id}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      a={a as any}
                    />
                  ))}
                </div>
              ) : (
                <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                  No appointments yet.
                </div>
              )}
            </div>
            {completed.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Tip: click a completed appointment to see its payment breakdown.
              </p>
            )}
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

          {isAdmin && !patient.is_deleted && (
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <NoteComposer patientId={id} />
            </div>
          )}

          {!isAdmin && (
            <div className="rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Medical notes are visible to admins only.
            </div>
          )}

          {isAdmin && (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <MedicalNotesList notes={(notes ?? []) as any} />
          )}
        </div>
      </div>
    </div>
  );
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
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
