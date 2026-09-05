import "server-only";

import type { AuthedUser } from "@/lib/rbac";
import type { FieldSpec } from "@/lib/ai/resources/types";

export function field(
  column: string,
  type: FieldSpec["type"],
  sensitivity: FieldSpec["sensitivity"],
  description: string,
  options: Pick<FieldSpec, "roles" | "maxListRows"> = {},
): FieldSpec {
  return { column, type, sensitivity, description, ...options };
}

/**
 * Phase 1 default: every declared field is readable by every role admitted by
 * the resource. Narrowing belongs only in the declaration and must be explicit.
 */
export function declaredFieldPolicy(
  fields: Readonly<Record<string, FieldSpec>>,
): (user: AuthedUser) => readonly string[] {
  return (user) =>
    Object.entries(fields)
      .filter(([, spec]) => !spec.roles || spec.roles.includes(user.role))
      .map(([name]) => name);
}
