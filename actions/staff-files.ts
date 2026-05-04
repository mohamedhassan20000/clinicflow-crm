"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

const BUCKET = "clinic-assets";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_PHOTO = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_DOCS = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export interface StaffFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  url: string;
}

export interface StaffFiles {
  photo: StaffFile | null;
  contract: StaffFile | null;
  certificates: StaffFile[];
  other: StaffFile[];
}

export interface FileActionResult {
  error?: string;
  data?: StaffFiles;
}

function staffPath(clinicId: string, staffId: string, segment: string) {
  return `staff/${clinicId}/${staffId}/${segment}`;
}

export async function listStaffFiles(
  staffId: string,
): Promise<{ data?: StaffFiles; error?: string }> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId)
    .single();
  if (!profile) return { error: "Staff member not found." };

  const base = `staff/${user.clinicId}/${staffId}`;

  const [{ data: rootFiles }, { data: certFiles }, { data: otherFiles }] =
    await Promise.all([
      supabase.storage.from(BUCKET).list(base, {
        limit: 100,
        sortBy: { column: "created_at", order: "asc" },
      }),
      supabase.storage.from(BUCKET).list(`${base}/certificates`, {
        limit: 50,
        sortBy: { column: "created_at", order: "asc" },
      }),
      supabase.storage.from(BUCKET).list(`${base}/other`, {
        limit: 50,
        sortBy: { column: "created_at", order: "asc" },
      }),
    ]);

  async function signedUrl(path: string): Promise<string> {
    const { data } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, 3600);
    return data?.signedUrl ?? "";
  }

  const flat = rootFiles ?? [];
  const photoEntry = flat.find((f) => f.name.startsWith("photo."));
  const contractEntry = flat.find((f) => f.name.startsWith("contract."));

  const [photo, contract] = await Promise.all([
    photoEntry
      ? (async (): Promise<StaffFile> => ({
          name: photoEntry.name,
          path: `${base}/${photoEntry.name}`,
          size: photoEntry.metadata?.size ?? 0,
          createdAt: photoEntry.created_at ?? "",
          url: await signedUrl(`${base}/${photoEntry.name}`),
        }))()
      : Promise.resolve(null),
    contractEntry
      ? (async (): Promise<StaffFile> => ({
          name: contractEntry.name,
          path: `${base}/${contractEntry.name}`,
          size: contractEntry.metadata?.size ?? 0,
          createdAt: contractEntry.created_at ?? "",
          url: await signedUrl(`${base}/${contractEntry.name}`),
        }))()
      : Promise.resolve(null),
  ]);

  const [certificates, other] = await Promise.all([
    Promise.all(
      (certFiles ?? []).map(async (f) => ({
        name: f.name,
        path: `${base}/certificates/${f.name}`,
        size: f.metadata?.size ?? 0,
        createdAt: f.created_at ?? "",
        url: await signedUrl(`${base}/certificates/${f.name}`),
      })),
    ),
    Promise.all(
      (otherFiles ?? []).map(async (f) => ({
        name: f.name,
        path: `${base}/other/${f.name}`,
        size: f.metadata?.size ?? 0,
        createdAt: f.created_at ?? "",
        url: await signedUrl(`${base}/other/${f.name}`),
      })),
    ),
  ]);

  return { data: { photo, contract, certificates, other } };
}

export async function uploadStaffPhoto(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: "No file provided." };
  if (!ALLOWED_PHOTO.includes(file.type))
    return { error: "Photo must be JPEG, PNG, or WebP." };
  if (file.size > MAX_PHOTO_BYTES)
    return { error: "Photo must be under 2 MB." };

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = staffPath(user.clinicId, staffId, `photo.${ext}`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) return { error: error.message };

  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 365);
  if (signed?.signedUrl) {
    await supabase
      .from("profiles")
      .update({ avatar_url: signed.signedUrl })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
  }

  return listStaffFiles(staffId);
}

export async function uploadStaffContract(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: "No file provided." };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: "Contract must be PDF, Word, JPEG, or PNG." };
  if (file.size > MAX_DOC_BYTES)
    return { error: "Contract must be under 10 MB." };

  const ext = file.name.split(".").pop() ?? "pdf";
  const path = staffPath(user.clinicId, staffId, `contract.${ext}`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) return { error: error.message };

  return listStaffFiles(staffId);
}

export async function uploadStaffCertificate(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: "No file provided." };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: "Certificate must be PDF, Word, JPEG, or PNG." };
  if (file.size > MAX_DOC_BYTES)
    return { error: "Certificate must be under 10 MB." };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = staffPath(
    user.clinicId,
    staffId,
    `certificates/${Date.now()}_${safeName}`,
  );

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) return { error: error.message };

  return listStaffFiles(staffId);
}

export async function uploadStaffOtherDoc(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: "No file provided." };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: "Document must be PDF, Word, JPEG, or PNG." };
  if (file.size > MAX_DOC_BYTES)
    return { error: "Document must be under 10 MB." };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = staffPath(
    user.clinicId,
    staffId,
    `other/${Date.now()}_${safeName}`,
  );

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) return { error: error.message };

  return listStaffFiles(staffId);
}

export async function deleteStaffFile(
  staffId: string,
  filePath: string,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const expectedPrefix = `staff/${user.clinicId}/${staffId}/`;
  if (!filePath.startsWith(expectedPrefix))
    return { error: "Unauthorized." };

  const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
  if (error) return { error: error.message };

  if (filePath.includes("/photo.")) {
    await supabase
      .from("profiles")
      .update({ avatar_url: null })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
  }

  return listStaffFiles(staffId);
}
