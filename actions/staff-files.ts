"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import {
  requireMutationRole as requireRole,
  requireRole as requireReadRole,
} from "@/lib/rbac";

const BUCKET = "clinic-assets";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // 6 MB
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

function refreshStaffFiles(clinicId: string) {
  revalidateTag(`staff:${clinicId}`, {});
  revalidatePath("/settings/staff");
}

async function getWritableStaffTarget(staffId: string, clinicId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", staffId)
    .eq("clinic_id", clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  return data;
}

function isAllowedStaffDocumentPath(path: string, clinicId: string, staffId: string) {
  const base = `staff/${clinicId}/${staffId}/`;
  if (!path.startsWith(base)) return false;
  const relative = path.slice(base.length);
  return /^(?:photo|contract)\.[^/]+$/.test(relative)
    || /^(?:certificates|other)\/[^/]+$/.test(relative);
}

function documentFileEntries(fd: FormData, key: string) {
  return fd.getAll(key).filter((entry): entry is File => entry instanceof File && entry.size > 0);
}

function validatePhoto(file: File | null) {
  if (!file) return null;
  if (!ALLOWED_PHOTO.includes(file.type)) return "photoMustBeJpegPngOrWebp" as const;
  if (file.size > MAX_PHOTO_BYTES) return "photoMustBe6MbOrSmaller" as const;
  return null;
}

function validateDocument(file: File) {
  if (!ALLOWED_DOCS.includes(file.type)) return false;
  return file.size <= MAX_DOC_BYTES;
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
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

/**
 * Applies the Documents tab draft for one staff member. The payload contains
 * only staff-file assets and the profile avatar pointer owned by this section.
 */
export async function saveStaffDocuments(
  staffId: string,
  fd: FormData,
): Promise<FileActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const target = await getWritableStaffTarget(staffId, user.clinicId);
  if (!target) return { error: await actionError("staff-files.staffMemberNotFound") };
  if (user.role === "manager" && target.role === "admin") {
    return { error: await actionError("staff-files.unauthorized") };
  }

  const photoEntry = fd.get("photo");
  const photo = photoEntry instanceof File && photoEntry.size > 0 ? photoEntry : null;
  const contractEntry = fd.get("contract");
  const contract = contractEntry instanceof File && contractEntry.size > 0 ? contractEntry : null;
  const certificates = documentFileEntries(fd, "certificates");
  const other = documentFileEntries(fd, "other");
  const photoAction = fd.get("photo_action");
  const contractAction = fd.get("contract_action");

  const photoValidation = validatePhoto(photo);
  if (photoValidation) return { error: await actionError(`staff-files.${photoValidation}`) };
  if (contract && !validateDocument(contract)) {
    return { error: await actionError("staff-files.contractMustBePdfWordJpegOrPng") };
  }
  if ([...certificates, ...other].some((file) => !validateDocument(file))) {
    return { error: await actionError("staff-files.documentMustBePdfWordJpegOrPng") };
  }
  if (certificates.length > 50 || other.length > 50) {
    return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  let removedPaths: string[] = [];
  const rawRemovedPaths = fd.get("remove_paths");
  if (typeof rawRemovedPaths === "string" && rawRemovedPaths) {
    try {
      const parsed = JSON.parse(rawRemovedPaths) as unknown;
      if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some((path) =>
        typeof path !== "string" || !isAllowedStaffDocumentPath(path, user.clinicId, staffId))) {
        return { error: await actionError("staff-files.unauthorized") };
      }
      removedPaths = parsed;
    } catch {
      return { error: await actionError("staff-files.unauthorized") };
    }
  }

  const base = `staff/${user.clinicId}/${staffId}`;
  const { data: rootFiles } = await supabase.storage.from(BUCKET).list(base, { limit: 100 });
  const existingPhotoPaths = (rootFiles ?? [])
    .filter((file) => file.name.startsWith("photo."))
    .map((file) => `${base}/${file.name}`);
  const existingContractPaths = (rootFiles ?? [])
    .filter((file) => file.name.startsWith("contract."))
    .map((file) => `${base}/${file.name}`);
  const uploadedPaths: string[] = [];

  async function upload(path: string, file: File, upsert = false) {
    const result = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: file.type,
      upsert,
    });
    if (!result.error) uploadedPaths.push(path);
    return result.error;
  }

  let savedPhotoPath: string | null = null;
  if (photoAction === "replace" && photo) {
    const ext = photo.name.split(".").pop()?.toLowerCase() || "jpg";
    savedPhotoPath = staffPath(user.clinicId, staffId, `photo.${ext}`);
    if (await upload(savedPhotoPath, photo, true)) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
    const { data: signed, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(savedPhotoPath, 60 * 60 * 24 * 365);
    if (signedError || !signed?.signedUrl) {
      await supabase.storage.from(BUCKET).remove([savedPhotoPath]);
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
    const { error: avatarError } = await supabase
      .from("profiles")
      .update({ avatar_url: signed.signedUrl })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
    if (avatarError) {
      await supabase.storage.from(BUCKET).remove([savedPhotoPath]);
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  } else if (photoAction === "remove") {
    const { error: avatarError } = await supabase
      .from("profiles")
      .update({ avatar_url: null })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
    if (avatarError) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  let savedContractPath: string | null = null;
  if (contractAction === "replace" && contract) {
    const ext = contract.name.split(".").pop()?.toLowerCase() || "pdf";
    savedContractPath = staffPath(user.clinicId, staffId, `contract.${ext}`);
    if (await upload(savedContractPath, contract, true)) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  const stamp = Date.now();
  for (const [index, file] of certificates.entries()) {
    const path = staffPath(user.clinicId, staffId, `certificates/${stamp}_${index}_${safeFileName(file.name)}`);
    if (await upload(path, file)) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }
  for (const [index, file] of other.entries()) {
    const path = staffPath(user.clinicId, staffId, `other/${stamp}_${index}_${safeFileName(file.name)}`);
    if (await upload(path, file)) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  const implicitRemovals = [
    ...(photoAction === "replace" || photoAction === "remove" ? existingPhotoPaths : []),
    ...(contractAction === "replace" || contractAction === "remove" ? existingContractPaths : []),
  ];
  const removals = Array.from(new Set([...removedPaths, ...implicitRemovals]))
    .filter((path) => path !== savedPhotoPath && path !== savedContractPath && !uploadedPaths.includes(path));
  if (removals.length > 0) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(removals);
    if (removeError) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  refreshStaffFiles(user.clinicId);
  return listStaffFiles(staffId);
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
    return { error: await actionError("staff-files.photoMustBe6MbOrSmaller") };

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
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ avatar_url: signed.signedUrl })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
    if (profileError) {
      await supabase.storage.from(BUCKET).remove([path]);
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  refreshStaffFiles(user.clinicId);
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
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ avatar_url: null })
      .eq("id", staffId)
      .eq("clinic_id", user.clinicId);
    if (profileError) {
      return { error: await actionError("staff-files.weCouldNotCompleteThisRequestPleaseTryAgain") };
    }
  }

  refreshStaffFiles(user.clinicId);
  return listStaffFiles(staffId);
}
