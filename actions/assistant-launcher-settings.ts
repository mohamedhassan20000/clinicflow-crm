"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AI_ASSISTANT_CUSTOMIZATION_FEATURE } from "@/lib/ai/authorization";
import { ASSISTANT_LAUNCHER_REGISTRY } from "@/lib/ai/launchers";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { actionError } from "@/lib/i18n/action-errors";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { requireMutationRole, type AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const areaSchema = z.enum([
  "patient",
  "appointments",
  "dashboard",
  "revenue",
  "reports",
  "invoices",
  "staff",
  "departments",
  "doctor-schedule",
]);
const roleSchema = z.enum(["admin", "manager", "receptionist", "doctor"]);
const rolePlacementSchema = z.object({
  area: areaSchema,
  role: roleSchema,
  enabled: z.boolean().nullable(),
}).strict();
const userOverrideSchema = z.object({
  area: areaSchema,
  userId: z.string().uuid(),
  enabled: z.boolean().nullable(),
}).strict();

export type AssistantLauncherSettingsActionResult = {
  success?: boolean;
  error?: string;
};

async function genericFailure(): Promise<AssistantLauncherSettingsActionResult> {
  return {
    error: await actionError(
      "assistant-launcher-settings.weCouldNotCompleteThisRequestPleaseTryAgain",
    ),
  };
}

async function requireCustomizationAdmin(): Promise<
  | { user: AuthedUser }
  | { error: string }
> {
  const user = await requireMutationRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "assistant-launcher-settings.primaryAdminOnly",
      ),
    };
  }
  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_ASSISTANT_CUSTOMIZATION_FEATURE)) {
    return {
      error: await actionError(
        "assistant-launcher-settings.planDoesNotIncludeCustomization",
      ),
    };
  }
  return { user };
}

function roleCanUseArea(area: z.infer<typeof areaSchema>, role: z.infer<typeof roleSchema>) {
  return ASSISTANT_LAUNCHER_REGISTRY.some(
    (definition) =>
      definition.area === area && definition.roles.includes(role),
  );
}

/**
 * Sets or removes one role-level UI-placement decision. The authenticated
 * Supabase session is intentional: P4.9A's RLS and audit trigger require the
 * real primary-admin JWT, while the service-role wrapper is read-only here.
 */
export async function setAssistantRoleLauncherPlacement(
  input: unknown,
): Promise<AssistantLauncherSettingsActionResult> {
  const parsed = rolePlacementSchema.safeParse(input);
  if (!parsed.success || !roleCanUseArea(parsed.data.area, parsed.data.role)) {
    return {
      error: await actionError(
        "assistant-launcher-settings.areaNotAvailableForRole",
      ),
    };
  }

  const access = await requireCustomizationAdmin();
  if ("error" in access) return { error: access.error };
  const { user } = access;
  const client = await createClient();

  const result = parsed.data.enabled === null
    ? await client
        .from("assistant_launcher_settings")
        .delete()
        .eq("clinic_id", user.clinicId)
        .eq("area", parsed.data.area)
        .eq("role", parsed.data.role)
    : await client.from("assistant_launcher_settings").upsert(
        {
          clinic_id: user.clinicId,
          area: parsed.data.area,
          role: parsed.data.role,
          enabled: parsed.data.enabled,
          updated_by: user.id,
        },
        { onConflict: "clinic_id,area,role" },
      );

  if (result.error) return genericFailure();
  revalidatePath("/settings/assistant");
  return { success: true };
}

/** Sets or removes one same-clinic, role-eligible per-user override. */
export async function setAssistantUserLauncherOverride(
  input: unknown,
): Promise<AssistantLauncherSettingsActionResult> {
  const parsed = userOverrideSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: await actionError(
        "assistant-launcher-settings.invalidUserOverride",
      ),
    };
  }

  const access = await requireCustomizationAdmin();
  if ("error" in access) return { error: access.error };
  const { user } = access;
  const reader = createClinicScopedAdminClient(user.clinicId);
  const { data: target, error: targetError } = await reader
    .from("profiles")
    .select("id, role")
    .eq("clinic_id", user.clinicId)
    .eq("id", parsed.data.userId)
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .single();

  if (
    targetError ||
    !target ||
    !roleCanUseArea(parsed.data.area, target.role)
  ) {
    return {
      error: await actionError(
        "assistant-launcher-settings.staffMemberOrAreaNotAvailable",
      ),
    };
  }

  const client = await createClient();
  const result = parsed.data.enabled === null
    ? await client
        .from("assistant_launcher_user_overrides")
        .delete()
        .eq("clinic_id", user.clinicId)
        .eq("user_id", target.id)
        .eq("area", parsed.data.area)
    : await client.from("assistant_launcher_user_overrides").upsert(
        {
          clinic_id: user.clinicId,
          user_id: target.id,
          area: parsed.data.area,
          enabled: parsed.data.enabled,
        },
        { onConflict: "clinic_id,user_id,area" },
      );

  if (result.error) return genericFailure();
  revalidatePath("/settings/assistant");
  return { success: true };
}
