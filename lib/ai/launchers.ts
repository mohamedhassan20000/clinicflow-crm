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
  loadAssistantConversationForSurface,
  type StaffAssistantSurfaceAccess,
} from "@/lib/ai/surface";
import {
  assertDoctorPatientContextAccess,
  type LoadedDoctorConversation,
} from "@/lib/ai/conversations";
import type { PageSlug } from "@/lib/page-permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import { createClient } from "@/lib/supabase/server";
import { isAssistantPersistenceReady } from "@/lib/ai/persistence-readiness";

export type AssistantLauncherDefinition = {
  area: AssistantPageContextType;
  contextType: AssistantPageContextType;
  pageSlug: PageSlug;
  roles: readonly UserRole[];
  requiredFeatures: readonly string[];
  requiredUserPermission?: AiUserPermissionKey;
  defaultEnabled: boolean;
};

const ALL_STAFF: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
];

/** Code-owned defaults for the complete P4.8 launcher rollout. */
export const ASSISTANT_LAUNCHER_REGISTRY: readonly AssistantLauncherDefinition[] = [
  {
    area: "patient",
    contextType: "patient",
    pageSlug: "patients",
    roles: ["doctor"],
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "appointments",
    contextType: "appointments",
    pageSlug: "appointments",
    roles: ["admin", "receptionist", "doctor"],
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "dashboard",
    contextType: "dashboard",
    pageSlug: "dashboard",
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "revenue",
    contextType: "revenue",
    pageSlug: "revenue",
    roles: ["admin", "manager"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_FINANCIAL_INSIGHTS_FEATURE],
    requiredUserPermission: AI_FINANCIAL_INSIGHTS_PERMISSION,
    defaultEnabled: true,
  },
  {
    area: "reports",
    contextType: "reports",
    pageSlug: "reports",
    roles: ["admin", "manager", "receptionist"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "invoices",
    contextType: "invoices",
    pageSlug: "appointments",
    // The shipped invoice surface is the front-desk billing dialog. Of its
    // admin/receptionist hosts, only admins may hold financial AI access.
    roles: ["admin"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_FINANCIAL_INSIGHTS_FEATURE],
    requiredUserPermission: AI_FINANCIAL_INSIGHTS_PERMISSION,
    defaultEnabled: true,
  },
  {
    area: "staff",
    contextType: "staff",
    pageSlug: "settings",
    roles: ["admin", "manager"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "departments",
    contextType: "departments",
    pageSlug: "settings",
    roles: ["admin", "manager"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabled: true,
  },
  {
    area: "doctor-schedule",
    contextType: "doctor-schedule",
    pageSlug: "settings",
    roles: ["admin", "manager"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    defaultEnabled: true,
  },
];

export type AssistantLauncherResolution = {
  context: LaunchableAssistantPageContext;
  access: Extract<StaffAssistantSurfaceAccess, { state: "available" }>;
};

export type AssistantLauncherSessionResolution = AssistantLauncherResolution & {
  conversation: LoadedDoctorConversation | null;
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
    !definition.defaultEnabled ||
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
 */
export async function resolveAssistantLauncherSession(input: {
  user: AuthedUser;
  context: AssistantPageContext;
  locale?: PromptLocale;
}): Promise<AssistantLauncherSessionResolution | null> {
  const launcher = await resolveAssistantLauncher(input);
  if (!launcher) return null;

  try {
    const patientId = patientIdFromAssistantPageContext(launcher.context);
    if (patientId) {
      await assertDoctorPatientContextAccess({
        supabase: await createClient(),
        user: input.user,
        patientId,
      });
    }

    const [loaded, capabilities] = await Promise.all([
      loadAssistantConversationForSurface({ user: input.user, patientId }),
      launcher.context.type === "patient"
        ? Promise.resolve(null)
        : resolveAssistantCapabilities(input.user, input.locale ?? "en"),
    ]);
    if (!loaded.persistenceAvailable) return null;

    return {
      ...launcher,
      conversation: loaded.conversation,
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
