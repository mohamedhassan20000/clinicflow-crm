/**
 * Per-user AI permission keys.
 *
 * Deliberately in its own dependency-free module rather than in
 * `lib/ai/permissions.ts`: that module is `server-only` (it reads the database),
 * but the admin settings panel is a client component and must name the same key
 * it is toggling. Splitting the vocabulary from the resolution lets both sides
 * share one constant instead of two string literals that agree by convention.
 *
 * These keys are a *different namespace* from the plan-entitlement feature keys
 * in `lib/ai/authorization.ts`, even where the literal is identical. A
 * permission is an admin-granted row in `user_ai_permissions`; a feature is a
 * property of the clinic's plan. They are resolved by different authorities and
 * answer different questions, and the type is what keeps a caller from reaching
 * for the wrong one.
 */
export const AI_USER_PERMISSION_KEYS = ["ai.financial_insights"] as const;
export type AiUserPermissionKey = (typeof AI_USER_PERMISSION_KEYS)[number];

export const AI_FINANCIAL_INSIGHTS_PERMISSION: AiUserPermissionKey =
  "ai.financial_insights";

export function isAiUserPermissionKey(value: string): value is AiUserPermissionKey {
  return (AI_USER_PERMISSION_KEYS as readonly string[]).includes(value);
}
