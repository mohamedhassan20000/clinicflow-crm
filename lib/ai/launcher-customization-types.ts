import type { AssistantPageContextType } from "@/lib/ai/page-context";
import type { UserRole } from "@/lib/rbac";

export const ASSISTANT_CUSTOMIZATION_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const satisfies readonly UserRole[];

export type AssistantLauncherRoleSetting = {
  area: AssistantPageContextType;
  /** Per-role product default; a role absent here is unsupported for this area. */
  defaultEnabledByRole: Partial<Record<UserRole, boolean>>;
  eligibleRoles: readonly UserRole[];
  roleSettings: Partial<Record<UserRole, boolean>>;
};

export type AssistantLauncherStaffOverride = {
  id: string;
  fullName: string;
  role: UserRole;
  overrides: Partial<Record<AssistantPageContextType, boolean>>;
};

export type AssistantLauncherCustomizationData = {
  roleSettings: AssistantLauncherRoleSetting[];
  staff: AssistantLauncherStaffOverride[];
};
