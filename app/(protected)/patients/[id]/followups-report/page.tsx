import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/patients/print-button";

export const metadata: Metadata = { title: "Follow-up Report" };

interface PageProps {
  params: Promise<{ id: string }>;
}

const OUTCOME_LABELS: Record<string, string> = {
  all_fine: "All Fine",
  has_problem: "Has Problem",
  no_response: "No Response",
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function FollowupsReportPage({ params }: PageProps) {
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

  const { data: followups } = await supabase
    .from("follow_ups")
    .select(
      "id, recorded_at, outcome, notes, appointment_id, recorded_by:profiles!recorded_by(full_name), appointment:appointments!appointment_id(scheduled_at, departments(name, color), profiles!doctor_id(full_name))",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .order("recorded_at", { ascending: true });

  const rows = (followups ?? []) as {
    id: string;
    recorded_at: string;
    outcome: string;
    notes: string | null;
    appointment_id: string | null;
    recorded_by: { full_name: string } | null;
    appointment: {
      scheduled_at: string;
      departments: { name: string; color: string } | null;
      profiles: { full_name: string } | null;
    } | null;
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
            <h1 className="text-2xl font-semibold tracking-tight">Follow-up Report</h1>
          </div>
          <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground text-base">{patient.full_name}</p>
            {patient.file_number && (
              <p>
                File: <span className="font-mono">{patient.file_number}</span>
              </p>
            )}
            {patient.phone && <p>Phone: {patient.phone}</p>}
            <p>Generated: {generatedAt}</p>
            <p>{rows.length} follow-up{rows.length !== 1 ? "s" : ""} on record</p>
          </div>
        </div>
        <PrintButton />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
          No follow-up notes on record for this patient.
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recorded
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Outcome
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recorded By
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Department
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Related Appointment
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Note
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => {
                const dept = f.appointment?.departments;
                return (
                  <tr
                    key={f.id}
                    className={`border-b border-border/30 last:border-0 ${
                      i % 2 === 1 ? "bg-muted/20" : ""
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-xs">
                      {fmtDateTime(f.recorded_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-medium text-xs">
                        {OUTCOME_LABELS[f.outcome] ?? f.outcome}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {f.recorded_by?.full_name ?? "—"}
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
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-xs">
                      {f.appointment?.scheduled_at
                        ? fmtDate(f.appointment.scheduled_at)
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-3 max-w-[320px]">
                      {f.notes ? (
                        <span className="text-xs">{f.notes}</span>
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
