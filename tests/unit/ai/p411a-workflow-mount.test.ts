import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerUpdate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/permissions", () => ({
  hasAiUserPermission: mocks.hasPermission,
}));
vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: vi.fn().mockResolvedValue("visible"),
}));
vi.mock("@/lib/ai/workflows/ledger", () => ({
  databaseWorkflowLedger: {
    create: mocks.ledgerCreate,
    update: mocks.ledgerUpdate,
  },
}));
vi.mock("@/lib/ai/audit", () => ({
  logAgentTool: mocks.audit,
}));

import {
  resolveToolMount,
  staffTaskClassesForRole,
} from "@/lib/ai/tools";
import {
  getTaskPolicy,
} from "@/lib/ai/platform/registry";
import {
  isWorkflowIntent,
  staffTaskForRole,
} from "@/lib/ai/platform/execution";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  fullName: "Admin",
  role: "admin" as const,
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntitlements.mockResolvedValue({
    subscriptionAllowed: true,
    planSlug: "pro_ai",
    features: {},
    limits: {},
  });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.ledgerCreate.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000099",
  });
  mocks.ledgerUpdate.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
});

describe("P4.11A dedicated workflow mount and task policy", () => {
  it("mounts only the orchestrator to the model for a workflow turn", async () => {
    const mount = await resolveToolMount({
      user: USER,
      locale: "en",
      taskClass: "staff_workflow",
    });
    expect(Object.keys(mount.tools)).toEqual(["execute_read_only_workflow"]);
    expect(mount.definitions).toHaveLength(1);
    expect(mount.definitions[0]).toMatchObject({
      name: "execute_read_only_workflow",
      workflow: { kind: "orchestrator" },
    });
    expect(Object.keys(mount.workflowStepTools)).toEqual(
      expect.arrayContaining([
        "send_appointment_reminders",
        "send_invoice_reminders",
        "create_pending_booking",
      ]),
    );
    expect(mount.tools).not.toHaveProperty("send_appointment_reminders");
    expect(mount.tools).not.toHaveProperty("send_invoice_reminders");
    expect(mount.tools).not.toHaveProperty("create_pending_booking");
  });

  it("keeps the authorized step mount hidden while the orchestrator can dry-run it", async () => {
    const mount = await resolveToolMount({
      user: USER,
      locale: "en",
      taskClass: "staff_workflow",
      aiRequestId: "00000000-0000-4000-8000-000000000020",
    });
    const result = await mount.tools.execute_read_only_workflow!.execute!(
      {
        dry_run: true,
        plan: {
          version: 1,
          steps: [{
            id: "help",
            tool: "search_help",
            input: { query: "How do I issue an invoice?" },
            depends_on: [],
          }],
        },
      },
      { toolCallId: "workflow", messages: [] },
    ) as {
      state: string;
      preview: { steps: Array<{ tool: string }> };
    };

    expect(result.state).toBe("previewed");
    expect(result.preview.steps).toEqual([
      expect.objectContaining({ tool: "search_help" }),
    ]);
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: USER.clinicId,
        userId: USER.id,
        aiRequestId: "00000000-0000-4000-8000-000000000020",
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "execute_read_only_workflow",
        recordId: "00000000-0000-4000-8000-000000000099",
      }),
    );
  });

  it("does not add the orchestrator to ordinary or capability-union mounts", async () => {
    const ordinary = await resolveToolMount({
      user: USER,
      locale: "en",
      taskClass: "staff_operational_query",
    });
    const union = await resolveToolMount({ user: USER, locale: "en" });
    expect(ordinary.tools).not.toHaveProperty("execute_read_only_workflow");
    expect(union.tools).not.toHaveProperty("execute_read_only_workflow");
    expect(staffTaskClassesForRole("admin")).not.toContain("staff_workflow");
  });

  it("routes only explicit entitled sequencing intent into the workflow class", () => {
    expect(isWorkflowIntent("Find tomorrow's pending visits and then summarize the totals"))
      .toBe(true);
    expect(isWorkflowIntent("Generate this month's revenue report and summarize it"))
      .toBe(true);
    expect(
      staffTaskForRole("admin", {
        analyticsEntitled: true,
        workflowsEntitled: true,
        messageText: "Find tomorrow's pending visits and then summarize the totals",
      }),
    ).toEqual({ task: "staff_workflow", persona: "administrative_staff" });
    expect(
      staffTaskForRole("admin", {
        analyticsEntitled: true,
        workflowsEntitled: false,
        messageText: "Find tomorrow's pending visits and then summarize the totals",
      }).task,
    ).not.toBe("staff_workflow");
    expect(isWorkflowIntent("Show me tomorrow's appointments")).toBe(false);
  });

  it("uses a certified capped policy for both staff personas", () => {
    expect(getTaskPolicy("staff_workflow", "administrative_staff")).toMatchObject({
      task: "staff_workflow",
      maxSteps: 3,
      maxInputTokensPerStep: 32_000,
      maxOutputTokens: 1_200,
    });
    expect(getTaskPolicy("staff_workflow", "doctor").allowedPersonas)
      .toContain("doctor");
  });
});
