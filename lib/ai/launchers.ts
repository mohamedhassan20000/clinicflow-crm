import "server-only";

import * as Sentry from "@sentry/nextjs";
import {
  AI_ASSISTANT_FEATURE,
  AI_FINANCIAL_INSIGHTS_FEATURE,
  AI_STAFF_ANALYTICS_FEATURE,
} from "@/lib/ai/authorization";
import {
  resolveAssistantCapabilities,
  type AssistantCapabilities,
} from "@/lib/ai/capabilities";
import type { AiUserPermissionKey } from "@/lib/ai/permission-keys";
import { hasAiUserPermission } from "@/lib/ai/permissions";
import {
  parseAssistantPageContext,
  patientIdFromAssistantPageContext,
  type AssistantPageContext,
  type AssistantPageContextType,
  type LaunchableAssistantPageContext,
} from "@/lib/ai/page-context";
import { AI_FINANCIAL_INSIGHTS_PERMISSION } from "@/lib/ai/permission-keys";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import {
  getStaffAssistantSurfaceAccess,
  type StaffAssistantSurfaceAccess,
} from "@/lib/ai/surface";
import { assertDoctorPatientContextAccess } from "@/lib/ai/conversations";
import { applyProposals, type ActiveContext } from "@/lib/ai/conversation-context";
import { resolvePageContextSeed } from "@/lib/ai/page-context-seed";
import type { PageSlug } from "@/lib/page-permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import { createClient } from "@/lib/supabase/server";
import { isAssistantPersistenceReady } from "@/lib/ai/persistence-readiness";
import { resolveAssistantLauncherPlacement } from "@/lib/ai/launcher-placement";

export type AssistantLauncherDefinition = {
  area: AssistantPageContextType;
  contextType: AssistantPageContextType;
  pageSlug: PageSlug;
  /**
   * Roles for which placement is *supported* in this area (a toggle is shown).
   * Derived from the keys of `defaultEnabledByRole`. Roles outside this set are
   * fundamentally unsupported and render a disabled placeholder in the settings
   * matrix. Being supported is not authorization — resolution still re-checks
   * role, features, permission, and page visibility.
   */
  roles: readonly UserRole[];
  requiredFeatures: readonly string[];
  requiredUserPermission?: AiUserPermissionKey;
  /**
   * Per-role product default. Current shipped combinations stay enabled;
   * newly-introduced combinations (assistant everywhere it is supported, and
   * manager on Appointments) default OFF so behavior does not change until an
   * admin turns them on. A "Reset to Product Defaults" restores exactly this map.
   */
  defaultEnabledByRole: Partial<Record<UserRole, boolean>>;
};

type RoleDefaults = Partial<Record<UserRole, boolean>>;

/** Builds a definition, deriving `roles` from the default map's keys. */
function launcher(
  def: Omit<AssistantLauncherDefinition, "roles" | "defaultEnabledByRole"> & {
    defaultEnabledByRole: RoleDefaults;
  },
): AssistantLauncherDefinition {
  return {
    ...def,
    roles: Object.keys(def.defaultEnabledByRole) as UserRole[],
  };
}

/** Code-owned defaults for the complete launcher rollout (single source). */
export const ASSISTANT_LAUNCHER_REGISTRY: readonly AssistantLauncherDefinition[] = [
  launcher({
    area: "patient",
    contextType: "patient",
    pageSlug: "patients",
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    // Assistant added (clinical patient context, scoped) — default OFF.
    defaultEnabledByRole: { doctor: true, assistant: false },
  }),
  launcher({
    area: "appointments",
    contextType: "appointments",
    pageSlug: "appointments",
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    // Manager + assistant are new supported combinations — default OFF.
    defaultEnabledByRole: {
      admin: true,
      receptionist: true,
      doctor: true,
      manager: false,
      assistant: false,
    },
  }),
  launcher({
    area: "dashboard",
    contextType: "dashboard",
    pageSlug: "dashboard",
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    // Assistant is new — default OFF; the four existing staff roles stay ON.
    defaultEnabledByRole: {
      admin: true,
      manager: true,
      receptionist: true,
      doctor: true,
      assistant: false,
    },
  }),
  launcher({
    area: "revenue",
    contextType: "revenue",
    pageSlug: "revenue",
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_FINANCIAL_INSIGHTS_FEATURE],
    requiredUserPermission: AI_FINANCIAL_INSIGHTS_PERMISSION,
    // Financial: only admin/manager are supported at all.
    defaultEnabledByRole: { admin: true, manager: true },
  }),
  launcher({
    area: "reports",
    contextType: "reports",
    pageSlug: "reports",
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    // Doctor + assistant now have a (scoped) Reports page — supported, default OFF.
    defaultEnabledByRole: {
      admin: true,
      manager: true,
      receptionist: true,
      doctor: false,
      assistant: false,
    },
  }),
  launcher({
    area: "invoices",
    contextType: "invoices",
    pageSlug: "appointments",
    // The shipped invoice surface is the front-desk billing dialog. Of its
    // admin/receptionist hosts, only admins may hold financial AI access.
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_FINANCIAL_INSIGHTS_FEATURE],
    requiredUserPermission: AI_FINANCIAL_INSIGHTS_PERMISSION,
    defaultEnabledByRole: { admin: true },
  }),
  launcher({
    area: "staff",
    contextType: "staff",
    pageSlug: "settings",
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabledByRole: { admin: true, manager: true },
  }),
  launcher({
    area: "departments",
    contextType: "departments",
    pageSlug: "settings",
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabledByRole: { admin: true, manager: true },
  }),
  launcher({
    area: "doctor-schedule",
    contextType: "doctor-schedule",
    pageSlug: "settings",
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabledByRole: { admin: true, manager: true },
  }),
];

/** The product-default placement for one area and role (false if unsupported). */
export function launcherDefaultEnabled(
  definition: AssistantLauncherDefinition,
  role: UserRole,
): boolean {
  return definition.defaultEnabledByRole[role] ?? false;
}

export type AssistantLauncherResolution = {
  context: LaunchableAssistantPageContext;
  access: Extract<StaffAssistantSurfaceAccess, { state: "available" }>;
};

export type AssistantLauncherSessionResolution = AssistantLauncherResolution & {
  /**
   * Server-derived active context for the *new* conversation the launcher
   * starts. Post-plan completion: a launcher no longer resumes the caller's
   * latest conversation, so the record on screen is carried into the fresh one
   * as ordinary `page_context` slots (see `lib/ai/page-context-seed.ts`).
   */
  seededActiveContext: ActiveContext;
  capabilities: AssistantCapabilities | null;
};

function definitionFor(
  context: AssistantPageContext,
): AssistantLauncherDefinition | null {
  return (
    ASSISTANT_LAUNCHER_REGISTRY.find(
      (definition) =>
        definition.area === context.type &&
        definition.contextType === context.type,
    ) ?? null
  );
}

/**
 * Resolves visibility from server-owned identity, entitlement, persisted page
 * visibility, usage, and (where declared) per-user permission. It grants no
 * data access: the chat route and every tool independently repeat their own
 * authorization checks.
 */
export async function resolveAssistantLauncherDefinition(input: {
  user: AuthedUser;
  context: AssistantPageContext;
  definition: AssistantLauncherDefinition;
}): Promise<AssistantLauncherResolution | null> {
  const context = parseAssistantPageContext(input.context);
  if (!context) return null;

  const { definition } = input;
  if (
    definition.area !== context.type ||
    definition.contextType !== context.type ||
    !definition.roles.includes(input.user.role)
  ) {
    return null;
  }

  try {
    const [assistantVisibility, sourceVisibility] = await Promise.all([
      getPageVisibilityState(input.user, "assistant"),
      getPageVisibilityState(input.user, definition.pageSlug),
    ]);
    if (assistantVisibility !== "visible" || sourceVisibility !== "visible") {
      return null;
    }

    if (
      !(await resolveAssistantLauncherPlacement({
        user: input.user,
        area: definition.area,
        defaultEnabled: launcherDefaultEnabled(definition, input.user.role),
      }))
    ) {
      return null;
    }

    const access = await getStaffAssistantSurfaceAccess(
      input.user,
      definition.requiredFeatures,
    );
    if (access.state !== "available") return null;

    if (
      definition.requiredUserPermission &&
      !(await hasAiUserPermission(input.user, definition.requiredUserPermission))
    ) {
      return null;
    }

    // Missing optional Assistant persistence must omit contextual launchers at
    // page render. The cached probe reads no history and keeps the host page
    // fail-soft, preserving the roadmap's patient-record failure contract.
    if (!(await isAssistantPersistenceReady())) return null;

    return {
      context,
      access,
    };
  } catch (error) {
    // Launchers are optional page enhancements. Never let an AI dependency
    // reject the independently authorized page, and never attach entity ids to
    // telemetry when reporting the failure.
    Sentry.captureException(error, {
      tags: { area: "assistant-launcher", launcherArea: context.type },
      extra: { clinicId: input.user.clinicId, role: input.user.role },
    });
    return null;
  }
}

export async function resolveAssistantLauncher(input: {
  user: AuthedUser;
  context: AssistantPageContext;
}): Promise<AssistantLauncherResolution | null> {
  const context = parseAssistantPageContext(input.context);
  if (!context) return null;
  const definition = definitionFor(context);
  if (!definition) return null;
  return resolveAssistantLauncherDefinition({ ...input, context, definition });
}

/**
 * Hydrates the expensive launcher session only after the client opens its
 * Sheet. The lightweight launcher gate is repeated here because the browser
 * request is a new authorization boundary and permissions may have changed
 * since the page rendered.
 *
 * Post-plan completion: this used to return the caller's *latest* conversation,
 * which meant a contextual launcher silently continued whatever chat happened to
 * be most recent — including, for every non-patient area, the very same
 * conversation `/assistant` was showing. It now starts a fresh conversation
 * seeded with the server-derived context of the record on screen, and the
 * shortcut UI reaches past conversations through the shared history actions
 * rather than by being implicitly pointed at one.
 */
export async function resolveAssistantLauncherSession(input: {
  user: AuthedUser;
  context: AssistantPageContext;
  locale?: PromptLocale;
}): Promise<AssistantLauncherSessionResolution | null> {
  const launcher = await resolveAssistantLauncher(input);
  if (!launcher) return null;

  try {
    const supabase = await createClient();
    const patientId = patientIdFromAssistantPageContext(launcher.context);
    if (patientId) {
      await assertDoctorPatientContextAccess({
        supabase,
        user: input.user,
        patientId,
      });
    }

    const locale = input.locale ?? "en";
    const [seed, capabilities] = await Promise.all([
      resolvePageContextSeed({
        supabase,
        user: input.user,
        context: launcher.context,
        locale,
      }),
      launcher.context.type === "patient"
        ? Promise.resolve(null)
        : resolveAssistantCapabilities(input.user, locale),
    ]);

    return {
      ...launcher,
      seededActiveContext: applyProposals({}, seed),
      capabilities,
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: "assistant-launcher-session",
        launcherArea: launcher.context.type,
      },
      extra: { clinicId: input.user.clinicId, role: input.user.role },
    });
    return null;
  }
}
