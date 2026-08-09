import "server-only";

import sharp from "sharp";
import { z } from "zod";
import { inlineClinicLogo } from "@/lib/documents/assets";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export const P75_ROSTER_PROFILE_DOCUMENT_CODES = [
  "PATIENT_LIST_REPORT", "PATIENT_FILE", "SYSTEM_MEMBERS_REPORT", "STAFF_FILE",
] as const;
export type P75RosterProfileDocumentCode = typeof P75_ROSTER_PROFILE_DOCUMENT_CODES[number];

const documentTypeSchema = z.enum(P75_ROSTER_PROFILE_DOCUMENT_CODES);
export const rosterProfileDocumentParamsSchema = z.object({
  documentType: documentTypeSchema,
  patientId: z.string().uuid().nullable().optional(),
  staffId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  doctorId: z.string().uuid().nullable().optional(),
  role: z.enum(["admin", "manager", "doctor", "receptionist", "assistant"]).nullable().optional(),
  search: z.string().trim().max(100).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.documentType === "PATIENT_FILE" && !value.patientId) {
    ctx.addIssue({ code: "custom", path: ["patientId"], message: "Patient is required" });
  }
  if (value.documentType === "STAFF_FILE" && !value.staffId) {
    ctx.addIssue({ code: "custom", path: ["staffId"], message: "Staff member is required" });
  }
});

export const MAX_MERGED_ATTACHMENTS = 10;
export const MAX_MERGED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MERGED_PDF_PAGES = 100;
export const MERGEABLE_ATTACHMENT_MIME_TYPES = [
  "application/pdf", "image/jpeg", "image/png", "image/webp",
] as const;
const mergeableMimeSchema = z.enum(MERGEABLE_ATTACHMENT_MIME_TYPES);
const MAX_PROFILE_IMAGE_BYTES = 6 * 1024 * 1024;

const brandingSchema = z.object({
  name: z.string(), logoSrc: z.string().nullable(), address: z.string().nullable(),
  phone: z.string().nullable(), email: z.string().nullable(), website: z.string().nullable(),
  licenseNo: z.string().nullable(), taxId: z.string().nullable(), footerText: z.string().nullable(),
});
const settingsSchema = z.object({
  watermark: z.string().nullable(), qrEnabled: z.boolean(), numberingPrefix: z.string(),
  numberingYearlyReset: z.boolean(), sequencePadding: z.number().int().min(1).max(12),
});
export const rosterProfileAttachmentSchema = z.object({
  key: z.string(), bucket: z.enum(["patient-assets", "clinic-assets"]), path: z.string(),
  fileName: z.string(), label: z.string(), mimeType: mergeableMimeSchema,
  sizeBytes: z.number().int().nonnegative(),
});
export type RosterProfileAttachment = z.infer<typeof rosterProfileAttachmentSchema>;

const patientRowSchema = z.object({
  id: z.string(), fileNumber: z.string(), fullName: z.string(), nationalId: z.string(),
  doctorName: z.string(), phone: z.string(), bloodType: z.string(),
  departmentId: z.string().nullable(), departmentName: z.string(), imageSrc: z.string().nullable().optional(),
});
const memberRowSchema = z.object({
  id: z.string(), fullName: z.string(), initials: z.string(), departmentId: z.string().nullable(),
  departmentName: z.string(), role: z.string(), isActive: z.boolean(), joinedAt: z.string(),
  imageSrc: z.string().nullable().optional(),
});
const patientFileSchema = z.object({
  kind: z.literal("patient-file"), id: z.string(), fullName: z.string(), initials: z.string(),
  imageSrc: z.string().nullable(), imageBackgroundSrc: z.string().nullable().optional(),
  fileNumber: z.string(), nationalId: z.string(), phone: z.string(),
  email: z.string(), dateOfBirth: z.string(), bloodType: z.string(), createdAt: z.string(),
  departmentName: z.string(), doctorName: z.string(), insuranceName: z.string(), isActive: z.boolean(),
});
const staffFileSchema = z.object({
  kind: z.literal("staff-file"), id: z.string(), fullName: z.string(), initials: z.string(),
  imageSrc: z.string().nullable(), phone: z.string(), role: z.string(), departmentName: z.string(),
  joinedAt: z.string(), isActive: z.boolean(), schedule: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6), enabled: z.boolean(), startTime: z.string(), endTime: z.string(),
  })),
});
const dataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("patient-list"), rows: z.array(patientRowSchema) }),
  patientFileSchema,
  z.object({ kind: z.literal("system-members"), rows: z.array(memberRowSchema) }),
  staffFileSchema,
]);

export const rosterProfileDocumentSnapshotSchema = z.object({
  version: z.literal(1), documentType: documentTypeSchema, generatedAt: z.string(),
  filters: z.object({ patientId: z.string().uuid().nullable(), staffId: z.string().uuid().nullable(),
    departmentId: z.string().uuid().nullable(), doctorId: z.string().uuid().nullable(),
    role: z.string().nullable(), search: z.string().nullable() }),
  branding: brandingSchema,
  format: z.object({ timeZone: z.string(), timeFormat: z.enum(["12h", "24h"]) }),
  settings: settingsSchema, attachments: z.array(rosterProfileAttachmentSchema), data: dataSchema,
});
export type RosterProfileDocumentParams = z.infer<typeof rosterProfileDocumentParamsSchema>;
export type RosterProfileDocumentSnapshot = z.infer<typeof rosterProfileDocumentSnapshotSchema>;

function text(value: string | null | undefined, fallback = "—") {
  return value?.trim() || fallback;
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "—";
}
function mimeFromName(name: string): RosterProfileAttachment["mimeType"] | null {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return null;
}

type ProfileImageBucket = "patient-assets" | "clinic-assets" | "avatars";
type ProfileImageRef = { bucket: ProfileImageBucket; path: string };

async function inlineStorageImage(
  bucket: ProfileImageBucket,
  path: string | null,
  variant: "full" | "list-thumbnail" = "full",
) {
  if (!path) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data || data.size > MAX_PROFILE_IMAGE_BYTES) return null;
  let mime = data.type || mimeFromName(path);
  if (!mime || !mime.startsWith("image/")) return null;
  let bytes: Uint8Array = new Uint8Array(await data.arrayBuffer());
  if (variant === "list-thumbnail") {
    try {
      bytes = await sharp(bytes).rotate().resize(48, 48, {
        fit: "cover", position: "centre", withoutEnlargement: true,
      }).webp({ quality: 86 }).toBuffer();
      mime = "image/webp";
    } catch {
      return null;
    }
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function staffImageRef(avatarUrl: string | null, clinicId: string, staffId: string): ProfileImageRef | null {
  if (!avatarUrl) return null;
  try {
    const pathname = decodeURIComponent(new URL(avatarUrl).pathname);
    for (const access of ["public", "sign", "authenticated"] as const) {
      const avatarsMarker = `/storage/v1/object/${access}/avatars/`;
      const avatarsIndex = pathname.indexOf(avatarsMarker);
      if (avatarsIndex >= 0) {
        const path = pathname.slice(avatarsIndex + avatarsMarker.length);
        if (path.startsWith(`${staffId}/`)) return { bucket: "avatars", path };
      }
      const clinicMarker = `/storage/v1/object/${access}/clinic-assets/`;
      const clinicIndex = pathname.indexOf(clinicMarker);
      if (clinicIndex >= 0) {
        const path = pathname.slice(clinicIndex + clinicMarker.length);
        if (path.startsWith(`staff/${clinicId}/${staffId}/photo.`)) {
          return { bucket: "clinic-assets", path };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function inlineImageRefs(refs: readonly (ProfileImageRef | null)[]) {
  const resolved: (string | null)[] = [];
  for (let start = 0; start < refs.length; start += 8) {
    const batch = refs.slice(start, start + 8);
    resolved.push(...await Promise.all(batch.map((ref) => ref
      ? inlineStorageImage(ref.bucket, ref.path, "list-thumbnail")
      : Promise.resolve(null))));
  }
  return resolved;
}

async function inlineLayeredStorageImage(bucket: ProfileImageBucket, path: string | null) {
  const imageSrc = await inlineStorageImage(bucket, path);
  if (!imageSrc) return { imageSrc: null, imageBackgroundSrc: null };
  try {
    const separator = imageSrc.indexOf(",");
    if (separator < 0) return { imageSrc, imageBackgroundSrc: imageSrc };
    const source = Buffer.from(imageSrc.slice(separator + 1), "base64");
    const background = await sharp(source).rotate().resize(72, 72, {
      fit: "cover", position: "centre",
    }).blur(8).webp({ quality: 78 }).toBuffer();
    return {
      imageSrc,
      imageBackgroundSrc: `data:image/webp;base64,${background.toString("base64")}`,
    };
  } catch {
    return { imageSrc, imageBackgroundSrc: imageSrc };
  }
}

async function loadPatientList(user: AuthedUser, params: RosterProfileDocumentParams) {
  const supabase = await createClient();
  let query = supabase.from("patients").select(
    "id, file_number, full_name, national_id, phone, blood_type, department_id, avatar_path, departments(name), assigned_doctor:profiles!assigned_doctor_id(full_name)",
  ).eq("clinic_id", user.clinicId).eq("is_deleted", false).eq("is_archived", false).order("full_name").limit(1000);
  if (user.role === "doctor" && user.departmentId) query = query.eq("department_id", user.departmentId);
  else if (params.departmentId) query = query.eq("department_id", params.departmentId);
  if (params.doctorId) query = query.eq("assigned_doctor_id", params.doctorId);
  if (params.search) {
    const term = params.search.replace(/[,()%_.\\]/g, " ").trim();
    if (term) query = query.or(
      `full_name.ilike.%${term}%,phone.ilike.%${term}%,file_number.ilike.%${term}%,national_id.ilike.%${term}%`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const sourceRows = data ?? [];
  const imageSources = await inlineImageRefs(sourceRows.map((row) => row.avatar_path
    ? { bucket: "patient-assets" as const, path: row.avatar_path }
    : null));
  return { kind: "patient-list" as const, rows: sourceRows.map((row, index) => ({
    id: row.id, fileNumber: text(row.file_number), fullName: text(row.full_name),
    nationalId: text(row.national_id), doctorName: text(row.assigned_doctor?.full_name),
    phone: text(row.phone), bloodType: text(row.blood_type), departmentId: row.department_id,
    departmentName: text(row.departments?.name, "Unassigned"), imageSrc: imageSources[index] ?? null,
  })) };
}

async function loadPatientFile(user: AuthedUser, params: RosterProfileDocumentParams) {
  const supabase = await createClient();
  const { data: row, error } = await supabase.from("patients").select(
    "id, full_name, file_number, national_id, phone, email, date_of_birth, blood_type, created_at, avatar_path, is_deleted, departments(name), assigned_doctor:profiles!assigned_doctor_id(full_name), insurance_providers(name)",
  ).eq("clinic_id", user.clinicId).eq("id", params.patientId!).eq("is_deleted", false).single();
  if (error || !row) throw new Error(error?.message ?? "Patient not found");
  const photo = await inlineLayeredStorageImage("patient-assets", row.avatar_path);
  return patientFileSchema.parse({
    kind: "patient-file", id: row.id, fullName: row.full_name, initials: initials(row.full_name),
    imageSrc: photo.imageSrc, imageBackgroundSrc: photo.imageBackgroundSrc,
    fileNumber: text(row.file_number), nationalId: text(row.national_id), phone: text(row.phone),
    email: text(row.email), dateOfBirth: row.date_of_birth, bloodType: text(row.blood_type),
    createdAt: row.created_at, departmentName: text(row.departments?.name),
    doctorName: text(row.assigned_doctor?.full_name), insuranceName: text(row.insurance_providers?.name),
    isActive: !row.is_deleted,
  });
}

async function loadSystemMembers(user: AuthedUser, params: RosterProfileDocumentParams) {
  const supabase = await createClient();
  let query = supabase.from("profiles").select(
    "id, full_name, department_id, role, is_active, created_at, avatar_url, departments(name)",
  ).eq("clinic_id", user.clinicId).eq("is_deleted", false).order("full_name").limit(1000);
  if (params.departmentId) query = query.eq("department_id", params.departmentId);
  if (params.role) query = query.eq("role", params.role);
  if (params.search) query = query.ilike("search_name", `%${params.search}%`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const sourceRows = data ?? [];
  const imageSources = await inlineImageRefs(sourceRows.map((row) =>
    staffImageRef(row.avatar_url, user.clinicId, row.id)));
  return { kind: "system-members" as const, rows: sourceRows.map((row, index) => ({
    id: row.id, fullName: text(row.full_name), initials: initials(row.full_name),
    departmentId: row.department_id, departmentName: text(row.departments?.name, "Management"),
    role: row.role, isActive: row.is_active, joinedAt: row.created_at,
    imageSrc: imageSources[index] ?? null,
  })) };
}

async function loadStaffFile(user: AuthedUser, params: RosterProfileDocumentParams) {
  const supabase = await createClient();
  const [{ data: row, error }, { data: schedule, error: scheduleError }] = await Promise.all([
    supabase.from("profiles").select(
      "id, full_name, phone, role, is_active, created_at, avatar_url, departments(name)",
    ).eq("clinic_id", user.clinicId).eq("id", params.staffId!).eq("is_deleted", false).single(),
    supabase.from("doctor_schedules").select("day_of_week, is_enabled, start_time, end_time")
      .eq("clinic_id", user.clinicId).eq("doctor_id", params.staffId!).order("day_of_week"),
  ]);
  if (error || !row) throw new Error(error?.message ?? "Staff member not found");
  if (scheduleError) throw new Error(scheduleError.message);
  const photoRef = staffImageRef(row.avatar_url, user.clinicId, row.id);
  return staffFileSchema.parse({
    kind: "staff-file", id: row.id, fullName: row.full_name, initials: initials(row.full_name),
    imageSrc: photoRef ? await inlineStorageImage(photoRef.bucket, photoRef.path) : null,
    phone: text(row.phone), role: row.role, departmentName: text(row.departments?.name, "Management"),
    joinedAt: row.created_at, isActive: row.is_active,
    schedule: (schedule ?? []).map((item) => ({ dayOfWeek: item.day_of_week,
      enabled: item.is_enabled, startTime: item.start_time, endTime: item.end_time })),
  });
}

async function listStaffStorageFiles(user: AuthedUser, staffId: string): Promise<RosterProfileAttachment[]> {
  const supabase = await createClient();
  const base = `staff/${user.clinicId}/${staffId}`;
  const [{ data: root }, { data: certificates }, { data: other }] = await Promise.all([
    supabase.storage.from("clinic-assets").list(base, { limit: 100 }),
    supabase.storage.from("clinic-assets").list(`${base}/certificates`, { limit: 100 }),
    supabase.storage.from("clinic-assets").list(`${base}/other`, { limit: 100 }),
  ]);
  const entries = [
    ...(root ?? []).filter((file) => file.name.startsWith("contract.")).map((file) => ({ file, path: `${base}/${file.name}`, label: "Contract" })),
    ...(certificates ?? []).map((file) => ({ file, path: `${base}/certificates/${file.name}`, label: "Certificate" })),
    ...(other ?? []).map((file) => ({ file, path: `${base}/other/${file.name}`, label: "Other" })),
  ];
  return entries.flatMap(({ file, path, label }) => {
    const mimeType = mimeFromName(file.name);
    if (!mimeType) return [];
    return [{ key: path, bucket: "clinic-assets" as const, path, fileName: file.name,
      label, mimeType, sizeBytes: Number(file.metadata?.size ?? 0) }];
  });
}

export async function listRosterProfileAttachmentOptions(
  user: AuthedUser, rawParams: RosterProfileDocumentParams,
): Promise<RosterProfileAttachment[]> {
  const params = rosterProfileDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();
  if (params.documentType === "PATIENT_FILE") {
    const { data, error } = await supabase.from("patient_documents")
      .select("id, storage_path, file_name, label, category, mime_type, size_bytes")
      .eq("clinic_id", user.clinicId).eq("patient_id", params.patientId!).is("deleted_at", null)
      .in("mime_type", [...MERGEABLE_ATTACHMENT_MIME_TYPES]).order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => rosterProfileAttachmentSchema.parse({ key: row.id,
      bucket: "patient-assets", path: row.storage_path, fileName: row.file_name,
      label: row.label || row.category, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes) }));
  }
  if (params.documentType === "STAFF_FILE") return listStaffStorageFiles(user, params.staffId!);
  return [];
}

function selectAttachments(options: RosterProfileAttachment[], selectedKeys: readonly string[]) {
  const unique = Array.from(new Set(selectedKeys));
  if (unique.length > MAX_MERGED_ATTACHMENTS) throw new Error("Too many attachments selected");
  const byKey = new Map(options.map((item) => [item.key, item]));
  const selected = unique.map((key) => byKey.get(key));
  if (selected.some((item) => !item)) throw new Error("Attachment selection is invalid or unavailable");
  const resolved = selected as RosterProfileAttachment[];
  if (resolved.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_MERGED_ATTACHMENT_BYTES) {
    throw new Error("Selected attachments exceed the merged size limit");
  }
  return resolved;
}

export async function resolveRosterProfileDocumentSnapshot(
  user: AuthedUser, rawParams: RosterProfileDocumentParams,
  options: { inlineAssets?: boolean; attachmentKeys?: readonly string[] } = {},
): Promise<RosterProfileDocumentSnapshot> {
  const params = rosterProfileDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();
  const [clinicResult, settingsResult, data, attachmentOptions] = await Promise.all([
    supabase.from("clinics").select("name, logo_url, address, phone, email, website, license_no, tax_id, document_footer, timezone, time_format")
      .eq("id", user.clinicId).single(),
    supabase.from("document_settings").select("doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset")
      .eq("clinic_id", user.clinicId).or(`doc_type.is.null,doc_type.eq.${params.documentType}`),
    params.documentType === "PATIENT_LIST_REPORT" ? loadPatientList(user, params)
      : params.documentType === "PATIENT_FILE" ? loadPatientFile(user, params)
      : params.documentType === "SYSTEM_MEMBERS_REPORT" ? loadSystemMembers(user, params)
      : loadStaffFile(user, params),
    options.attachmentKeys?.length ? listRosterProfileAttachmentOptions(user, params) : Promise.resolve([]),
  ]);
  if (clinicResult.error || !clinicResult.data) throw new Error(clinicResult.error?.message ?? "Clinic not found");
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  const clinic = clinicResult.data;
  const typeSettings = (settingsResult.data ?? []).find((row) => row.doc_type === params.documentType);
  const globalSettings = (settingsResult.data ?? []).find((row) => row.doc_type === null);
  const effective = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry(params.documentType);
  return rosterProfileDocumentSnapshotSchema.parse({
    version: 1, documentType: params.documentType, generatedAt: new Date().toISOString(),
    filters: { patientId: params.patientId ?? null, staffId: params.staffId ?? null,
      departmentId: params.departmentId ?? null, doctorId: params.doctorId ?? null,
      role: params.role ?? null, search: params.search ?? null },
    branding: { name: clinic.name,
      logoSrc: options.inlineAssets ? await inlineClinicLogo(clinic.logo_url, user.clinicId) : clinic.logo_url,
      address: clinic.address, phone: clinic.phone, email: clinic.email, website: clinic.website,
      licenseNo: clinic.license_no, taxId: clinic.tax_id, footerText: clinic.document_footer },
    format: { timeZone: clinic.timezone, timeFormat: clinic.time_format === "12h" ? "12h" : "24h" },
    settings: { watermark: (effective?.watermark_enabled ?? true) ? effective?.watermark_text?.trim() || clinic.name : null,
      qrEnabled: effective?.qr_enabled ?? true,
      numberingPrefix: typeSettings?.numbering_prefix?.trim() || globalSettings?.numbering_prefix?.trim() || catalog.numbering.prefix,
      numberingYearlyReset: effective?.numbering_yearly_reset ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding },
    attachments: selectAttachments(attachmentOptions, options.attachmentKeys ?? []), data,
  });
}

export function parseRosterProfileDocumentSnapshot(value: unknown) {
  return rosterProfileDocumentSnapshotSchema.parse(value);
}
