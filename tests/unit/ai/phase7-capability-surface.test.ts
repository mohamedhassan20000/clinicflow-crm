import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

/**
 * Phase 7 — the final capability surface (plan §15 P7 acceptance).
 *
 * "The capability panel reflects the new surface" is the phase's last acceptance
 * line, and it is a claim about honesty in both directions: the panel must not
 * advertise a capability the user does not have, and — the more dangerous
 * omission after five phases of write work — it must not stay silent about the
 * writes the assistant can now perform.
 *
 * The panel, the model-facing `list_my_capabilities`, and each active mount all
 * resolve from one registry pass, so this suite asserts the three agree and that
 * the tool list contains only the architecture the plan describes.
 */

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Role = "admin" | "manager" | "receptionist" | "doctor" | "assistant";

function actor(role: Role) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "surface@example.test",
    role,
    fullName: "Surface User",
    avatarUrl: null,
    clinicId: CLINIC,
    departmentId: null,
    mustChangePassword: false,
  };
}

const FULL_FEATURES: Record<string, boolean> = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  "ai.read_operational": true,
  "ai.read_clinical": true,
  "ai.write_scheduling": true,
  "ai.write_records": true,
  "ai.write_administration": true,
  "ai.write_privileged": true,
  "ai.documents": true,
  "ai.bulk_export": true,
};

async function load(role: Role) {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: "audit", error: null })),
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));
  vi.doMock("@/lib/server-report-permissions", () => ({
    getVisibleReportIds: vi.fn(async () => []),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: CLINIC,
      planSlug: "pro_ai",
      features: FULL_FEATURES,
      limits: {},
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    })),
    hasFeature: (
      entitlements: { features: Record<string, boolean> },
      key: string,
    ) => entitlements.features[key] === true,
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ai/permissions")>()),
    hasAiUserPermission: vi.fn(async () => true),
  }));

  const { resolveAssistantCapabilities } = await import("@/lib/ai/capabilities");
  return { capabilities: await resolveAssistantCapabilities(actor(role) as never) };
}

/**
 * Scope note (P7-01). Every assertion in this file is against
 * `resolveAssistantCapabilities` — it pins the *resolution*, not the render. The
 * rendered panel and the chat call site that passes `actions` into it are
 * asserted in `tests/unit/components/phase7-capability-panel.test.tsx`, and the
 * localized markup in `tests/e2e/p4b-assistant.spec.ts`. The two were separated
 * because this suite's describe name once claimed the panel while nothing
 * checked it.
 */
describe("Phase 7 · capability resolution reports reads and writes alike", () => {
  it("enumerates authorized actions with their risk class for an admin", async () => {
    const { capabilities } = await load("admin");

    expect(capabilities.actions.length).toBeGreaterThan(0);
    for (const action of capabilities.actions) {
      expect(action.id).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
      expect([
        "normal",
        "sensitive",
        "destructive",
        "bulk",
        "privileged",
      ]).toContain(action.risk);
    }
  });

  it("reports the same actions the executor would authorize, not a second list", async () => {
    // The panel must be derived from `describeAuthorizedActions`, which runs the
    // executor's own `assertActionAccess`. A drifted copy would advertise an
    // action the confirm step then refuses — the failure mode §18 names.
    const { capabilities } = await load("admin");
    const { describeAuthorizedActions } = await import(
      "@/lib/ai/actions/execute"
    );
    const authorized = await describeAuthorizedActions(actor("admin") as never);
    expect(capabilities.actions.map((action) => action.id).sort()).toEqual(
      authorized.map((definition) => definition.id).sort(),
    );
  });

  it("reports the doctor's and assistant's own write surface, not an empty one", async () => {
    // Final review B-2. This assertion previously read "offers no action to a
    // role the executor never authorizes" and pinned `actions: []` for both
    // roles. The panel was honest — it was reporting a mount defect, because
    // `execute_action` was hard-coded to the three administrative roles while
    // the action registry authorized 21 doctor actions and 22 assistant ones.
    // With the mount derived from the registry, the panel must now show each
    // role the surface the executor really authorizes for it.
    const { describeAuthorizedActions } = await import(
      "@/lib/ai/actions/execute"
    );
    for (const role of ["doctor", "assistant"] as const) {
      const { capabilities } = await load(role);
      expect(capabilities.toolNames, role).toContain("execute_action");
      expect(capabilities.toolNames, role).toContain("describe_action");
      expect(capabilities.actions.length, role).toBeGreaterThan(0);

      const authorized = await describeAuthorizedActions(actor(role) as never);
      expect(capabilities.actions.map((action) => action.id).sort(), role)
        .toEqual(authorized.map((definition) => definition.id).sort());
    }
  });

  it("keeps every advertised action inside what that role's definitions authorize", async () => {
    // The negative half of B-2: widening the mount must not widen authorization.
    // Every action a role is offered has to name that role in its own `roles`
    // list, and the administrative-only actions must stay out of the clinical
    // roles' sets — mounting the tool grants nothing on its own.
    const { AI_ACTION_REGISTRY } = await import("@/lib/ai/actions/registry");
    const byId = new Map(
      AI_ACTION_REGISTRY.map((action) => [action.id, action]),
    );
    const adminIds = new Set(
      (await load("admin")).capabilities.actions.map((action) => action.id),
    );

    for (const role of ["doctor", "assistant", "manager", "receptionist"] as const) {
      const { capabilities } = await load(role);
      const ids = capabilities.actions.map((action) => action.id);
      for (const id of ids) {
        expect(byId.get(id)?.roles, `${role} · ${id}`).toContain(role);
      }
      // A privileged staff mutation is admin-only and must never appear for a
      // clinical role however the tool mount is resolved.
      expect(ids, role).not.toContain("staff.change_role");
      if (role === "doctor" || role === "assistant") {
        // Admin-only actions stay admin-only. (The converse is *not* asserted:
        // `appointments.start_session` is legitimately doctor-only, mirroring
        // the domain core, so a clinical role's set is not a subset of the
        // admin's — it is its own.)
        expect(ids, role).not.toContain("assistant.reference_check");
        expect(ids, role).not.toContain("staff.permanent_delete");
        expect(ids.length, role).toBeGreaterThan(0);
        expect(ids.length, role).toBeLessThan(adminIds.size);
      }
    }
  });

  it("lists the generic read resources alongside the actions", async () => {
    const { capabilities } = await load("admin");
    const resourceIds = capabilities.resources.map((resource) => resource.id);
    expect(resourceIds).toContain("patients");
    expect(resourceIds).toContain("appointments");
    expect(resourceIds).toContain("medical_notes");
  });

  it("carries each action's registered risk class through to the panel unchanged", async () => {
    // The panel is where a user judges what they are about to allow, so a
    // privileged change must not arrive there labelled as an ordinary write.
    // The expected classes are read from the registry rather than guessed from
    // ids, so this checks the projection, not a naming convention.
    const { capabilities } = await load("admin");
    const { AI_ACTION_REGISTRY } = await import("@/lib/ai/actions/registry");
    const registryRisk = new Map(
      AI_ACTION_REGISTRY.map((definition) => [definition.id, definition.risk]),
    );

    for (const action of capabilities.actions) {
      expect(action.risk, action.id).toBe(registryRisk.get(action.id));
    }

    // And the §11.1 surface is genuinely present and genuinely marked.
    const privileged = AI_ACTION_REGISTRY.filter((definition) =>
      definition.requiredFeatures.includes("ai.write_privileged"),
    );
    expect(privileged.length).toBeGreaterThan(0);
    const panelById = new Map(
      capabilities.actions.map((action) => [action.id, action]),
    );
    for (const definition of privileged) {
      expect(definition.risk, definition.id).toBe("privileged");
      expect(panelById.get(definition.id)?.risk, definition.id).toBe(
        "privileged",
      );
    }
  });
});
