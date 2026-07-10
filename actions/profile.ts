"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireMutationUser, requireUser } from "@/lib/rbac";

export type ActionResult = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

const profileSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be 100 characters or less"),
  phone: z
    .string()
    .trim()
    .max(40, "Phone must be 40 characters or less")
    .nullable()
    .optional(),
});

const passwordSchema = z
  .object({
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[0-9]/, "Must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const ALLOWED_AVATAR_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

function avatarObjectKey(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const marker = "/avatars/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
  } catch {
    const marker = "/avatars/";
    const markerIndex = url.indexOf(marker);
    if (markerIndex === -1) return null;
    return url.slice(markerIndex + marker.length);
  }
}

export async function updateProfile(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationUser();

  const raw = {
    full_name: formData.get("full_name"),
    phone: (formData.get("phone") as string | null)?.trim() || null,
  };
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      phone: parsed.data.phone ?? null,
    })
    .eq("id", user.id);

  if (error) return { error: error.message || "Failed to update profile." };

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function uploadAvatar(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationUser();

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Pick an image to upload." };
  }
  if (!ALLOWED_AVATAR_MIME.has(file.type)) {
    return { error: "Only JPEG, PNG, WebP or GIF images are allowed." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { error: "Image must be 5 MB or smaller." };
  }

  const supabase = await createClient();
  const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
  // Cache-bust the URL by including a timestamp in the filename.
  const objectKey = `${user.id}/avatar-${Date.now()}.${ext}`;

  // Buffer the file once — Supabase JS expects a Blob/Uint8Array/File.
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from("avatars")
    .upload(objectKey, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (upErr) {
    return { error: upErr.message || "Failed to upload image." };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("avatars").getPublicUrl(objectKey);

  // Best-effort: fetch the previous avatar so we can delete it after the new
  // one is wired up. Failures here are non-fatal.
  const { data: prev } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const { error: profErr } = await supabase
    .from("profiles")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id);
  if (profErr) {
    return { error: profErr.message || "Failed to update profile photo." };
  }

  if (prev?.avatar_url) {
    try {
      const previousKey = prev.avatar_url.split("/avatars/")[1];
      if (previousKey && previousKey !== objectKey) {
        await supabase.storage.from("avatars").remove([previousKey]);
      }
    } catch {
      // ignore cleanup errors — they don't affect the primary flow
    }
  }

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function removeAvatar(
  _prev?: ActionResult | null,
): Promise<ActionResult> {
  void _prev;
  const user = await requireMutationUser();
  const supabase = await createClient();

  const { data: prev } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const { error } = await supabase
    .from("profiles")
    .update({ avatar_url: null })
    .eq("id", user.id);

  if (error) return { error: error.message || "Failed to remove profile photo." };

  const previousKey = avatarObjectKey(prev?.avatar_url);
  if (previousKey) {
    try {
      await supabase.storage.from("avatars").remove([previousKey]);
    } catch {
      // Best-effort cleanup: the profile is already cleared.
    }
  }

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function changeMyPassword(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireUser();

  const raw = {
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  };
  const parsed = passwordSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    return { error: error.message || "Failed to update password." };
  }

  return { ok: true };
}
