"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

const BUCKET = "patient-assets";
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 10 * 60;
const DOCUMENT_FIELD = "file";

const CATEGORIES = ["national_id", "insurance", "other"] as const;
const SINGLE_SLOT_CATEGORIES = new Set<PatientDocumentCategory>([
  "national_id",
  "insurance",
]);

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type PatientDocumentCategory =
  Database["public"]["Enums"]["patient_document_category"];

type PatientDocumentRow =
  Database["public"]["Tables"]["patient_documents"]["Row"] & {
    uploaded_by_profile?: { full_name: string | null } | null;
  };

type ActivePatient = {
  id: string;
};

export type PatientDocumentItem = {
  id: string;
  category: PatientDocumentCategory;
  label: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedByName: string | null;
};

export type PatientDocumentsData = {
  nationalId: PatientDocumentItem | null;
  insurance: PatientDocumentItem | null;
  other: PatientDocumentItem[];
};

export type PatientDocumentResult<T = unknown> = {
  error?: string;
  data?: T;
  ok?: boolean;
};

function isPatientDocumentCategory(
  value: unknown,
): value is PatientDocumentCategory {
  return typeof value === "string" && CATEGORIES.includes(value as never);
}

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
  const normalized = safe || "document";
  return normalized.slice(0, 255);
}

function documentPath(
  clinicId: string,
  patientId: string,
  category: PatientDocumentCategory,
  documentId: string,
  ext: string,
) {
  return `documents/${clinicId}/${patientId}/${category}/${documentId}.${ext}`;
}

function documentPathPattern(
  clinicId: string,
  patientId: string,
  category: PatientDocumentCategory,
  documentId: string,
) {
  return new RegExp(
    `^documents/${clinicId}/${patientId}/${category}/${documentId}\\.[a-z0-9]+$`,
    "i",
  );
}

function isValidDocumentPath(
  path: string,
  clinicId: string,
  patientId: string,
  category: PatientDocumentCategory,
  documentId: string,
) {
  return documentPathPattern(clinicId, patientId, category, documentId).test(path);
}

function toDocumentItem(row: PatientDocumentRow): PatientDocumentItem {
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    uploadedByName: row.uploaded_by_profile?.full_name ?? null,
  };
}

function groupDocuments(rows: PatientDocumentRow[]): PatientDocumentsData {
  const grouped: PatientDocumentsData = {
    nationalId: null,
    insurance: null,
    other: [],
  };

  for (const row of rows) {
    const item = toDocumentItem(row);
    if (row.category === "national_id") grouped.nationalId = item;
    else if (row.category === "insurance") grouped.insurance = item;
    else grouped.other.push(item);
  }

  return grouped;
}

function duplicateSingleSlotMessage(category: PatientDocumentCategory) {
  if (category === "national_id") {
    return "A national ID document already exists. Delete it before uploading a replacement.";
  }
  if (category === "insurance") {
    return "An insurance document already exists. Delete it before uploading a replacement.";
  }
  return "A document already exists. Delete it before uploading a replacement.";
}

async function getPatientForDocuments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  patientId: string,
  clinicId: string,
): Promise<ActivePatient | null> {
  const { data, error } = await supabase
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .eq("clinic_id", clinicId)
    .eq("is_deleted", false)
    .single();

  if (error || !data) return null;
  return data;
}

function validateFile(formData: FormData) {
  const file = formData.get(DOCUMENT_FIELD);
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Pick a document to upload." };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { error: "Document must be a PDF, JPEG, PNG, or WebP file." };
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { error: "Document must be under 10 MB." };
  }

  const ext = extensionForMime(file.type);
  if (!ext) return { error: "Unsupported document file type." };

  return {
    file,
    ext,
    fileName: sanitizeDisplayName(file.name),
  };
}

async function getActiveDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  patientId: string,
  documentId: string,
  clinicId: string,
) {
  const { data, error } = await supabase
    .from("patient_documents")
    .select(
      "id, clinic_id, patient_id, category, label, file_name, mime_type, size_bytes, storage_path, uploaded_by, deleted_at, created_at, updated_at, uploaded_by_profile:profiles!patient_documents_uploaded_by_fkey(full_name)",
    )
    .eq("id", documentId)
    .eq("patient_id", patientId)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .single();

  if (error || !data) return null;
  return data as PatientDocumentRow;
}

async function listActiveDocuments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  patientId: string,
  clinicId: string,
) {
  const { data, error } = await supabase
    .from("patient_documents")
    .select(
      "id, clinic_id, patient_id, category, label, file_name, mime_type, size_bytes, storage_path, uploaded_by, deleted_at, created_at, updated_at, uploaded_by_profile:profiles!patient_documents_uploaded_by_fkey(full_name)",
    )
    .eq("patient_id", patientId)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) return { error };
  return { rows: (data ?? []) as PatientDocumentRow[] };
}

export async function listPatientDocuments(
  patientId: string,
): Promise<PatientDocumentResult<PatientDocumentsData>> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const patient = await getPatientForDocuments(supabase, patientId, user.clinicId);
  if (!patient) return { error: "Patient not found." };

  const result = await listActiveDocuments(supabase, patientId, user.clinicId);
  if (result.error) return { error: "Failed to load patient documents." };

  return { data: groupDocuments(result.rows) };
}

export async function uploadPatientDocument(
  patientId: string,
  category: PatientDocumentCategory,
  formData: FormData,
): Promise<PatientDocumentResult<PatientDocumentsData>> {
  const user = await requireRole(["admin", "receptionist"]);
  if (!isPatientDocumentCategory(category)) {
    return { error: "Select a valid document category." };
  }

  const supabase = await createClient();
  const patient = await getPatientForDocuments(supabase, patientId, user.clinicId);
  if (!patient) return { error: "Patient not found." };

  const fileResult = validateFile(formData);
  if ("error" in fileResult) return { error: fileResult.error };

  const documentId = randomUUID();
  const path = documentPath(
    user.clinicId,
    patientId,
    category,
    documentId,
    fileResult.ext,
  );

  const { error: insertError } = await supabase.from("patient_documents").insert({
    id: documentId,
    clinic_id: user.clinicId,
    patient_id: patientId,
    category,
    file_name: fileResult.fileName,
    mime_type: fileResult.file.type,
    size_bytes: fileResult.file.size,
    storage_path: path,
    uploaded_by: user.id,
  });

  if (insertError) {
    if (insertError.code === "23505" && SINGLE_SLOT_CATEGORIES.has(category)) {
      return { error: duplicateSingleSlotMessage(category) };
    }
    return { error: "Failed to create patient document record." };
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
      .from("patient_documents")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("patient_id", patientId)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null);
    return { error: uploadError.message || "Failed to upload document." };
  }

  if (SINGLE_SLOT_CATEGORIES.has(category)) {
    await supabase
      .from("patient_documents")
      .update({ deleted_at: new Date().toISOString() })
      .eq("patient_id", patientId)
      .eq("clinic_id", user.clinicId)
      .eq("category", category)
      .neq("id", documentId)
      .is("deleted_at", null);
  }

  revalidatePath(`/patients/${patientId}`);

  const result = await listActiveDocuments(supabase, patientId, user.clinicId);
  if (result.error) return { ok: true };

  return { ok: true, data: groupDocuments(result.rows) };
}

export async function deletePatientDocument(
  patientId: string,
  documentId: string,
): Promise<PatientDocumentResult<PatientDocumentsData>> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const patient = await getPatientForDocuments(supabase, patientId, user.clinicId);
  if (!patient) return { error: "Patient not found." };

  const document = await getActiveDocument(
    supabase,
    patientId,
    documentId,
    user.clinicId,
  );
  if (!document) {
    const result = await listActiveDocuments(supabase, patientId, user.clinicId);
    if (result.error) return { ok: true };
    return { ok: true, data: groupDocuments(result.rows) };
  }

  if (
    !isValidDocumentPath(
      document.storage_path,
      user.clinicId,
      patientId,
      document.category,
      document.id,
    )
  ) {
    return { error: "Stored document path is not valid for this patient." };
  }

  const { error: updateError } = await supabase
    .from("patient_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("patient_id", patientId)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null);

  if (updateError) return { error: "Failed to delete document record." };

  revalidatePath(`/patients/${patientId}`);

  const result = await listActiveDocuments(supabase, patientId, user.clinicId);
  if (result.error) return { ok: true };

  return { ok: true, data: groupDocuments(result.rows) };
}

export async function restorePatientDocument(
  patientId: string,
  documentId: string,
): Promise<PatientDocumentResult<PatientDocumentsData>> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const patient = await getPatientForDocuments(supabase, patientId, user.clinicId);
  if (!patient) return { error: "Patient not found." };

  const { error } = await supabase
    .from("patient_documents")
    .update({ deleted_at: null })
    .eq("id", documentId)
    .eq("patient_id", patientId)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: "Failed to restore document." };

  revalidatePath(`/patients/${patientId}`);
  const result = await listActiveDocuments(supabase, patientId, user.clinicId);
  if (result.error) return { ok: true };
  return { ok: true, data: groupDocuments(result.rows) };
}

export async function getPatientDocumentSignedUrl(
  patientId: string,
  documentId: string,
): Promise<PatientDocumentResult<{ url: string }>> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const patient = await getPatientForDocuments(supabase, patientId, user.clinicId);
  if (!patient) return { error: "Patient not found." };

  const document = await getActiveDocument(
    supabase,
    patientId,
    documentId,
    user.clinicId,
  );
  if (!document) return { error: "Document not found." };

  if (
    !isValidDocumentPath(
      document.storage_path,
      user.clinicId,
      patientId,
      document.category,
      document.id,
    )
  ) {
    return { error: "Stored document path is not valid for this patient." };
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    return { error: "Failed to create document link." };
  }

  return { data: { url: data.signedUrl } };
}
