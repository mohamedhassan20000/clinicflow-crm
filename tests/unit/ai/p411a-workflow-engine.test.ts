import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AuthedUser } from "@/lib/rbac";
import type {
  WorkflowLedger,
  WorkflowLedgerCreate,
  WorkflowLedgerUpdate,
} from "@/lib/ai/workflows/types";

const mocks = vi.hoisted(() => ({
  assertWorkflowAccess: vi.fn(),
}));

vi.mock("@/lib/ai/authorization", () => ({
  assertWorkflowAccess: mocks.assertWorkflowAccess,
}));

import { executeReadOnlyWorkflow } from "@/lib/ai/workflows/executor";
import {
  validateWorkflowPlan,
  WorkflowPlanError,
} from "@/lib/ai/workflows/plan";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  fullName: "Workflow Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

function definition(
  name: string,
  costUnits = 1,
  kind: "read" | "orchestrator" = "read",
) {
  return { name, workflow: { kind, costUnits } } as const;
}

function executable<TSchema extends z.ZodType>(
  inputSchema: TSchema,
  execute: (input: z.infer<TSchema>, ...args: unknown[]) => unknown,
): Tool {
  return tool({ inputSchema, execute }) as Tool;
}

class FakeLedger implements WorkflowLedger {
  creates: WorkflowLedgerCreate[] = [];
  updates: Array<{
    clinicId: string;
    userId: string;
    runId: string;
    input: WorkflowLedgerUpdate;
  }> = [];

  async create(input: WorkflowLedgerCreate) {
    this.creates.push(structuredClone(input));
    return { id: "00000000-0000-4000-8000-000000000099" };
  }

  async update(
    clinicId: string,
    userId: string,
    runId: string,
    input: WorkflowLedgerUpdate,
  ) {
    this.updates.push({
      clinicId,
      userId,
      runId,
      input: structuredClone(input),
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertWorkflowAccess.mockResolvedValue(undefined);
});

describe("P4.11A workflow plan validation", () => {
  it("denies an unknown or unmounted tool before a run exists", async () => {
    const ledger = new FakeLedger();
    await expect(
      executeReadOnlyWorkflow({
        user: USER,
        plan: {
          version: 1,
          steps: [{ id: "probe", tool: "arbitrary_sql", input: {}, depends_on: [] }],
        },
        definitions: [],
        tools: {},
        ledger,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowPlanError",
      reason: "unknown_or_unmounted_tool",
      stepId: "probe",
    });
    expect(ledger.creates).toHaveLength(0);
  });

  it("rejects the orchestrator and every future non-read step as step vocabulary", async () => {
    const orchestrator = executable(z.object({}), vi.fn());
    await expect(
      validateWorkflowPlan({
        plan: {
          version: 1,
          steps: [{
            id: "recursive",
            tool: "execute_read_only_workflow",
            input: {},
            depends_on: [],
          }],
        },
        definitions: [
          definition("execute_read_only_workflow", 0, "orchestrator"),
        ],
        tools: { execute_read_only_workflow: orchestrator },
      }),
    ).rejects.toMatchObject({ reason: "non_read_only_tool" });
  });

  it("enforces the deterministic cost ceiling before execution", async () => {
    const tools = Object.fromEntries(
      ["one", "two", "three", "four", "five"].map((name) => [
        name,
        executable(z.object({}), vi.fn()),
      ]),
    );
    await expect(
      validateWorkflowPlan({
        plan: {
          version: 1,
          steps: Object.keys(tools).map((name) => ({
            id: name,
            tool: name,
            input: {},
            depends_on: [],
          })),
        },
        definitions: Object.keys(tools).map((name) => definition(name, 3)),
        tools,
      }),
    ).rejects.toMatchObject({ reason: "step_cost_cap_exceeded" });
  });

  it("requires references to earlier, explicitly declared dependencies", async () => {
    const tools = {
      first: executable(z.object({}), vi.fn()),
      second: executable(z.object({ id: z.string() }), vi.fn()),
    };
    await expect(
      validateWorkflowPlan({
        plan: {
          version: 1,
          steps: [
            { id: "lookup", tool: "first", input: {}, depends_on: [] },
            {
              id: "read",
              tool: "second",
              input: { id: { $step: "lookup", path: ["id"] } },
              depends_on: [],
            },
          ],
        },
        definitions: [definition("first"), definition("second")],
        tools,
      }),
    ).rejects.toMatchObject({ reason: "invalid_reference", stepId: "read" });
  });

  it("rejects invalid literal tool input before creating the ledger", async () => {
    const ledger = new FakeLedger();
    await expect(
      executeReadOnlyWorkflow({
        user: USER,
        plan: {
          version: 1,
          steps: [{
            id: "range",
            tool: "bounded",
            input: { limit: 1000 },
            depends_on: [],
          }],
        },
        definitions: [definition("bounded")],
        tools: {
          bounded: executable(
            z.object({ limit: z.number().int().min(1).max(50) }),
            vi.fn(),
          ),
        },
        ledger,
      }),
    ).rejects.toBeInstanceOf(WorkflowPlanError);
    expect(ledger.creates).toHaveLength(0);
  });
});

describe("P4.11A read-only executor behavior", () => {
  it("dry-runs without invoking tools and persists only content-free parameter shapes", async () => {
    const ledger = new FakeLedger();
    const execute = vi.fn();
    const patientId = "11111111-1111-4111-8111-111111111111";
    const result = await executeReadOnlyWorkflow({
      user: USER,
      mode: "dry_run",
      aiRequestId: "00000000-0000-4000-8000-000000000020",
      plan: {
        version: 1,
        steps: [{
          id: "patient",
          tool: "search_authorized_patients",
          input: { query: "Sensitive Patient Name", patient_id: patientId },
          depends_on: [],
        }],
      },
      definitions: [definition("search_authorized_patients", 2)],
      tools: {
        search_authorized_patients: executable(
          z.object({ query: z.string(), patient_id: z.string().uuid() }),
          execute,
        ),
      },
      ledger,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "dry_run",
      state: "previewed",
      partial_failure: false,
    });
    expect(ledger.creates[0]?.dryRunSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const persisted = JSON.stringify(ledger.creates[0]?.planSummary);
    expect(persisted).toContain("query");
    expect(persisted).toContain("patient_id");
    expect(persisted).not.toContain("Sensitive Patient Name");
    expect(persisted).not.toContain(patientId);
  });

  it("executes sequentially, resolves typed references, and reuses mounted tool execute boundaries", async () => {
    const ledger = new FakeLedger();
    const lookup = vi.fn().mockResolvedValue({ row: { id: "authorized-id" } });
    const read = vi.fn().mockResolvedValue({ found: true });
    const result = await executeReadOnlyWorkflow({
      user: USER,
      plan: {
        version: 1,
        steps: [
          { id: "lookup", tool: "lookup", input: { query: "safe" }, depends_on: [] },
          {
            id: "read",
            tool: "read",
            input: { id: { $step: "lookup", path: ["row", "id"] } },
            depends_on: ["lookup"],
          },
        ],
      },
      definitions: [definition("lookup"), definition("read")],
      tools: {
        lookup: executable(z.object({ query: z.string() }), lookup),
        read: executable(z.object({ id: z.string() }), read),
      },
      ledger,
    });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      { id: "authorized-id" },
      expect.objectContaining({
        toolCallId: expect.stringContaining(":read"),
        messages: [],
      }),
    );
    expect(result.state).toBe("succeeded");
    expect(result.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(ledger.updates.at(-1)?.input).toMatchObject({
      state: "succeeded",
      errorCode: null,
    });
  });

  it("reports authorization partials honestly, skips dependents, and continues independent steps", async () => {
    const ledger = new FakeLedger();
    const dependent = vi.fn();
    const independent = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeReadOnlyWorkflow({
      user: USER,
      plan: {
        version: 1,
        steps: [
          { id: "first", tool: "first", input: {}, depends_on: [] },
          { id: "denied", tool: "denied", input: {}, depends_on: [] },
          { id: "dependent", tool: "dependent", input: {}, depends_on: ["denied"] },
          { id: "independent", tool: "independent", input: {}, depends_on: [] },
        ],
      },
      definitions: [
        definition("first"),
        definition("denied"),
        definition("dependent"),
        definition("independent"),
      ],
      tools: {
        first: executable(z.object({}), vi.fn().mockResolvedValue({ ok: true })),
        denied: executable(
          z.object({}),
          vi.fn().mockResolvedValue({
            permission_denied: true,
            reason: "page_hidden",
          }),
        ),
        dependent: executable(z.object({}), dependent),
        independent: executable(z.object({}), independent),
      },
      ledger,
    });

    expect(result.state).toBe("partially_failed");
    expect(result.partial_failure).toBe(true);
    expect(result.steps.map((step) => [step.id, step.status, step.error_code])).toEqual([
      ["first", "succeeded", null],
      ["denied", "denied", "page_hidden"],
      ["dependent", "skipped", "dependency_failed"],
      ["independent", "succeeded", null],
    ]);
    expect(dependent).not.toHaveBeenCalled();
    expect(independent).toHaveBeenCalledTimes(1);
  });

  it("checks the workflow entitlement before validation or ledger writes", async () => {
    const ledger = new FakeLedger();
    mocks.assertWorkflowAccess.mockRejectedValueOnce(new Error("denied"));
    await expect(
      executeReadOnlyWorkflow({
        user: USER,
        plan: null,
        definitions: [],
        tools: {},
        ledger,
      }),
    ).rejects.toThrow("denied");
    expect(ledger.creates).toHaveLength(0);
  });
});
