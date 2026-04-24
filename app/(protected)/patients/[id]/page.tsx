import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, Banknote, ChevronLeft, CreditCard, Landmark, Pencil, Receipt, ShieldCheck, Wallet } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";

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
    .select("*")
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
      "id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, outstanding_amount, secondary_payment_method, payment_note, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name)",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .order("scheduled_at", { ascending: false })
    .limit(20);

  // Aggregate billing across this patient's completed appointments
  const completed = (appointments ?? []).filter((a) => a.status === "completed");
  const billingTotals = completed.reduce(
    (acc, a) => {
      acc.billed += a.total_amount ?? 0;
      acc.collected +=
        (a.paid_amount ?? 0) +
        (a.insurance_amount ?? 0) +
        (a.secondary_amount ?? 0);
      acc.outstanding += a.outstanding_amount ?? 0;
      return acc;
    },
    { billed: 0, collected: 0, outstanding: 0 },
  );

  const isAdmin = user.role === "admin";
  const canEdit = user.role !== "manager" && !patient.is_deleted;
  const age = new Date().getFullYear() - new Date(patient.date_of_birth).getFullYear();

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
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {patient.full_name}
            </h1>
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
              Contact
            </h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Phone</dt>
                <dd className="font-medium">{patient.phone}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="font-medium break-all">{patient.email}</dd>
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
          {/* Billing summary */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Receipt className="h-4 w-4" />
                Payment history
              </h2>
              <span className="text-xs text-muted-foreground">
                {completed.length} paid visit{completed.length !== 1 ? "s" : ""}
              </span>
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
                accent={billingTotals.outstanding > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
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

            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              {completed.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                  No payments recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {completed.map((a) => (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    <PaymentRow key={a.id} a={a as any} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recent appointments */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Recent Appointments
              </h2>
              <span className="text-xs text-muted-foreground">
                {appointments?.length ?? 0} record
                {appointments?.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              {appointments && appointments.length > 0 ? (
                <div className="divide-y divide-border/50">
                  {appointments.map((a) => (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    <AppointmentRow key={a.id} a={a as any} />
                  ))}
                </div>
              ) : (
                <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                  No appointments yet.
                </div>
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

const PAYMENT_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  cash: { label: "Cash", icon: Banknote },
  credit_card: { label: "Credit card", icon: CreditCard },
  paypal: { label: "PayPal", icon: Wallet },
  bank_transfer: { label: "Bank transfer", icon: Landmark },
  insurance: { label: "Insurance", icon: ShieldCheck },
};

const STATUS_BADGE: Record<string, string> = {
  scheduled: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  confirmed: "bg-primary/10 text-primary border-primary/20",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20",
  no_show: "bg-muted text-muted-foreground border-border",
};

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

interface PaymentRowData {
  id: string;
  scheduled_at: string;
  paid_at: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  insurance_amount: number | null;
  secondary_amount: number | null;
  outstanding_amount: number | null;
  payment_method: string | null;
  secondary_payment_method: string | null;
  payment_note: string | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
  insurance_providers: { name: string } | null;
}

function PaymentRow({ a }: { a: PaymentRowData }) {
  const primary = a.payment_method ? PAYMENT_META[a.payment_method] : null;
  const secondary = a.secondary_payment_method
    ? PAYMENT_META[a.secondary_payment_method]
    : null;
  const PrimaryIcon = primary?.icon;
  const SecondaryIcon = secondary?.icon;
  const deptColor = a.departments?.color ?? "#64748b";
  const outstanding = a.outstanding_amount ?? 0;
  const paidAt = a.paid_at ? new Date(a.paid_at) : new Date(a.scheduled_at);

  return (
    <div className="px-5 py-4 space-y-2 hover:bg-muted/20 transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {paidAt.toLocaleDateString("tr-TR", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            <span className="text-muted-foreground font-normal">
              {" · "}
              {paidAt.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Dr. {a.profiles?.full_name ?? "—"}
            {a.departments?.name && (
              <span
                className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  backgroundColor: `color-mix(in oklab, ${deptColor} 14%, transparent)`,
                  color: deptColor,
                }}
              >
                {a.departments.name}
              </span>
            )}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Total
          </p>
          <p className="text-base font-semibold tabular-nums">
            {fmtTRY(a.total_amount ?? 0)}
          </p>
        </div>
      </div>

      {/* Payment breakdown pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {primary && PrimaryIcon && (a.paid_amount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5">
            <PrimaryIcon className="h-3 w-3" />
            {primary.label}
            <span className="tabular-nums font-medium">
              {fmtTRY(a.paid_amount ?? 0)}
            </span>
          </span>
        )}
        {secondary && SecondaryIcon && (a.secondary_amount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-0.5 text-cyan-700 dark:text-cyan-400">
            <SecondaryIcon className="h-3 w-3" />
            {secondary.label}
            <span className="tabular-nums font-medium">
              {fmtTRY(a.secondary_amount ?? 0)}
            </span>
          </span>
        )}
        {(a.insurance_amount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/5 px-2 py-0.5 text-sky-700 dark:text-sky-400">
            <ShieldCheck className="h-3 w-3" />
            {a.insurance_providers?.name ?? "Insurance"}
            <span className="tabular-nums font-medium">
              {fmtTRY(a.insurance_amount ?? 0)}
            </span>
          </span>
        )}
        {outstanding > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-3 w-3" />
            Outstanding
            <span className="tabular-nums font-semibold">
              {fmtTRY(outstanding)}
            </span>
          </span>
        )}
      </div>

      {a.payment_note && (
        <p className="text-xs text-muted-foreground italic">
          “{a.payment_note}”
        </p>
      )}
    </div>
  );
}

interface AppointmentRowData {
  id: string;
  scheduled_at: string;
  status: string;
  payment_method: string | null;
  paid_at: string | null;
  profiles: { full_name: string } | null;
}

function AppointmentRow({ a }: { a: AppointmentRowData }) {
  const dt = new Date(a.scheduled_at);
  const payment = a.payment_method ? PAYMENT_META[a.payment_method] : null;
  const PaymentIcon = payment?.icon;

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-muted/30 transition-colors">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">
          {dt.toLocaleDateString("tr-TR", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
          <span className="text-muted-foreground font-normal">
            {" · "}
            {dt.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {a.profiles?.full_name ?? "Unassigned"}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {payment && PaymentIcon && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground">
            <PaymentIcon className="h-3 w-3" />
            {payment.label}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize ${
            STATUS_BADGE[a.status] ?? STATUS_BADGE.scheduled
          }`}
        >
          {a.status.replace("_", " ")}
        </span>
      </div>
    </div>
  );
}
