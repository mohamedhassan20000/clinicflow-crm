"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type {
  AccessLevel,
  UserCustomization,
} from "@/lib/customizations";

// ── Server actions ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

export async function getCustomizationsForUser(
  profileId: string,
): Promise<UserCustomization[]> {
  await requireRole("admin");
  const supabase: AnyClient = await createClient();
  const { data } = await supabase
    .from("user_customizations")
    .select("page, feature, access")
    .eq("profile_id", profileId);
  return (data ?? []) as UserCustomization[];
}

export async function upsertCustomization(
  profileId: string,
  page: string,
  feature: string,
  access: AccessLevel,
): Promise<{ error?: string }> {
  const admin = await requireRole("admin");
  const supabase: AnyClient = await createClient();

  const { error } = await supabase.from("user_customizations").upsert(
    {
      profile_id: profileId,
      clinic_id: admin.clinicId,
      page,
      feature,
      access,
    },
    { onConflict: "profile_id,page,feature" },
  );

  if (error) return { error: error.message };
  revalidatePath("/settings/customize");
  return {};
}

export async function resetUserCustomizations(
  profileId: string,
): Promise<{ error?: string }> {
  const admin = await requireRole("admin");
  const supabase: AnyClient = await createClient();

  const { error } = await supabase
    .from("user_customizations")
    .delete()
    .eq("profile_id", profileId)
    .eq("clinic_id", admin.clinicId);

  if (error) return { error: error.message };
  revalidatePath("/settings/customize");
  return {};
}
