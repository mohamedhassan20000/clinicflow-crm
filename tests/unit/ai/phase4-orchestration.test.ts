import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ getEntitlements: vi.fn(), hasFeature: vi.fn(), hasPermission: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ getEntitlements: mocks.getEntitlements, hasFeature: mocks.hasFeature }));
vi.mock("@/lib/ai/permissions", () => ({ hasAiUserPermission: mocks.hasPermission }));
vi.mock("@/lib/server-page-permissions", () => ({ getPageVisibilityState: vi.fn().mockResolvedValue("visible") }));

import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";
import { getTaskPolicy } from "@/lib/ai/platform/registry";
import {
  assertAiInputWithinPolicy,
  isCompositeIntent,
  staffTaskForRole,
} from "@/lib/ai/platform/execution";
import { resolveToolMount, staffTaskClassesForRole } from "@/lib/ai/tools";
import type { AuthedUser, UserRole } from "@/lib/rbac";

const ADMIN = { id: "00000000-0000-4000-8000-000000000001", clinicId: "00000000-0000-4000-8000-000000000002", email: "admin@example.com", fullName: "Admin", role: "admin" as const, avatarUrl: null, departmentId: null, mustChangePassword: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntitlements.mockResolvedValue({ subscriptionAllowed: true, planSlug: "pro_ai", features: {}, limits: {} });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
});

describe("Phase 4 normal-agent orchestration", () => {
  it("uses a 20-step standard budget and 25-step composite budget", () => {
    expect(getTaskPolicy("staff_administrative", "administrative_staff").maxSteps).toBe(20);
    expect(getTaskPolicy("staff_operational_query", "administrative_staff").maxSteps).toBe(20);
    expect(getTaskPolicy("staff_composite", "administrative_staff").maxSteps).toBe(25);
    expect(getTaskPolicy("staff_composite", "doctor").maxSteps).toBe(25);
    expect(isCompositeIntent("First list tomorrow's visits, then compare them and send reminders")).toBe(true);
    expect(staffTaskForRole("admin", { messageText: "First list tomorrow's visits, then compare them" }).task).toBe("staff_composite");
  });

  it("completes twelve realistic 50-row resource reads without hitting the former 48 KB ceiling", async () => {
    let generation = 0;
    let maxInputBytes = 0;
    let observedSteps = 0;
    const model = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "anthropic/claude-sonnet-4.5",
      doGenerate: async () => {
        generation += 1;
        if (generation <= 12) {
          return {
            content: [{
              type: "tool-call" as const,
              toolCallId: `query-${generation}`,
              toolName: "query_resource",
              input: JSON.stringify({ page: generation }),
            }],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: {
              inputTokens: { total: 1_000, noCache: 1_000, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 20, text: 20, reasoning: undefined },
            },
            response: { modelId: "anthropic/claude-sonnet-4.5" },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "Completed all twelve reads." }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 12_000, noCache: 12_000, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: 8, reasoning: undefined },
          },
          response: { modelId: "anthropic/claude-sonnet-4.5" },
          warnings: [],
        };
      },
    });
    const policy = getTaskPolicy("staff_administrative", "administrative_staff");
    const agent = new ToolLoopAgent({
      id: "phase4-twelve-step-control",
      model,
      tools: {
        query_resource: tool({
          inputSchema: z.object({ page: z.number().int() }),
          execute: async ({ page }) => ({
            page,
            rows: Array.from({ length: 50 }, (_, index) => ({
              id: `${page}-${index}`,
              full_name: `Authorized patient ${page}-${index}`,
              department: "Dermatology",
              summary: "bounded-resource-result-".repeat(3),
            })),
          }),
        }),
      },
      stopWhen: stepCountIs(policy.maxSteps),
      prepareStep: ({ messages }) => {
        maxInputBytes = Math.max(
          maxInputBytes,
          Buffer.byteLength(JSON.stringify(messages), "utf8"),
        );
        assertAiInputWithinPolicy(messages, policy.maxInputTokensPerStep);
        return {};
      },
      onStepFinish: () => {
        observedSteps += 1;
      },
    });

    const result = await agent.generate({ prompt: "Run twelve authorized resource queries." });
    expect(result.text).toBe("Completed all twelve reads.");
    expect(generation).toBe(13);
    expect(observedSteps).toBe(13);
    expect(maxInputBytes).toBeGreaterThan(48_000);
    expect(maxInputBytes).toBeLessThan(policy.maxInputTokensPerStep);
  });

  it("does not let a non-help intent classification remove an authorized data tool", async () => {
    for (const taskClass of ["staff_administrative", "staff_operational_query", "staff_composite"] as const) {
      const mount = await resolveToolMount({ user: ADMIN, locale: "en", taskClass });
      expect(mount.tools).toHaveProperty("query_resource");
      expect(mount.tools).toHaveProperty("execute_action");
    }
  });

  it("keeps each role's authorized mount identical across all non-help intent classes", async () => {
    const roles: readonly UserRole[] = ["admin", "manager", "receptionist", "doctor", "assistant"];
    for (const role of roles) {
      const user: AuthedUser = { ...ADMIN, role };
      const taskClasses = staffTaskClassesForRole(role).filter((task) => task !== "staff_help");
      const mounts = await Promise.all(taskClasses.map((taskClass) =>
        resolveToolMount({ user, locale: "en", taskClass })));
      const baseline = Object.keys(mounts[0]!.tools).sort();
      for (const mount of mounts.slice(1)) {
        expect(Object.keys(mount.tools).sort(), role).toEqual(baseline);
      }
      expect(baseline, role).toContain("query_resource");
      // Final review B-2. This used to hard-code the three administrative roles
      // and so locked in the very defect it should have caught: the action
      // tools carry every registered write, and doctors and assistants are
      // authorized for 21 and 22 registered actions respectively, yet could
      // mount neither tool. The expectation is now derived from the action
      // registry — a role mounts the action tools iff at least one action
      // authorizes it — so this assertion can no longer be satisfied by a
      // stale hand-written list.
      expect(baseline.includes("execute_action"), role).toBe(
        AI_ACTION_REGISTRY.some((action) => action.roles.includes(role)),
      );
      expect(baseline.includes("describe_action"), role).toBe(
        baseline.includes("execute_action"),
      );
    }
  });

  it("keeps help as an explicit no-data containment route", async () => {
    const help = await resolveToolMount({ user: ADMIN, locale: "en", taskClass: "staff_help" });
    expect(help.tools).toHaveProperty("search_help");
    expect(help.tools).toHaveProperty("get_navigation_target");
    expect(help.tools).not.toHaveProperty("query_resource");
    expect(help.tools).not.toHaveProperty("get_record");
    expect(help.tools).not.toHaveProperty("execute_action");
  });

  it("re-homes all three legacy actions in the action registry with their caps", () => {
    const byId = new Map(AI_ACTION_REGISTRY.map((action) => [action.id, action]));
    expect(byId.get("appointments.send_reminders")?.risk).toBe("bulk");
    expect(byId.get("invoices.send_reminders")?.risk).toBe("bulk");
    expect(byId.get("appointments.create_pending")?.risk).toBe("normal");
    expect(byId.get("appointments.send_reminders")).toMatchObject({
      roles: ["admin", "receptionist"],
      pageSlug: "appointments",
    });
    expect(byId.get("invoices.send_reminders")).toMatchObject({
      roles: ["admin", "manager"],
      pageSlug: "revenue",
      requiredUserPermission: "ai.financial_insights",
    });
    expect(byId.get("appointments.send_reminders")?.inputSchema.safeParse({ appointments: Array.from({ length: 26 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) }).success).toBe(false);
  });

  it("removes retired workflow authorization and tool-cost metadata", () => {
    const authorization = readFileSync(join(process.cwd(), "lib/ai/authorization.ts"), "utf8");
    const toolRegistry = readFileSync(join(process.cwd(), "lib/ai/tools/registry.ts"), "utf8");
    expect(authorization).not.toMatch(/assertWorkflowAccess|assertWorkflowActionAccess/);
    expect(toolRegistry).not.toMatch(/workflow\s*:\s*\{|costUnits|orchestrator/);
  });
});
