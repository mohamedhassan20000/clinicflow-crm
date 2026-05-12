import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { formatDoctorName } from "@/lib/format-doctor";
import { PrintButton } from "@/components/patients/print-button";

export const metadata: Metadata = { title: "Medical Notes Report" };

interface PageProps {
  params: Promise<{ id: string }>;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function MedicalNotesReportPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const isAdmin = user.role === "admin";

  // Medical notes are restricted to admins and doctors only
  if (!isAdmin && !isDoctor) notFound();

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

  const { data: notes } = await supabase
    .from("medical_notes")
    .select(
      "id, note, created_at, profiles!doctor_id(full_name)",
    )
    .eq("patient_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const noteRows = (notes ?? []) as {
    id: string;
    note: string;
    created_at: string;
    profiles: { full_name: string } | null;
  }[];

  // Fetch attachment counts per note
  const attachmentCounts = new Map<string, number>();
  if (noteRows.length > 0) {
    const { data: attachments } = await supabase
      .from("medical_note_attachments")
      .select("note_id")
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", id)
      .in(
        "note_id",
        noteRows.map((n) => n.id),
      )
      .is("deleted_at", null);

    for (const a of attachments ?? []) {
      attachmentCounts.set(a.note_id, (attachmentCounts.get(a.note_id) ?? 0) + 1);
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
            <h1 className="text-2xl font-semibold tracking-tight">Medical Notes Report</h1>
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
            <p>{noteRows.length} note{noteRows.length !== 1 ? "s" : ""} on record</p>
          </div>
        </div>
        <PrintButton />
      </div>

      {noteRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
          No medical notes on record for this patient.
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
                  Created By
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Note
                </th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Attachments
                </th>
              </tr>
            </thead>
            <tbody>
              {noteRows.map((n, i) => {
                const count = attachmentCounts.get(n.id) ?? 0;
                return (
                  <tr
                    key={n.id}
                    className={`border-b border-border/30 last:border-0 align-top ${
                      i % 2 === 1 ? "bg-muted/20" : ""
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-xs">
                      {fmtDateTime(n.created_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDoctorName(n.profiles?.full_name)}
                    </td>
                    <td className="px-4 py-3 max-w-[420px]">
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">{n.note}</p>
                    </td>
                    <td className="px-4 py-3 text-center tabular-nums">
                      {count > 0 ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          {count}
                        </span>
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
