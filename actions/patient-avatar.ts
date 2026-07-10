"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole } from "@/lib/rbac";

const BUCKET = "patient-assets";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

type AvatarResult = {
  error?: string;
  ok?: boolean;
};

function avatarPath(clinicId: string, patientId: string, ext: string) {
  return `avatars/${clinicId}/${patientId}/avatar.${ext}`;
}

function avatarPrefix(clinicId: string, patientId: string) {
  return `avatars/${clinicId}/${patientId}/`;
}

function extensionForMime(type: string) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return null;
}

async function getPatientForAvatar(patientId: string, clinicId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .select("id, avatar_path")
    .eq("id", patientId)
    .eq("clinic_id", clinicId)
    .eq("is_deleted", false)
    .single();

  if (error || !data) return null;
  return { patient: data, supabase };
}

export async function uploadPatientAvatar(
  patientId: string,
  formData: FormData,
): Promise<AvatarResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await getPatientForAvatar(patientId, user.clinicId);
  if (!result) return { error: "Patient not found." };

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Pick an image to upload." };
  }
  if (!ALLOWED_AVATAR_MIME.has(file.type)) {
    return { error: "Avatar must be JPEG, PNG, or WebP." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { error: "Avatar must be under 2 MB." };
  }

  const ext = extensionForMime(file.type);
  if (!ext) return { error: "Unsupported avatar file type." };

  const { patient, supabase } = result;
  const path = avatarPath(user.clinicId, patientId, ext);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: file.type,
      upsert: true,
    });
  if (uploadError) {
    return { error: uploadError.message || "Failed to upload avatar." };
  }

  const { error: updateError } = await supabase
    .from("patients")
    .update({ avatar_path: path, updated_by: user.id })
    .eq("id", patientId)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false);

  if (updateError) {
    await supabase.storage.from(BUCKET).remove([path]);
    return { error: "Failed to update patient avatar." };
  }

  const previousPath = patient.avatar_path;
  if (
    previousPath &&
    previousPath !== path &&
    previousPath.startsWith(avatarPrefix(user.clinicId, patientId))
  ) {
    await supabase.storage.from(BUCKET).remove([previousPath]);
  }

  revalidatePath("/patients");
  revalidatePath(`/patients/${patientId}`);
  return { ok: true };
}

export async function removePatientAvatar(
  patientId: string,
): Promise<AvatarResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await getPatientForAvatar(patientId, user.clinicId);
  if (!result) return { error: "Patient not found." };

  const { patient, supabase } = result;
  const existingPath = patient.avatar_path;
  if (!existingPath) return { ok: true };

  if (!existingPath.startsWith(avatarPrefix(user.clinicId, patientId))) {
    return { error: "Stored avatar path is not valid for this patient." };
  }

  const { error: updateError } = await supabase
    .from("patients")
    .update({ avatar_path: null, updated_by: user.id })
    .eq("id", patientId)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false);

  if (updateError) {
    return { error: "Failed to remove patient avatar." };
  }

  await supabase.storage.from(BUCKET).remove([existingPath]);

  revalidatePath("/patients");
  revalidatePath(`/patients/${patientId}`);
  return { ok: true };
}
