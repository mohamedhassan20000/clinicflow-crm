"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  clinicianCredentialsSchema,
  type ClinicianCredentialsInput,
} from "@/lib/validations/clinical";
import {
  mutationFailure,
  validationFailure,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

const SIGNATURE_BUCKET = "clinic-assets";
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const SIGNATURE_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

async function authorizeCredentialTarget(staffId: string, mutation: boolean) {
  const user = mutation
    ? await requireMutationRole(["admin", "doctor"])
    : await requireRole(["admin", "doctor"]);
  if (user.role !== "admin" && user.id !== staffId) return { user, target: null };
  const supabase = await createClient();
  const { data: target } = await supabase.from("profiles")
    .select("id, role, signature_path")
    .eq("id", staffId).eq("clinic_id", user.clinicId).eq("role", "doctor")
    .eq("is_active", true).maybeSingle();
  return { user, target };
}

function refreshCredentials(clinicId: string) {
  revalidateTag(`staff:${clinicId}`, {});
  revalidatePath("/settings/staff");
}

export async function updateClinicianCredentials(
  staffId: string,
  input: ClinicianCredentialsInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const parsed = clinicianCredentialsSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const { user, target } = await authorizeCredentialTarget(staffId, true);
  if (!target) return { error: await actionError("clinical.credentialUpdateDenied") };
  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles")
    .update(parsed.data).eq("id", staffId).eq("clinic_id", user.clinicId)
    .select("id").maybeSingle();
  if (error || !data) return mutationFailure();
  refreshCredentials(user.clinicId);
  return { success: true, data: { id: data.id } };
}

/** Saves the credential section only, including an optional staged signature change. */
export async function saveClinicianCredentials(
  staffId: string,
  formData: FormData,
): Promise<ClinicalActionResult<{ id: string; signatureUrl: string | null }>> {
  const parsed = clinicianCredentialsSchema.safeParse({
    professional_license_no: formData.get("professional_license_no"),
    specialty: formData.get("specialty"),
    professional_title: formData.get("professional_title"),
  });
  if (!parsed.success) return validationFailure(parsed.error.issues);

  const signatureAction = formData.get("signature_action");
  if (!['keep', 'replace', 'remove'].includes(String(signatureAction))) {
    return validationFailure([]);
  }
  const signatureEntry = formData.get("signature");
  const signature = signatureEntry instanceof File && signatureEntry.size > 0
    ? signatureEntry
    : null;
  const extension = signature ? SIGNATURE_MIME.get(signature.type) : null;
  if (signatureAction === "replace" && (!signature || !extension || signature.size > MAX_SIGNATURE_BYTES)) {
    return { error: await actionError("clinical.signatureInvalid") };
  }

  const { user, target } = await authorizeCredentialTarget(staffId, true);
  if (!target) return { error: await actionError("clinical.credentialUpdateDenied") };
  const supabase = await createClient();
  let nextSignaturePath: string | null | undefined;
  if (signatureAction === "replace" && signature && extension) {
    nextSignaturePath = `staff/${user.clinicId}/${staffId}/signature/signature.${extension}`;
    const uploaded = await supabase.storage.from(SIGNATURE_BUCKET)
      .upload(nextSignaturePath, signature, { contentType: signature.type, upsert: true });
    if (uploaded.error) return mutationFailure();
  } else if (signatureAction === "remove") {
    nextSignaturePath = null;
  }

  const credentialUpdate = {
    ...parsed.data,
    ...(nextSignaturePath !== undefined ? { signature_path: nextSignaturePath } : {}),
  };
  const { data, error } = await supabase.from("profiles")
    .update(credentialUpdate)
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (nextSignaturePath) {
      await supabase.storage.from(SIGNATURE_BUCKET).remove([nextSignaturePath]);
    }
    return mutationFailure();
  }

  if (target.signature_path && target.signature_path !== nextSignaturePath
    && signatureAction !== "keep") {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([target.signature_path]);
  }

  let signatureUrl: string | null = null;
  const resolvedPath = nextSignaturePath === undefined
    ? target.signature_path
    : nextSignaturePath;
  if (resolvedPath) {
    const { data: signed } = await supabase.storage.from(SIGNATURE_BUCKET)
      .createSignedUrl(resolvedPath, 3600);
    signatureUrl = signed?.signedUrl ?? null;
  }

  refreshCredentials(user.clinicId);
  return { success: true, data: { id: data.id, signatureUrl } };
}

export async function uploadClinicianSignature(
  staffId: string,
  formData: FormData,
): Promise<ClinicalActionResult<{ path: string; url: string }>> {
  const { user, target } = await authorizeCredentialTarget(staffId, true);
  if (!target) return { error: await actionError("clinical.credentialUpdateDenied") };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: await actionError("clinical.signatureRequired") };
  }
  const extension = SIGNATURE_MIME.get(file.type);
  if (!extension || file.size > MAX_SIGNATURE_BYTES) {
    return { error: await actionError("clinical.signatureInvalid") };
  }
  const supabase = await createClient();
  const path = `staff/${user.clinicId}/${staffId}/signature/signature.${extension}`;
  const uploaded = await supabase.storage.from(SIGNATURE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });
  if (uploaded.error) return mutationFailure();
  const profile = await supabase.from("profiles").update({ signature_path: path })
    .eq("id", staffId).eq("clinic_id", user.clinicId);
  if (profile.error) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([path]);
    return mutationFailure();
  }
  if (target.signature_path && target.signature_path !== path) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([target.signature_path]);
  }
  const { data: signed } = await supabase.storage.from(SIGNATURE_BUCKET)
    .createSignedUrl(path, 3600);
  refreshCredentials(user.clinicId);
  return { success: true, data: { path, url: signed?.signedUrl ?? "" } };
}

export async function removeClinicianSignature(
  staffId: string,
): Promise<ClinicalActionResult<{ id: string }>> {
  const { user, target } = await authorizeCredentialTarget(staffId, true);
  if (!target) return { error: await actionError("clinical.credentialUpdateDenied") };
  const supabase = await createClient();
  const updated = await supabase.from("profiles").update({ signature_path: null })
    .eq("id", staffId).eq("clinic_id", user.clinicId);
  if (updated.error) return mutationFailure();
  if (target.signature_path) {
    const removed = await supabase.storage.from(SIGNATURE_BUCKET).remove([target.signature_path]);
    if (removed.error) return mutationFailure();
  }
  refreshCredentials(user.clinicId);
  return { success: true, data: { id: staffId } };
}

export async function getClinicianSignatureUrl(staffId: string) {
  const { target } = await authorizeCredentialTarget(staffId, false);
  if (!target?.signature_path) return { url: null, error: null };
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(SIGNATURE_BUCKET)
    .createSignedUrl(target.signature_path, 3600);
  return { url: data?.signedUrl ?? null, error: error ? await actionError("clinical.signatureReadFailed") : null };
}
