import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  MedicalNotesList,
  type MedicalNoteWithAttachments,
} from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { PrintHeader } from "@/components/shared/print-header";
import { PatientReportHeader } from "@/components/patients/patient-report-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import { ReportDateFilter } from "@/components/patients/report-date-filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MedicalNoteAttachmentItem } from "@/actions/medical-note-attachments";
import { getTranslations } from "next-intl/server";
import { clinicLocaleFromRow, formatClinicDate } from "@/lib/datetime";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataMedicalNotesReport") };
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; returnTo?: string }>;
}

export default async function MedicalNotesReportPage({
  params,
  searchParams,
}: PageProps) {
  const t = await getTranslations("protected");
  const { id } = await params;
  const { from, to, returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientHref = resolveReturnTo(returnTo, patientPath, [patientPath]);
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const isAdmin = user.role === "admin";
  const isReceptionist = user.role === "receptionist";
  const canManageMedicalNotes = isAdmin || isDoctor;
  const canViewMedicalNotes = canManageMedicalNotes || isReceptionist;

  if (!canViewMedicalNotes) notFound();

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
    .select("name, address, phone, logo_url, timezone, locale, digits")
    .eq("id", user.clinicId)
    .single();
  const clinicLocale = clinicLocaleFromRow(clinic);

  const generatedAt = formatClinicDate(new Date(), clinicLocale, {
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
        documentName={t("medicalNotesReport")}
        generatedAt={generatedAt}
      />
      <PatientReportHeader
        patientHref={patientHref}
        patientName={patient.full_name}
        fileNumber={patient.file_number}
        phone={patient.phone}
        title={t("medicalNotesReport")}
        countLabel={`${notesWithAttachments.length} note${notesWithAttachments.length !== 1 ? "s" : ""}${from || to ? t("filtered") : ""}`}
      />

      <ReportDateFilter from={from} to={to} />

      {canManageMedicalNotes && !patient.is_deleted && (
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
          canMutateNotes={canManageMedicalNotes}
          canUploadAttachments={canManageMedicalNotes}
        />
      </div>

      {/* Print table — same black-border style as revenue */}
      <div className="hidden print:block">
        {notesWithAttachments.length === 0 ? (
          <p className="text-sm">{t("noMedicalNotes")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("date")}</TableHead>
                <TableHead>{t("doctor")}</TableHead>
                <TableHead>{t("note")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notesWithAttachments.map((note) => (
                <TableRow key={note.id}>
                  <TableCell style={{ whiteSpace: "nowrap" }}>
                    {formatClinicDate(note.created_at, clinicLocale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell style={{ whiteSpace: "nowrap" }}>
                    {note.profiles?.full_name ?? t("unknown")}
                  </TableCell>
                  <TableCell>{note.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
