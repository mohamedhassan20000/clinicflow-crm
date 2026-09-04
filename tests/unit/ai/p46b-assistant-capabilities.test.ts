import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.6B — the surface half of the P4.6 phase.
//
// Two things are asserted here, and the split matters:
//
//  1. `resolveAssistantCapabilities` reports the *same* mount the model gets,
//     because it is derived from `resolveToolMount` rather than from a second
//     copy of the role matrix. A drifted copy would offer affordances for tools
//     the user does not have, or hide ones they do.
//  2. The financial absence is explained with the right cause. "Your plan does
//     not include this" and "your admin has not enabled this for you" need
//     different actions from different people; P4.6A kept the reason codes
//     distinct precisely so this layer could tell them apart (review I2).
//
// Capabilities are display data and never an authorization decision — every
// tool re-asserts role, entitlement, permission, and RLS inside execute(). The
// authorization matrix itself is owned by p46a-staff-analytics-tools.test.ts.

type Role = "admin" | "manager" | "receptionist" | "doctor";

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function user(role: Role) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: CLINIC,
    role,
    departmentId: null,
    fullName: "Test User",
  };
}

const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.read_clinical": true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
};

type LoadOptions = {
  features?: Record<string, boolean>;
  subscriptionAllowed?: boolean;
  financialPermission?: boolean | null;
  /** Force resolveToolMount to throw, to exercise the degrade path. */
  mountFails?: boolean;
  /** Force a specific mount, to reach states the real resolution rarely produces. */
  mountDefinitions?: string[];
};

async function loadCapabilities(actor: ReturnType<typeof user>, options: LoadOptions = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const captureException = vi.fn();

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException,
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: "audit-1", error: null })),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: actor.clinicId,
      planSlug: "pro_ai",
      features: options.features ?? PRO_AI_FEATURES,
      limits: {},
      subscriptionAllowed: options.subscriptionAllowed ?? true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));

  if (options.mountDefinitions) {
    const names = options.mountDefinitions;
    vi.doMock("@/lib/ai/tools", () => ({
      resolveToolMount: vi.fn(async () => ({
        definitions: names.map((name) => ({ name })),
        tools: {},
      })),
    }));
  }

  if (options.mountFails) {
    vi.doMock("@/lib/ai/tools", () => ({
      resolveToolMount: vi.fn(async () => {
        throw new Error("mount unavailable");
      }),
    }));
  }

  if (options.financialPermission !== undefined) {
    mocks.state.tableResults["user_ai_permissions"] =
      options.financialPermission === null
        ? { data: null, error: null }
        : { data: { granted: options.financialPermission }, error: null };
  }

  const { resolveAssistantCapabilities } = await import("@/lib/ai/capabilities");
  return {
    capabilities: await resolveAssistantCapabilities(actor as never),
    captureException,
  };
}

describe("P4.6B capability resolution", () => {
  it("reports the full operational, analytics, and financial surface for an entitled admin", async () => {
    const { capabilities } = await loadCapabilities(user("admin"));

    expect(capabilities.clinicAnalytics).toBe(true);
    expect(capabilities.operational).toBe(true);
    expect(capabilities.financial).toBe("available");
    expect(capabilities.toolNames).toContain("get_clinic_summary");
    expect(capabilities.toolNames).toContain("run_clinic_report");
    expect(capabilities.toolNames).toContain("get_revenue_summary");
  });

  it("matches the model's own mount rather than re-deriving the matrix", async () => {
    vi.resetModules();
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: true,
    });
    const { resolveToolMount } = await import("@/lib/ai/tools");
    const mount = await resolveToolMount({
      user: user("manager") as never,
      locale: "en",
    });

    expect([...capabilities.toolNames].sort()).toEqual(
      mount.definitions.map((definition) => definition.name).sort(),
    );
  });

  it("tells a manager without the grant to ask an admin, not to upgrade", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: null,
    });

    expect(capabilities.financial).toBe("not_granted");
    // The rest of the surface is unaffected by the financial grant.
    expect(capabilities.operational).toBe(true);
    expect(capabilities.clinicAnalytics).toBe(true);
    expect(capabilities.allowedReportIds).toEqual([
      "cancellations",
      "no_shows",
      "followups",
      "doctor_performance",
      "receptionist_performance",
    ]);
  });

  it("treats an explicitly revoked grant as not_granted", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: false,
    });
    expect(capabilities.financial).toBe("not_granted");
  });

  it("derives the exact role × report × financial-grant matrix from the shared policy", async () => {
    const admin = await loadCapabilities(user("admin"));
    const manager = await loadCapabilities(user("manager"), {
      financialPermission: true,
    });
    const receptionist = await loadCapabilities(user("receptionist"));

    expect(admin.capabilities.allowedReportIds).toEqual([
      "cancellations",
      "no_shows",
      "revenue",
      "followups",
      "doctor_performance",
      "receptionist_performance",
    ]);
    expect(manager.capabilities.allowedReportIds).toEqual([
      "cancellations",
      "no_shows",
      "revenue",
      "followups",
      "doctor_performance",
      "receptionist_performance",
    ]);
    expect(receptionist.capabilities.allowedReportIds).toEqual([
      "cancellations",
      "no_shows",
      "followups",
    ]);
  });

  it("tells a manager on a plan without financial AI to upgrade, not to ask an admin", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      features: { ...PRO_AI_FEATURES, "ai.financial_insights": false },
      financialPermission: true,
    });

    expect(capabilities.financial).toBe("not_entitled");
  });

  it("offers receptionists the operational surface and no financial story at all", async () => {
    const { capabilities } = await loadCapabilities(user("receptionist"));

    expect(capabilities.operational).toBe(true);
    expect(capabilities.toolNames).toContain("query_resource");
    expect(capabilities.toolNames).toContain("list_pending_followups");
    // The clinic-wide attribute distributions are a different privacy class and
    // are not mounted for receptionists (P4.6A matrix deviation 3).
    expect(capabilities.clinicAnalytics).toBe(false);
    expect(capabilities.toolNames).not.toContain("get_patient_stats");
    // Never grantable for this role, so never mentioned.
    expect(capabilities.financial).toBe("not_applicable");
  });

  it("includes pending follow-ups for managers, matching the dashboard RPC", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: true,
    });
    expect(capabilities.toolNames).toContain("list_pending_followups");
  });

  it("gives doctors no clinic analytics and no financial story", async () => {
    const { capabilities } = await loadCapabilities(user("doctor"));

    expect(capabilities.clinicAnalytics).toBe(false);
    expect(capabilities.operational).toBe(true);
    expect(capabilities.financial).toBe("not_applicable");
    expect(capabilities.toolNames).toContain("get_record");
  });

  it("drops the whole analytics surface when the clinic has no ai.staff_analytics", async () => {
    const { capabilities } = await loadCapabilities(user("admin"), {
      features: { ai_assistant: true, "ai.staff_assistant": true },
    });

    expect(capabilities.clinicAnalytics).toBe(false);
    expect(capabilities.operational).toBe(true);
    expect(capabilities.financial).toBe("not_entitled");
    // The P4 tools survive: losing analytics is not losing the assistant.
    expect(capabilities.toolNames).toContain("search_authorized_patients");
  });

  it("degrades to no affordances rather than breaking the chat when resolution fails", async () => {
    const { capabilities, captureException } = await loadCapabilities(user("admin"), {
      mountFails: true,
    });

    expect(capabilities.toolNames).toEqual([]);
    expect(capabilities.operational).toBe(false);
    expect(capabilities.financial).toBe("not_applicable");
    expect(captureException).toHaveBeenCalled();
  });
});

/**
 * L4 of the P4.6 phase review. When the role is financial-capable, both
 * entitlements pass, and the grant is present, yet no financial tool mounted,
 * the function used to answer "not_entitled" — telling the user their plan was
 * the problem when it was not. The comment justifying it argued the surface
 * gate would report the real cause, but `resolveStaffAssistantPage` only
 * resolves capabilities once access is already "available", so the surface gate
 * has by definition passed and will report nothing. That sends the user to
 * their reseller for a problem their reseller cannot see.
 */
describe("P4.6B financial absence is attributed to the right cause", () => {
  it("does not blame the plan when the plan and the grant are both fine", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: true,
      mountDefinitions: ["search_authorized_patients"],
    });

    expect(capabilities.financial).toBe("unavailable");
  });

  it("still blames the grant when the grant is genuinely off", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      financialPermission: false,
      mountDefinitions: ["search_authorized_patients"],
    });

    expect(capabilities.financial).toBe("not_granted");
  });

  it("still blames the plan when the entitlement is genuinely absent", async () => {
    const { capabilities } = await loadCapabilities(user("manager"), {
      features: {
        ai_assistant: true,
        "ai.staff_assistant": true,
        "ai.staff_analytics": true,
        "ai.financial_insights": false,
      },
      financialPermission: true,
      mountDefinitions: ["search_authorized_patients"],
    });

    expect(capabilities.financial).toBe("not_entitled");
  });
});
