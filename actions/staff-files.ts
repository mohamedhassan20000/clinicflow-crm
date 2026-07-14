"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import {
  requireMutationRole as requireRole,
  requireRole as requireReadRole,
} from "@/lib/rbac";

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
  const user = await requireReadRole(["admin", "manager"]);
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId)
    .single();
  if (!profile) return { error: await actionError("staff-files.staffMemberNotFound") };

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

  const flat = rootFiles ?? [];
  const photoEntry = flat.find((f) => f.name.startsWith("photo."));
  const contractEntry = flat.find((f) => f.name.startsWith("contract."));

  const photoPath = photoEntry ? `${base}/${photoEntry.name}` : null;
  const contractPath = contractEntry ? `${base}/${contractEntry.name}` : null;
  const certificatePaths = (certFiles ?? []).map(
    (f) => `${base}/certificates/${f.name}`,
  );
  const otherPaths = (otherFiles ?? []).map((f) => `${base}/other/${f.name}`);
  const paths = [
    photoPath,
    contractPath,
    ...certificatePaths,
    ...otherPaths,
  ].filter((path): path is string => Boolean(path));
  const signedUrls = new Map<string, string>();

  if (paths.length > 0) {
    const { data } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(paths, 3600);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) signedUrls.set(item.path, item.signedUrl);
    }
  }

  const photo: StaffFile | null =
    photoEntry && photoPath
      ? {
          name: photoEntry.name,
          path: photoPath,
          size: photoEntry.metadata?.size ?? 0,
          createdAt: photoEntry.created_at ?? "",
          url: signedUrls.get(photoPath) ?? "",
        }
      : null;

  const contract: StaffFile | null =
    contractEntry && contractPath
      ? {
          name: contractEntry.name,
          path: contractPath,
          size: contractEntry.metadata?.size ?? 0,
          createdAt: contractEntry.created_at ?? "",
          url: signedUrls.get(contractPath) ?? "",
        }
      : null;

  const certificates = (certFiles ?? []).map((f) => {
    const path = `${base}/certificates/${f.name}`;
    return {
      name: f.name,
      path,
      size: f.metadata?.size ?? 0,
      createdAt: f.created_at ?? "",
      url: signedUrls.get(path) ?? "",
    };
  });

  const other = (otherFiles ?? []).map((f) => {
    const path = `${base}/other/${f.name}`;
    return {
      name: f.name,
      path,
      size: f.metadata?.size ?? 0,
      createdAt: f.created_at ?? "",
      url: signedUrls.get(path) ?? "",
    };
  });

  return { data: { photo, contract, certificates, other } };
}

export async function uploadStaffPhoto(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: await actionError("staff-files.noFileProvided") };
  if (!ALLOWED_PHOTO.includes(file.type))
    return { error: await actionError("staff-files.photoMustBeJpegPngOrWebp") };
  if (file.size > MAX_PHOTO_BYTES)
    return { error: await actionError("staff-files.photoMustBeUnder2Mb") };

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = staffPath(user.clinicId, staffId, `photo.${ext}`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };

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
  if (!file || file.size === 0) return { error: await actionError("staff-files.noFileProvided") };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: await actionError("staff-files.contractMustBePdfWordJpegOrPng") };
  if (file.size > MAX_DOC_BYTES)
    return { error: await actionError("staff-files.contractMustBeUnder10Mb") };

  const ext = file.name.split(".").pop() ?? "pdf";
  const path = staffPath(user.clinicId, staffId, `contract.${ext}`);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };

  return listStaffFiles(staffId);
}

export async function uploadStaffCertificate(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: await actionError("staff-files.noFileProvided") };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: await actionError("staff-files.certificateMustBePdfWordJpegOrPng") };
  if (file.size > MAX_DOC_BYTES)
    return { error: await actionError("staff-files.certificateMustBeUnder10Mb") };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = staffPath(
    user.clinicId,
    staffId,
    `certificates/${Date.now()}_${safeName}`,
  );

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };

  return listStaffFiles(staffId);
}

export async function uploadStaffOtherDoc(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const file = fd.get("file") as File | null;
  if (!file || file.size === 0) return { error: await actionError("staff-files.noFileProvided") };
  if (!ALLOWED_DOCS.includes(file.type))
    return { error: await actionError("staff-files.documentMustBePdfWordJpegOrPng") };
  if (file.size > MAX_DOC_BYTES)
    return { error: await actionError("staff-files.documentMustBeUnder10Mb") };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = staffPath(
    user.clinicId,
    staffId,
    `other/${Date.now()}_${safeName}`,
  );

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };

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
    return { error: await actionError("staff-files.unauthorized") };

  const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
  if (error) return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };

  if (filePath.includes("/photo.")) {
    await supabase
      .from("profiles")
      .update({ avatar_url: null })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
  }

  return listStaffFiles(staffId);
}
