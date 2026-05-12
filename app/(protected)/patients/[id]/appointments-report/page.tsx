import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/appointments/status-badge";
import { formatDoctorName } from "@/lib/format-doctor";
import { PrintButton } from "@/components/patients/print-button";
import { ReportDateFilter } from "@/components/patients/report-date-filter";
import { AppointmentsReportList } from "@/components/patients/appointments-report-list";
import type {
  AppointmentPaymentRowData,
  SettlementEntry,
} from "@/components/patients/appointment-payment-row";

export const metadata: Metadata = { title: "Appointments Report" };

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function AppointmentsReportPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { from, to } = await searchParams;
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, full_name, file_number, phone, is_deleted, assigned_doctor_id, department_id",
    )
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  if (isDoctor) {
    const canAccess =
      patient.assigned_doctor_id === user.id ||
      (!!user.departmentId && patient.department_id === user.departmentId);
    if (!canAccess) notFound();
  }

  // Doctors see a simplified view without billing; non-doctors see full payment data
  let apptQuery = supabase
    .from("appointments")
    .select(
      isDoctor
        ? "id, scheduled_at, status, cancellation_reason, cancelled_at, profiles!doctor_id(full_name), departments(name, color)"
        : "id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, secondary_payment_method, payment_note, cancellation_reason, cancelled_at, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name), appointment_services(id, name, price, quantity)",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .order("scheduled_at", { ascending: true });

  if (from) apptQuery = apptQuery.gte("scheduled_at", `${from}T00:00:00.000Z`);
  if (to) apptQuery = apptQuery.lte("scheduled_at", `${to}T23:59:59.999Z`);

  const { data: appointments } = await apptQuery;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appts = (appointments ?? []) as any[];

  // Fetch settlements for non-doctors
  const settlementsByAppt: Record<string, SettlementEntry[]> = {};
  if (!isDoctor) {
    const { data: settlements } = await supabase
      .from("outstanding_settlements")
      .select("id, appointment_id, settled_at, amount, payment_method, note")
      .eq("patient_id", id)
      .eq("clinic_id", user.clinicId)
      .order("settled_at", { ascending: true });

    for (const s of settlements ?? []) {
      if (!s.appointment_id) continue;
      settlementsByAppt[s.appointment_id] = [
        ...(settlementsByAppt[s.appointment_id] ?? []),
        {
          id: s.id,
          settled_at: s.settled_at,
          amount: Number(s.amount ?? 0),
          payment_method: s.payment_method,
          note: s.note,
        },
      ];
    }
  }

  const generatedAt = new Date().toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 print:hidden text-sm text-muted-foreground">
        <Link
          href={`/patients/${id}`}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to patient
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground print:hidden" aria-hidden />
            <h1 className="text-2xl font-semibold tracking-tight">
              Appointments Report
            </h1>
          </div>
          <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground text-base">
              {patient.full_name}
            </p>
            {patient.file_number && (
              <p>
                File: <span className="font-mono">{patient.file_number}</span>
              </p>
            )}
            {patient.phone && <p>Phone: {patient.phone}</p>}
            <p>Generated: {generatedAt}</p>
            <p>
              {appts.length} appointment{appts.length !== 1 ? "s" : ""}
              {(from || to) && " (filtered)"}
            </p>
          </div>
        </div>
        <PrintButton />
      </div>

      <ReportDateFilter from={from} to={to} />

      {isDoctor ? (
        <DoctorApptList appts={appts} />
      ) : (
        <AppointmentsReportList
          appointments={appts as AppointmentPaymentRowData[]}
          settlementsByAppt={settlementsByAppt}
        />
      )}
    </div>
  );
}

function DoctorApptList({
  appts,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appts: any[];
}) {
  if (appts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
        No appointments match the selected date range.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      {appts.map(
        (a: {
          id: string;
          scheduled_at: string;
          status: string;
          cancellation_reason?: string | null;
          profiles?: { full_name: string } | null;
          departments?: { name: string; color: string } | null;
        }) => {
          const dept = a.departments;
          const deptColor = dept?.color ?? "#64748b";
          return (
            <div
              key={a.id}
              className="flex flex-wrap items-center gap-3 border-b border-border/30 last:border-0 px-5 py-3.5"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium">
                  {new Date(a.scheduled_at).toLocaleDateString("en-GB", {
                    timeZone: "Europe/Istanbul",
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                  <span className="ml-1 font-normal text-muted-foreground">
                    {new Date(a.scheduled_at).toLocaleTimeString("en-GB", {
                      timeZone: "Europe/Istanbul",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatDoctorName(a.profiles?.full_name)}</span>
                  {dept && (
                    <span
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={{
                        backgroundColor: `color-mix(in oklab, ${deptColor} 14%, transparent)`,
                        color: deptColor,
                      }}
                    >
                      {dept.name}
                    </span>
                  )}
                </div>
              </div>
              <StatusBadge
                status={
                  a.status as Parameters<typeof StatusBadge>[0]["status"]
                }
              />
            </div>
          );
        },
      )}
    </div>
  );
}
