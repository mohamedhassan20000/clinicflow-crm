import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  MedicalNotesList,
  type MedicalNoteWithAttachments,
} from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { PrintButton } from "@/components/patients/print-button";
import { PrintHeader } from "@/components/shared/print-header";
import { ReportDateFilter } from "@/components/patients/report-date-filter";
import type { MedicalNoteAttachmentItem } from "@/actions/medical-note-attachments";

export const metadata: Metadata = { title: "Medical Notes Report" };

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function MedicalNotesReportPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { from, to } = await searchParams;
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const isAdmin = user.role === "admin";

  if (!isAdmin && !isDoctor) notFound();

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

  let noteQuery = supabase
    .from("medical_notes")
    .select(
      "id, patient_id, doctor_id, note, created_at, created_by, deleted_at, profiles!doctor_id(full_name)",
    )
    .eq("patient_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (from) noteQuery = noteQuery.gte("created_at", `${from}T00:00:00.000Z`);
  if (to) noteQuery = noteQuery.lte("created_at", `${to}T23:59:59.999Z`);

  const { data: notes } = await noteQuery;
  const noteRows = (notes ?? []) as MedicalNoteWithAttachments[];
  const noteIds = noteRows.map((n) => n.id);

  const attachmentsByNote = new Map<string, MedicalNoteAttachmentItem[]>();
  if (noteIds.length > 0) {
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

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, address, phone, logo_url")
    .eq("id", user.clinicId)
    .single();

  const generatedAt = new Date().toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName="Medical Notes Report"
        generatedAt={generatedAt}
      />
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
            <FileText
              className="h-5 w-5 text-muted-foreground print:hidden"
              aria-hidden
            />
            <h1 className="text-2xl font-semibold tracking-tight">
              Medical Notes Report
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
            <p>
              {notesWithAttachments.length} note
              {notesWithAttachments.length !== 1 ? "s" : ""}
              {(from || to) && " (filtered)"}
            </p>
          </div>
        </div>
        <PrintButton />
      </div>

      <ReportDateFilter from={from} to={to} />

      {!patient.is_deleted && (
        <div className="rounded-xl border border-border/50 bg-card p-4 print:hidden">
          <NoteComposer patientId={id} />
        </div>
      )}

      {/* Screen view */}
      <div className="print:hidden">
        <MedicalNotesList
          notes={notesWithAttachments}
          patientId={id}
          currentUserId={user.id}
          canManageAllAttachments={isAdmin}
        />
      </div>

      {/* Print table — same black-border style as revenue */}
      <div className="hidden print:block">
        {notesWithAttachments.length === 0 ? (
          <p className="text-sm">No medical notes.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Doctor</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {notesWithAttachments.map((note) => (
                <tr key={note.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(note.created_at).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {note.profiles?.full_name ?? "Unknown"}
                  </td>
                  <td>{note.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
