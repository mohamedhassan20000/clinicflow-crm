import "server-only";

import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { hasAiUserPermission } from "@/lib/ai/permissions";
import {
  appointmentsResource,
  departmentsResource,
  documentsResource,
  followUpsResource,
  insuranceProvidersResource,
  labRequestsResource,
  medicalNotesResource,
  patientPackagesResource,
  patientsResource,
  prescriptionsResource,
  profilesResource,
  servicesResource,
  sickLeavesResource,
} from "@/lib/ai/resources/definitions";
import type { AuthedUser } from "@/lib/rbac";
import type { ResourceDefinition, ResourceId } from "@/lib/ai/resources/types";

export const RESOURCE_REGISTRY = [
  patientsResource,
  appointmentsResource,
  departmentsResource,
  servicesResource,
  profilesResource,
  followUpsResource,
  documentsResource,
  insuranceProvidersResource,
  medicalNotesResource,
  prescriptionsResource,
  labRequestsResource,
  sickLeavesResource,
  patientPackagesResource,
] as const satisfies readonly ResourceDefinition[];

export const RESOURCE_REGISTRY_BY_ID = new Map<ResourceId, ResourceDefinition>(
  RESOURCE_REGISTRY.map((definition) => [definition.id, definition]),
);

if (RESOURCE_REGISTRY_BY_ID.size !== RESOURCE_REGISTRY.length) {
  throw new Error("Duplicate AI resource id.");
}

export function getResourceDefinition(id: string): ResourceDefinition | null {
  return RESOURCE_REGISTRY_BY_ID.get(id as ResourceId) ?? null;
}

export async function assertResourceAccess(
  user: AuthedUser,
  definition: ResourceDefinition,
): Promise<void> {
  await assertStaffToolAccess(user);
  if (!definition.roles.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not read resource "${definition.id}".`,
    );
  }

  const entitlements = await getEntitlements(user.clinicId);
  if (
    !definition.requiredFeatures.every((feature) =>
      hasFeature(entitlements, feature),
    )
  ) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
  if (
    definition.requiredUserPermission &&
    !(await hasAiUserPermission(user, definition.requiredUserPermission))
  ) {
    throw new AiToolAuthorizationError("permission_not_granted");
  }
}

/** Permission-filtered discovery over the same declarations execution uses. */
export async function resolveAuthorizedResources(
  user: AuthedUser,
): Promise<ResourceDefinition[]> {
  await assertStaffToolAccess(user);
  const entitlements = await getEntitlements(user.clinicId);
  const roleAndFeatureAllowed = RESOURCE_REGISTRY.filter(
    (definition) =>
      definition.roles.includes(user.role) &&
      definition.requiredFeatures.every((feature) =>
        hasFeature(entitlements, feature),
      ),
  );

  return (
    await Promise.all(
      roleAndFeatureAllowed.map(async (definition) =>
        !definition.requiredUserPermission ||
        (await hasAiUserPermission(user, definition.requiredUserPermission))
          ? definition
          : null,
      ),
    )
  ).filter((definition): definition is ResourceDefinition => definition !== null);
}

export type { ResourceDefinition, ResourceId } from "@/lib/ai/resources/types";
