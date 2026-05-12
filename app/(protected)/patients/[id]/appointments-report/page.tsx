import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/appointments/status-badge";
import { formatDoctorName } from "@/lib/format-doctor";
import { PrintButton } from "@/components/patients/print-button";

export const metadata: Metadata = { title: "Appointments Report" };

interface PageProps {
  params: Promise<{ id: string }>;
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default async function AppointmentsReportPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select("id, full_name, file_number, phone, is_deleted, assigned_doctor_id, department_id")
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

  const { data: appointments } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, total_amount, notes, profiles!doctor_id(full_name), departments(name, color)",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .order("scheduled_at", { ascending: true });

  const appts = (appointments ?? []) as {
    id: string;
    scheduled_at: string;
    status: Parameters<typeof StatusBadge>[0]["status"];
    total_amount: number | null;
    notes: string | null;
    profiles: { full_name: string } | null;
    departments: { name: string; color: string } | null;
  }[];

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
            <h1 className="text-2xl font-semibold tracking-tight">Appointments Report</h1>
          </div>
          <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground text-base">{patient.full_name}</p>
            {patient.file_number && <p>File: <span className="font-mono">{patient.file_number}</span></p>}
            {patient.phone && <p>Phone: {patient.phone}</p>}
            <p>Generated: {generatedAt}</p>
            <p>{appts.length} appointment{appts.length !== 1 ? "s" : ""} on record</p>
          </div>
        </div>
        <PrintButton />
      </div>

      {appts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
          No appointments on record for this patient.
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Time
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Doctor
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Department
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                {!isDoctor && (
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Billed
                  </th>
                )}
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody>
              {appts.map((a, i) => {
                const dept = a.departments;
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-border/30 last:border-0 ${
                      i % 2 === 1 ? "bg-muted/20" : ""
                    }`}
                  >
                    <td className="px-4 py-3 font-medium tabular-nums whitespace-nowrap">
                      {fmtDate(a.scheduled_at)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums whitespace-nowrap">
                      {fmtTime(a.scheduled_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDoctorName(a.profiles?.full_name)}
                    </td>
                    <td className="px-4 py-3">
                      {dept ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full shrink-0 print:hidden"
                            style={{ backgroundColor: dept.color }}
                          />
                          {dept.name}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    {!isDoctor && (
                      <td className="px-4 py-3 text-right tabular-nums font-mono text-xs whitespace-nowrap">
                        {a.total_amount != null ? fmtTRY(a.total_amount) : "—"}
                      </td>
                    )}
                    <td className="px-4 py-3 max-w-[280px]">
                      {a.notes ? (
                        <span className="text-xs text-muted-foreground">{a.notes}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
