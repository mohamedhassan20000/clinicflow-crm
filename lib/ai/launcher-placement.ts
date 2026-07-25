import "server-only";

import { AI_ASSISTANT_CUSTOMIZATION_FEATURE } from "@/lib/ai/authorization";
import type { AssistantPageContextType } from "@/lib/ai/page-context";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import type { AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export type AssistantLauncherPlacementInput = {
  customizationEntitled: boolean;
  defaultEnabled: boolean;
  roleSetting?: boolean;
  userOverride?: boolean;
};

/**
 * Applies the roadmap's placement precedence without consulting any Assistant
 * authorization input: entitlement -> code default -> role row -> user row.
 * When customization is not entitled, persisted rows are intentionally inert
 * and the stable code-owned default applies.
 */
export function resolveAssistantLauncherPlacementValue(
  input: AssistantLauncherPlacementInput,
): boolean {
  if (!input.customizationEntitled) return input.defaultEnabled;
  return input.userOverride ?? input.roleSetting ?? input.defaultEnabled;
}

/**
 * Reads only clinic-scoped UI placement metadata. A lookup failure throws so
 * the P4.8 launcher resolver can fail soft by omitting this optional enhancer;
 * it must never guess that a persisted disable row is absent.
 */
export async function resolveAssistantLauncherPlacement(input: {
  user: AuthedUser;
  area: AssistantPageContextType;
  defaultEnabled: boolean;
}): Promise<boolean> {
  const entitlements = await getEntitlements(input.user.clinicId);
  const customizationEntitled = hasFeature(
    entitlements,
    AI_ASSISTANT_CUSTOMIZATION_FEATURE,
  );

  if (!customizationEntitled) {
    return resolveAssistantLauncherPlacementValue({
      customizationEntitled,
      defaultEnabled: input.defaultEnabled,
    });
  }

  const client = createClinicScopedAdminClient(input.user.clinicId);
  const [roleResult, userResult] = await Promise.all([
    client
      .from("assistant_launcher_settings")
      .select("enabled")
      .eq("clinic_id", input.user.clinicId)
      .eq("area", input.area)
      .eq("role", input.user.role)
      .maybeSingle(),
    client
      .from("assistant_launcher_user_overrides")
      .select("enabled")
      .eq("clinic_id", input.user.clinicId)
      .eq("user_id", input.user.id)
      .eq("area", input.area)
      .maybeSingle(),
  ]);

  if (roleResult.error || userResult.error) {
    throw new Error("Failed to resolve Assistant launcher placement", {
      cause: roleResult.error ?? userResult.error,
    });
  }

  return resolveAssistantLauncherPlacementValue({
    customizationEntitled,
    defaultEnabled: input.defaultEnabled,
    roleSetting: roleResult.data?.enabled,
    userOverride: userResult.data?.enabled,
  });
}
