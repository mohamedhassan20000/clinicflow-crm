import "server-only";

import type { Tool } from "ai";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  hasAiUserPermission,
  type AiUserPermissionKey,
} from "@/lib/ai/permissions";
import { logAgentTool } from "@/lib/ai/audit";
import {
  AiToolAuthorizationError,
  type AiToolDenialReason,
} from "@/lib/ai/errors";
import { AI_TOOL_REGISTRY, type AiToolDefinition } from "@/lib/ai/tools/registry";
import { sanitizeUntrustedDeep, withProvenance } from "@/lib/ai/untrusted-text";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import type { UserRole } from "@/lib/rbac";

export type { DoctorToolContext } from "@/lib/ai/tools/context";
export { AI_TOOL_REGISTRY, AI_TOOL_REGISTRY_BY_NAME } from "@/lib/ai/tools/registry";
export type { AiToolDefinition } from "@/lib/ai/tools/registry";

/**
 * Certified staff task classes that can be selected for each role.
 *
 * This mapping defines the scope of an unscoped mount: it is the authorized
 * union across task classes the router can actually select for that role. It is
 * not a second tool matrix. Every tool still comes from `AI_TOOL_REGISTRY` and
 * must intersect one of these classes plus pass role, entitlement, and
 * permission checks.
 */
export const STAFF_TASK_CLASSES_BY_ROLE = {
  admin: ["staff_administrative", "staff_operational_query", "staff_composite", "staff_help"],
  manager: ["staff_administrative", "staff_operational_query", "staff_composite", "staff_help"],
  receptionist: ["staff_administrative", "staff_operational_query", "staff_composite", "staff_help"],
  doctor: ["staff_clinical_summary", "staff_composite", "staff_help"],
  // Assistant mirrors the doctor's clinical scope; RLS + auth_supervised_doctor_ids
  // restrict every tool to the assigned doctors' data (never clinic-wide).
  assistant: ["staff_clinical_summary", "staff_composite", "staff_help"],
} as const satisfies Record<UserRole, readonly AiTaskClass[]>;

export function staffTaskClassesForRole(role: UserRole): readonly AiTaskClass[] {
  return STAFF_TASK_CLASSES_BY_ROLE[role];
}

/**
 * Generic, deny-by-default resolution of the tools a caller may use (P4.6A).
 *
 * Replaces the hand-assembled per-role tool objects: every mount decision now
 * comes from registry metadata, so the model's tool array, the P4.7 capability
 * panel, and the authorization tests all read the same declarations. A tool is
 * mounted only when all three gates pass — role, every required plan feature,
 * and any required admin-granted per-user permission.
 *
 * Non-mounting is the primary defense at the model boundary: an unauthorized
 * tool does not exist in the model's world, so it cannot be called, described,
 * or coaxed out by prompt injection. Each tool then re-asserts the same checks
 * inside execute(), which is what makes a registry mistake non-exploitable.
 */
export async function resolveToolMount(
  ctx: DoctorToolContext,
): Promise<{
  definitions: AiToolDefinition[];
  tools: Record<string, Tool>;
  grantedPermissions: ReadonlySet<AiUserPermissionKey>;
}> {
  const entitlements = await getEntitlements(ctx.user.clinicId);
  const supportedTaskClasses = staffTaskClassesForRole(ctx.user.role);
  const activeTaskClasses: readonly AiTaskClass[] = ctx.taskClass
    ? supportedTaskClasses.includes(ctx.taskClass)
      ? [ctx.taskClass]
      : []
    : supportedTaskClasses;

  const featureAndRoleAllowed = (definition: AiToolDefinition) =>
    definition.roles.includes(ctx.user.role) &&
    definition.requiredFeatures.every((feature) =>
      hasFeature(entitlements, feature),
    );

  const candidates = AI_TOOL_REGISTRY.filter(
    (definition) =>
      featureAndRoleAllowed(definition) &&
      // Routing selects only policy/budget. The explicit help route is the
      // sole containment boundary; every other turn sees the caller's full
      // role/feature/permission-authorized union.
      //
      // **Do not "tighten" this into `definition.taskClasses.includes(active)`.**
      // No tool in `AI_TOOL_REGISTRY` declares `staff_composite`, so a strict
      // gate would mount *zero* tools for every composite turn — a silent,
      // total capability loss. The permissiveness is the design (see the note at
      // `staff-agent.ts`), and it is pinned by the composite-mount invariant in
      // `tests/unit/ai/action-routing.test.ts` so the mistake fails loudly.
      (ctx.taskClass === "staff_help"
        ? definition.taskClasses.includes("staff_help")
        : activeTaskClasses.length > 0),
  );

  // Permission lookups hit the database, so resolve each distinct key once.
  //
  // The key set is the union of what candidates require to mount *and* what
  // they declare their description depends on — `run_clinic_report` enumerates
  // the reports the caller may run, and `revenue` is grant-gated even though
  // the tool is not. Declared rather than "resolve every key always", so a
  // doctor's mount issues no financial-permission read at all.
  const permissionKeys = new Set<AiUserPermissionKey>();
  for (const definition of candidates) {
    if (definition.requiredUserPermission) {
      permissionKeys.add(definition.requiredUserPermission);
    }
    for (const key of definition.describedByUserPermissions ?? []) {
      permissionKeys.add(key);
    }
  }
  const permissions = new Map<AiUserPermissionKey, boolean>();
  await Promise.all(
    [...permissionKeys].map(async (key) => {
      permissions.set(key, await hasAiUserPermission(ctx.user, key));
    }),
  );

  const definitions = candidates.filter(
    (definition) =>
      !definition.requiredUserPermission ||
      permissions.get(definition.requiredUserPermission) === true,
  );

  const grantedPermissions: ReadonlySet<AiUserPermissionKey> = new Set(
    [...permissionKeys].filter((key) => permissions.get(key) === true),
  );
  const tools: Record<string, Tool> = {};
  const buildContext: DoctorToolContext = {
    ...ctx,
    grantedPermissions,
  };
  for (const definition of definitions) {
    tools[definition.name] = harden(definition.name, buildContext, definition.build(buildContext));
  }
  return {
    definitions,
    tools,
    grantedPermissions,
  };
}

/**
 * Wraps a built tool so every result passes through untrusted-text
 * neutralization on its way into model context.
 *
 * This lives at the mount boundary rather than inside each tool on purpose.
 * P4.6A is what first carries tenant-authored strings — patient names,
 * department names, follow-up outcomes — from the database into the
 * conversation, which makes stored prompt injection reachable as soon as P4.6B
 * mounts these tools. A per-tool convention would be one forgotten call away
 * from a hole; doing it here means every current tool, and every tool P4.6B and
 * later add, is covered by construction.
 *
 * It sanitizes tool *output* only. Inputs are already constrained by each
 * tool's zod schema, and authorization is unchanged: an injected instruction
 * can still only reach tools the caller was authorized for, over the caller's
 * own clinic. See `lib/ai/untrusted-text.ts` for the full threat model.
 */
function harden(name: string, ctx: DoctorToolContext, builtTool: Tool): Tool {
  const execute = builtTool.execute;
  if (typeof execute !== "function") return builtTool;

  return {
    ...builtTool,
    execute: async (...args: Parameters<typeof execute>) => {
      let result: unknown;
      let audited = false;
      try {
        result = await execute(...args);
      } catch (error) {
        if (error instanceof AiToolAuthorizationError) {
          await auditOutcome(name, ctx, { outcome: "denied", reason: error.reason });
          // Returned, not rethrown — see DENIAL_GUIDANCE. Falls through to the
          // sanitize/provenance tail so a denial is shaped exactly like any
          // other result.
          result = denialResult(error);
          audited = true;
        } else {
          await auditOutcome(name, ctx, { outcome: "error", reason: "tool_error" });
          // A genuine internal failure — a failed database read, a bug. It is
          // not a state the user can act on and must not be dressed up as one,
          // so it keeps throwing. `ToolActivity` renders the resulting
          // `tool-output-error` part with generic localized copy.
          throw error;
        }
      }

      const payload =
        // Tool results are always objects today; wrap defensively so a scalar
        // result cannot break the provenance marker.
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };

      if (!audited) await auditOutcome(name, ctx, outcomeOf(payload));

      const truncatedFields: string[] = [];
      const sanitized = sanitizeUntrustedDeep(payload, {
        onTruncate: (path) => truncatedFields.push(path),
      });
      // Truncation used to be silent: the string got an ellipsis, but nothing in
      // the honesty-signal pipeline knew it happened, so a report the user can
      // open in full could be summarized from a clipped value with no caveat.
      if (truncatedFields.length > 0) {
        sanitized.text_truncated_fields = truncatedFields;
      }
      return withProvenance(sanitized);
    },
  } as Tool;
}

/**
 * What the *model* should do about each denial, in the model's own working
 * language (English — the system prompt handles the user-facing locale, and the
 * UI renders its own localized notice from `reason` rather than from this text).
 *
 * Every reason is enumerated rather than defaulted, so adding a denial reason is
 * a compile error here instead of a silent fall-through to a vague sentence.
 * That is the same argument `ERROR_COPY_KEYS` makes on the client, applied to
 * the half of the pair the model reads.
 */
const DENIAL_GUIDANCE: Record<AiToolDenialReason, string> = {
  permission_not_granted:
    "This user is not enabled for this data. Tell them it requires their clinic administrator to grant them access in Settings → AI. Do not retry, do not try a related tool, and do not estimate or infer any figure you could not read.",
  feature_not_entitled:
    "This clinic's plan does not include this capability. Tell the user it is not part of their current plan. Do not retry, do not try a related tool, and do not estimate or infer any figure you could not read.",
  subscription_inactive:
    "The clinic's subscription is inactive, so this data is unavailable. Tell the user to contact their clinic administrator about the subscription. Do not retry and do not infer any figure.",
  page_hidden:
    "This user's access to the underlying section has been turned off for them. Tell them their clinic administrator controls this in the permissions settings. Do not retry and do not infer any figure.",
  usage_limit_reached:
    "The clinic has reached its monthly assistant limit. Tell the user no further tools can run until the limit resets. Do not retry.",
  role_forbidden:
    "This user's role may not use this tool. Tell them plainly that it is not available for their role, and do not offer it again in this conversation. Do not retry and do not infer any figure.",
  unauthenticated:
    "The session could not be verified. Ask the user to reload the page and sign in again. Do not retry.",
  lookup_failed:
    "The permission check itself could not be completed, so access was refused to be safe. Tell the user this is temporary and ask them to try again shortly. Do not infer any figure you could not read.",
  unauthorized_scope:
    "That record is not in the data this user is authorized to see. Do not distinguish between a missing record and one outside scope, do not retry, and do not infer any field.",
};

/**
 * Turns a thrown authorization denial into a structured tool result.
 *
 * Phase review #2, H2. A tool that throws mid-stream reaches the client as a
 * `tool-output-error` part whose only payload is a string — no structure, no
 * localizable reason, and the raw code is fed back into the model as the tool's
 * error text, which the model then paraphrases from an untranslated internal
 * identifier. Review #1 fixed exactly this for `run_clinic_report`'s financial
 * denial by returning a result instead of throwing; the fix was right and its
 * scope was one tool.
 *
 * It is applied at the mount boundary instead, for the reason M3 of the audit
 * placement gave: a per-tool convention is one forgotten call away from a gap,
 * and every one of the fifteen tools can raise `page_hidden`,
 * `subscription_inactive`, or `usage_limit_reached` mid-turn when an admin
 * changes something while a session is open.
 *
 * Only `AiToolAuthorizationError` is converted. A denial is a *state* — the user
 * can act on it and the answer is stable across retries. An unexpected failure
 * is not, and dressing one up as a user state would hide a bug behind a polite
 * sentence, so those still throw.
 */
function denialResult(error: AiToolAuthorizationError) {
  return {
    permission_denied: true as const,
    reason: error.reason,
    guidance: DENIAL_GUIDANCE[error.reason],
  };
}

/**
 * Classifies a tool result for the audit ledger.
 *
 * §1073/§1074 require "an audit event written per invocation". Each tool logs
 * its own success (with the redacted parameters only it knows), but the three
 * non-success classes — denials, clarifications, and query errors — all return
 * or throw before that call, so they left no trace at all. Denials in
 * particular are exactly the question an audit ledger exists to answer, and the
 * financial gate is this phase's headline control.
 *
 * Logging here rather than in each tool means the coverage cannot be forgotten
 * by a future tool, and it is the only place that sees every outcome.
 */
function outcomeOf(payload: Record<string, unknown>): {
  outcome: string;
  reason: string | null;
} {
  if (payload.needs_clarification === true) {
    return {
      outcome: "clarification",
      reason: typeof payload.field === "string" ? payload.field : null,
    };
  }
  if (payload.permission_denied === true) {
    return {
      outcome: "denied",
      reason: typeof payload.reason === "string" ? payload.reason : null,
    };
  }
  return { outcome: "success", reason: null };
}

async function auditOutcome(
  name: string,
  ctx: DoctorToolContext,
  { outcome, reason }: { outcome: string; reason: string | null },
) {
  // The success path is already audited by the tool itself, with the redacted
  // parameter detail this wrapper cannot see. Logging it again here would
  // double every successful row.
  if (outcome === "success") return;
  await logAgentTool({
    clinicId: ctx.user.clinicId,
    actorId: ctx.user.id,
    tool: name,
    tableName: null,
    params: { outcome, reason },
  });
}

/** Role-specific, deny-by-default registration at the model boundary. */
export async function buildStaffTools(
  ctx: DoctorToolContext,
): Promise<Record<string, Tool>> {
  return (await resolveToolMount(ctx)).tools;
}

/**
 * Backwards-compatible entry point for the doctor surface. The doctor persona's
 * mount is now derived from the same registry, so it can no longer drift from
 * the staff resolution.
 */
export async function buildDoctorTools(
  ctx: DoctorToolContext,
): Promise<Record<string, Tool>> {
  return buildStaffTools(ctx);
}

/**
 * The names a role could mount if fully entitled — metadata only, never an
 * authorization decision. Useful for capability copy and tests.
 */
export function toolNamesForRole(role: DoctorToolContext["user"]["role"]): string[] {
  return AI_TOOL_REGISTRY.filter((definition) => definition.roles.includes(role)).map(
    (definition) => definition.name,
  );
}

export const DOCTOR_TOOL_NAMES = toolNamesForRole("doctor");
