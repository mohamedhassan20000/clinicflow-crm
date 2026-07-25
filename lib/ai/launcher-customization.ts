import "server-only";

import { ASSISTANT_LAUNCHER_REGISTRY } from "@/lib/ai/launchers";
import type {
  AssistantLauncherCustomizationData,
  AssistantLauncherStaffOverride,
} from "@/lib/ai/launcher-customization-types";
import type { AssistantPageContextType } from "@/lib/ai/page-context";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

/**
 * Builds the primary-admin settings view from non-PHI placement metadata and
 * the clinic's active staff directory. It never reads patient, conversation,
 * prompt, tool, usage, or billing data.
 */
export async function getAssistantLauncherCustomization(
  user: AuthedUser,
): Promise<AssistantLauncherCustomizationData> {
  const client = createClinicScopedAdminClient(user.clinicId);
  const [roleResult, userResult, staffResult] = await Promise.all([
    client
      .from("assistant_launcher_settings")
      .select("area, role, enabled")
      .eq("clinic_id", user.clinicId),
    client
      .from("assistant_launcher_user_overrides")
      .select("user_id, area, enabled")
      .eq("clinic_id", user.clinicId),
    client
      .from("profiles")
      .select("id, full_name, role")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .in("role", ["admin", "manager", "receptionist", "doctor"])
      .order("full_name"),
  ]);

  if (roleResult.error || userResult.error || staffResult.error) {
    throw new Error("Failed to load Assistant launcher customization", {
      cause: roleResult.error ?? userResult.error ?? staffResult.error,
    });
  }

  const roleSettings = ASSISTANT_LAUNCHER_REGISTRY.map((definition) => {
    const settings: Partial<Record<UserRole, boolean>> = {};
    for (const row of roleResult.data ?? []) {
      if (
        row.area === definition.area &&
        definition.roles.includes(row.role)
      ) {
        settings[row.role] = row.enabled;
      }
    }
    return {
      area: definition.area,
      defaultEnabled: definition.defaultEnabled,
      eligibleRoles: [...definition.roles],
      roleSettings: settings,
    };
  });

  const definitions = new Map(
    ASSISTANT_LAUNCHER_REGISTRY.map((definition) => [
      definition.area,
      definition,
    ]),
  );
  const overridesByUser = new Map<
    string,
    Partial<Record<AssistantPageContextType, boolean>>
  >();
  for (const row of userResult.data ?? []) {
    const definition = definitions.get(row.area as AssistantPageContextType);
    const staffRole = staffResult.data?.find(
      (member) => member.id === row.user_id,
    )?.role;
    if (!definition || !staffRole || !definition.roles.includes(staffRole)) {
      continue;
    }
    const overrides = overridesByUser.get(row.user_id) ?? {};
    overrides[definition.area] = row.enabled;
    overridesByUser.set(row.user_id, overrides);
  }

  const staff: AssistantLauncherStaffOverride[] = (staffResult.data ?? []).map(
    (member) => ({
      id: member.id,
      fullName: member.full_name,
      role: member.role,
      overrides: overridesByUser.get(member.id) ?? {},
    }),
  );

  return { roleSettings, staff };
}
