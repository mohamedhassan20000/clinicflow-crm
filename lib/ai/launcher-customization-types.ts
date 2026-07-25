import type { AssistantPageContextType } from "@/lib/ai/page-context";
import type { UserRole } from "@/lib/rbac";

export const ASSISTANT_CUSTOMIZATION_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
] as const satisfies readonly UserRole[];

export type AssistantLauncherRoleSetting = {
  area: AssistantPageContextType;
  defaultEnabled: boolean;
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
