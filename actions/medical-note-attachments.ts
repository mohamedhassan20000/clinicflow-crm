"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

const BUCKET = "patient-assets";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 10 * 60;
const ATTACHMENT_FIELD = "file";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type MedicalNoteSummary = {
  id: string;
  patient_id: string;
  doctor_id: string;
  created_by: string | null;
};

type MedicalNoteAttachmentRow = {
  id: string;
  clinic_id: string;
  patient_id: string;
  note_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  uploaded_by_profile?: { full_name: string | null } | null;
};

export type MedicalNoteAttachmentItem = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedById: string | null;
  uploadedByName: string | null;
};

export type MedicalNoteAttachmentResult<T = unknown> = {
  error?: string;
  data?: T;
  ok?: boolean;
};

function extensionForMime(type: string) {
  if (type === "application/pdf") return "pdf";
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return null;
}

function sanitizeDisplayName(name: string) {
  const trimmed = name.trim().replace(/[/\\]/g, "_");
  const safe = trimmed.replace(/[^\w .()-]/g, "_").replace(/\s+/g, " ");
  const normalized = safe || "attachment";
  return normalized.slice(0, 255);
}

function attachmentPath(
  clinicId: string,
  patientId: string,
  noteId: string,
  attachmentId: string,
  ext: string,
) {
  return `medical-notes/${clinicId}/${patientId}/${noteId}/${attachmentId}.${ext}`;
}

function attachmentPathPattern(
  clinicId: string,
  patientId: string,
  noteId: string,
  attachmentId: string,
) {
  return new RegExp(
    `^medical-notes/${clinicId}/${patientId}/${noteId}/${attachmentId}\\.[a-z0-9]+$`,
    "i",
  );
}

function isValidAttachmentPath(
  path: string,
  clinicId: string,
  patientId: string,
  noteId: string,
  attachmentId: string,
) {
  return attachmentPathPattern(clinicId, patientId, noteId, attachmentId).test(
    path,
  );
}

function validateFile(formData: FormData) {
  const file = formData.get(ATTACHMENT_FIELD);
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Pick an attachment to upload." };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { error: "Attachment must be a PDF, JPEG, PNG, or WebP file." };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { error: "Attachment must be under 10 MB." };
  }

  const ext = extensionForMime(file.type);
  if (!ext) return { error: "Unsupported attachment file type." };

  return {
    file,
    ext,
    fileName: sanitizeDisplayName(file.name),
  };
}

function toAttachmentItem(
  row: MedicalNoteAttachmentRow,
): MedicalNoteAttachmentItem {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    uploadedById: row.uploaded_by,
    uploadedByName: row.uploaded_by_profile?.full_name ?? null,
  };
}

async function getAccessibleNote(
  supabase: Awaited<ReturnType<typeof createClient>>,
  noteId: string,
  patientId: string,
): Promise<MedicalNoteSummary | null> {
  const { data, error } = await supabase
    .from("medical_notes")
    .select("id, patient_id, doctor_id, created_by")
    .eq("id", noteId)
    .eq("patient_id", patientId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getActiveAttachment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  patientId: string,
  noteId: string,
  attachmentId: string,
) {
  const { data, error } = await supabase
    .from("medical_note_attachments")
    .select(
      "id, clinic_id, patient_id, note_id, file_name, mime_type, size_bytes, storage_path, uploaded_by, deleted_at, created_at, updated_at, uploaded_by_profile:profiles!medical_note_attachments_uploaded_by_fkey(full_name)",
    )
    .eq("id", attachmentId)
    .eq("clinic_id", clinicId)
    .eq("patient_id", patientId)
    .eq("note_id", noteId)
    .is("deleted_at", null)
    .single();

  if (error || !data) return null;
  return data as MedicalNoteAttachmentRow;
}

export async function listMedicalNoteAttachments(
  patientId: string,
  noteId: string,
): Promise<MedicalNoteAttachmentResult<MedicalNoteAttachmentItem[]>> {
  const user = await requireRole(["admin", "doctor"]);
  const supabase = await createClient();
  const note = await getAccessibleNote(supabase, noteId, patientId);
  if (!note) return { error: "Medical note not found." };

  const { data, error } = await supabase
    .from("medical_note_attachments")
    .select(
      "id, clinic_id, patient_id, note_id, file_name, mime_type, size_bytes, storage_path, uploaded_by, deleted_at, created_at, updated_at, uploaded_by_profile:profiles!medical_note_attachments_uploaded_by_fkey(full_name)",
    )
    .eq("clinic_id", user.clinicId)
    .eq("patient_id", patientId)
    .eq("note_id", noteId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) return { error: "Failed to load note attachments." };
  return { data: ((data ?? []) as MedicalNoteAttachmentRow[]).map(toAttachmentItem) };
}

export async function uploadMedicalNoteAttachment(
  patientId: string,
  noteId: string,
  formData: FormData,
): Promise<MedicalNoteAttachmentResult<MedicalNoteAttachmentItem[]>> {
  const user = await requireRole(["admin", "doctor"]);
  const supabase = await createClient();

  const note = await getAccessibleNote(supabase, noteId, patientId);
  if (!note) return { error: "Medical note not found." };

  const fileResult = validateFile(formData);
  if ("error" in fileResult) return { error: fileResult.error };

  const attachmentId = randomUUID();
  const path = attachmentPath(
    user.clinicId,
    patientId,
    noteId,
    attachmentId,
    fileResult.ext,
  );

  const { error: insertError } = await supabase
    .from("medical_note_attachments")
    .insert({
      id: attachmentId,
      clinic_id: user.clinicId,
      patient_id: patientId,
      note_id: note.id,
      file_name: fileResult.fileName,
      mime_type: fileResult.file.type,
      size_bytes: fileResult.file.size,
      storage_path: path,
      uploaded_by: user.id,
    });

  if (insertError) {
    return { error: "Failed to create attachment record." };
  }

  const bytes = new Uint8Array(await fileResult.file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: fileResult.file.type,
      upsert: false,
    });

  if (uploadError) {
    await supabase
      .from("medical_note_attachments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", attachmentId)
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", patientId)
      .eq("note_id", noteId)
      .is("deleted_at", null);
    return { error: uploadError.message || "Failed to upload attachment." };
  }

  revalidatePath(`/patients/${patientId}`);
  return listMedicalNoteAttachments(patientId, noteId);
}

export async function getMedicalNoteAttachmentSignedUrl(
  patientId: string,
  noteId: string,
  attachmentId: string,
): Promise<MedicalNoteAttachmentResult<{ url: string }>> {
  const user = await requireRole(["admin", "doctor"]);
  const supabase = await createClient();

  const note = await getAccessibleNote(supabase, noteId, patientId);
  if (!note) return { error: "Medical note not found." };

  const attachment = await getActiveAttachment(
    supabase,
    user.clinicId,
    patientId,
    noteId,
    attachmentId,
  );
  if (!attachment) return { error: "Attachment not found." };

  if (
    !isValidAttachmentPath(
      attachment.storage_path,
      user.clinicId,
      patientId,
      noteId,
      attachment.id,
    )
  ) {
    return { error: "Stored attachment path is not valid for this note." };
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(attachment.storage_path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    return { error: "Failed to create attachment link." };
  }

  return { data: { url: data.signedUrl } };
}

export async function deleteMedicalNoteAttachment(
  patientId: string,
  noteId: string,
  attachmentId: string,
): Promise<MedicalNoteAttachmentResult<MedicalNoteAttachmentItem[]>> {
  const user = await requireRole(["admin", "doctor"]);
  const supabase = await createClient();

  const note = await getAccessibleNote(supabase, noteId, patientId);
  if (!note) return { error: "Medical note not found." };

  const attachment = await getActiveAttachment(
    supabase,
    user.clinicId,
    patientId,
    noteId,
    attachmentId,
  );
  if (!attachment) return listMedicalNoteAttachments(patientId, noteId);

  if (
    !isValidAttachmentPath(
      attachment.storage_path,
      user.clinicId,
      patientId,
      noteId,
      attachment.id,
    )
  ) {
    return { error: "Stored attachment path is not valid for this note." };
  }

  const { error: updateError } = await supabase
    .from("medical_note_attachments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", attachmentId)
    .eq("clinic_id", user.clinicId)
    .eq("patient_id", patientId)
    .eq("note_id", noteId)
    .is("deleted_at", null);

  if (updateError) return { error: "Failed to delete attachment record." };

  revalidatePath(`/patients/${patientId}`);
  return listMedicalNoteAttachments(patientId, noteId);
}

export async function restoreMedicalNoteAttachment(
  patientId: string,
  noteId: string,
  attachmentId: string,
): Promise<MedicalNoteAttachmentResult<MedicalNoteAttachmentItem[]>> {
  const user = await requireRole(["admin", "doctor"]);
  const supabase = await createClient();

  const note = await getAccessibleNote(supabase, noteId, patientId);
  if (!note) return { error: "Medical note not found." };

  const { error } = await supabase
    .from("medical_note_attachments")
    .update({ deleted_at: null })
    .eq("id", attachmentId)
    .eq("clinic_id", user.clinicId)
    .eq("patient_id", patientId)
    .eq("note_id", noteId)
    .not("deleted_at", "is", null);

  if (error) return { error: "Failed to restore attachment." };

  revalidatePath(`/patients/${patientId}`);
  return listMedicalNoteAttachments(patientId, noteId);
}
