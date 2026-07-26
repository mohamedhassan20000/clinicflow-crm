import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { AuthedUser } from "@/lib/rbac";
import type {
  WorkflowLedger,
  WorkflowLedgerCreate,
  WorkflowLedgerRun,
  WorkflowLedgerUpdate,
} from "@/lib/ai/workflows/types";

const mocks = vi.hoisted(() => ({ assertWorkflowAccess: vi.fn() }));
vi.mock("@/lib/ai/authorization", () => ({
  assertWorkflowAccess: mocks.assertWorkflowAccess,
}));

import {
  confirmOrResumeWorkflow,
  executeReadOnlyWorkflow,
  workflowInvocationMode,
} from "@/lib/ai/workflows/executor";
import { validateWorkflowPlan } from "@/lib/ai/workflows/plan";

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
const RUN_ID = "00000000-0000-4000-8000-000000000099";

function definition(name: string, kind: "read" | "action", costUnits = 1) {
  return { name, workflow: { kind, costUnits } } as const;
}

class MemoryLedger implements WorkflowLedger {
  run: WorkflowLedgerRun | null = null;
  claims = 0;

  async create(input: WorkflowLedgerCreate) {
    this.run = {
      id: RUN_ID,
      clinicId: input.clinicId,
      userId: input.userId,
      mode: input.mode,
      state: input.state,
      planSummary: structuredClone(input.planSummary),
      stepStates: structuredClone(input.stepStates),
      dryRunSnapshotHash: input.dryRunSnapshotHash,
      confirmedBy: null,
      confirmedAt: null,
      completedAt: input.state === "previewed" ? new Date().toISOString() : null,
    };
    return { id: RUN_ID };
  }

  async update(
    _clinicId: string,
    _userId: string,
    _runId: string,
    input: WorkflowLedgerUpdate,
  ) {
    if (!this.run) throw new Error("missing run");
    this.run = {
      ...this.run,
      mode: input.mode ?? this.run.mode,
      state: input.state,
      stepStates: structuredClone(input.stepStates),
      dryRunSnapshotHash:
        input.dryRunSnapshotHash === undefined
          ? this.run.dryRunSnapshotHash
          : input.dryRunSnapshotHash,
      confirmedBy:
        input.confirmedBy === undefined
          ? this.run.confirmedBy
          : input.confirmedBy,
      confirmedAt:
        input.confirmedAt === undefined
          ? this.run.confirmedAt
          : input.confirmedAt,
      completedAt:
        input.completedAt === undefined
          ? this.run.completedAt
          : input.completedAt,
    };
  }

  async get() {
    return this.run ? structuredClone(this.run) : null;
  }

  async claimConfirmation(
    _clinicId: string,
    userId: string,
    _runId: string,
    previewSnapshotHash: string,
    confirmedActionInputsHash: string,
    confirmedAt: string,
  ) {
    if (
      !this.run ||
      this.run.confirmedAt ||
      this.run.state !== "previewed" ||
      this.run.dryRunSnapshotHash !== previewSnapshotHash
    ) {
      return false;
    }
    this.claims += 1;
    this.run = {
      ...this.run,
      mode: "execute",
      state: "running",
      confirmedBy: userId,
      confirmedAt,
      dryRunSnapshotHash: confirmedActionInputsHash,
      completedAt: null,
    };
    return true;
  }
}

function actionTool(execute: (mode: "preview" | "execute") => unknown): Tool {
  return tool({
    inputSchema: z.object({ target: z.string() }),
    execute: async (_input, options) =>
      execute(workflowInvocationMode(options as ToolExecutionOptions)),
  }) as Tool;
}

const PLAN = {
  version: 1 as const,
  steps: [
    {
      id: "notify",
      tool: "send_bounded_notice",
      input: { target: "authorized-row" },
      depends_on: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertWorkflowAccess.mockResolvedValue(undefined);
});

describe("P4.11B action confirmation engine", () => {
  it("forces a model-requested action execution into a non-mutating preview", async () => {
    const ledger = new MemoryLedger();
    const commit = vi.fn();
    const preview = vi.fn(() => ({
      action: "send_appointment_reminders",
      draft_status: "awaiting_confirmation",
      count: 1,
    }));
    const result = await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      mode: "execute",
      definitions: [definition("send_bounded_notice", "action")],
      tools: {
        send_bounded_notice: actionTool((mode) =>
          mode === "preview" ? preview() : commit(),
        ),
      },
      ledger,
    });

    expect(result.mode).toBe("dry_run");
    expect(result.requires_confirmation).toBe(true);
    expect(preview).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(ledger.run?.confirmedAt).toBeNull();
  });

  it("hash-checks, claims once, and commits only after same-user confirmation", async () => {
    const ledger = new MemoryLedger();
    const commit = vi.fn(() => ({ sent: true }));
    const tools = {
      send_bounded_notice: actionTool((mode) =>
        mode === "preview"
          ? {
              action: "send_appointment_reminders",
              draft_status: "awaiting_confirmation",
              count: 1,
            }
          : commit(),
      ),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    const result = await confirmOrResumeWorkflow({
      user: USER,
      runId: RUN_ID,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });

    expect(result?.state).toBe("succeeded");
    expect(commit).toHaveBeenCalledOnce();
    expect(ledger.claims).toBe(1);
    expect(ledger.run?.confirmedBy).toBe(USER.id);
  });

  it("rejects a stale preview before claiming or committing", async () => {
    const ledger = new MemoryLedger();
    let previewVersion = 0;
    const commit = vi.fn();
    const tools = {
      send_bounded_notice: actionTool((mode) =>
        mode === "preview"
          ? {
              action: "send_appointment_reminders",
              draft_status: "awaiting_confirmation",
              count: ++previewVersion,
            }
          : commit(),
      ),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });

    await expect(
      confirmOrResumeWorkflow({
        user: USER,
        runId: RUN_ID,
        plan: PLAN,
        definitions,
        tools,
        ledger,
      }),
    ).rejects.toMatchObject({ reason: "preview_stale" });
    expect(ledger.claims).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it("binds confirmation to exact plan values, not only parameter shapes", async () => {
    const ledger = new MemoryLedger();
    const commit = vi.fn();
    const tools = {
      send_bounded_notice: actionTool((mode) =>
        mode === "preview"
          ? {
              action: "send_appointment_reminders",
              draft_status: "awaiting_confirmation",
              count: 1,
            }
          : commit(),
      ),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });

    await expect(
      confirmOrResumeWorkflow({
        user: USER,
        runId: RUN_ID,
        plan: {
          ...PLAN,
          steps: [{
            ...PLAN.steps[0],
            input: { target: "different-authorized-row" },
          }],
        },
        definitions,
        tools,
        ledger,
      }),
    ).rejects.toMatchObject({ reason: "preview_stale" });
    expect(ledger.claims).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports a definite channel partial failure and safely resumes the action", async () => {
    const ledger = new MemoryLedger();
    let attempts = 0;
    const tools = {
      send_bounded_notice: actionTool((mode) => {
        if (mode === "preview") {
          return {
            action: "send_appointment_reminders",
            draft_status: "awaiting_confirmation",
            count: 1,
          };
        }
        attempts += 1;
        return attempts === 1
          ? {
              action: "send_appointment_reminders",
              workflow_action_failed: true,
              workflow_action_partial_failure: true,
            }
          : { action: "send_appointment_reminders", sent: true };
      }),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });

    const partial = await confirmOrResumeWorkflow({
      user: USER,
      runId: RUN_ID,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    expect(partial).toMatchObject({
      state: "partially_failed",
      partial_failure: true,
      resumable: true,
      steps: [
        expect.objectContaining({
          status: "failed",
          error_code: "action_partial_failure",
        }),
      ],
    });

    const resumed = await confirmOrResumeWorkflow({
      user: USER,
      runId: RUN_ID,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    expect(resumed).toMatchObject({
      state: "succeeded",
      resumable: false,
    });
    expect(attempts).toBe(2);
    expect(ledger.claims).toBe(1);
  });

  it("rejects same-shaped client target swaps on resume", async () => {
    const ledger = new MemoryLedger();
    let attempts = 0;
    const commit = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? {
            action: "send_appointment_reminders",
            workflow_action_failed: true,
          }
        : { action: "send_appointment_reminders", sent: true };
    });
    const tools = {
      send_bounded_notice: actionTool((mode) =>
        mode === "preview"
          ? {
              action: "send_appointment_reminders",
              draft_status: "awaiting_confirmation",
              count: 1,
            }
          : commit(),
      ),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    const partial = await confirmOrResumeWorkflow({
      user: USER,
      runId: RUN_ID,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    expect(partial?.state).toBe("failed");

    await expect(
      confirmOrResumeWorkflow({
        user: USER,
        runId: RUN_ID,
        plan: {
          ...PLAN,
          steps: [
            {
              ...PLAN.steps[0],
              input: { target: "different-authorized-row" },
            },
          ],
        },
        definitions,
        tools,
        ledger,
      }),
    ).rejects.toMatchObject({ reason: "preview_stale" });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects newly resolved action targets on resume without invoking an action preview", async () => {
    const ledger = new MemoryLedger();
    let targets = ["patient-a"];
    let attempts = 0;
    const read = tool({
      inputSchema: z.object({}),
      execute: async () => ({ targets }),
    }) as Tool;
    const actionPreview = vi.fn(() => ({
      action: "send_appointment_reminders",
      draft_status: "awaiting_confirmation",
      count: targets.length,
    }));
    const action = tool({
      inputSchema: z.object({ targets: z.array(z.string()) }),
      execute: async (_input, options) => {
        const mode = workflowInvocationMode(options as ToolExecutionOptions);
        if (mode === "preview") return actionPreview();
        attempts += 1;
        return {
          action: "send_appointment_reminders",
          workflow_action_failed: attempts === 1,
        };
      },
    }) as Tool;
    const plan = {
      version: 1 as const,
      steps: [
        { id: "find", tool: "find_targets", input: {}, depends_on: [] },
        {
          id: "notify",
          tool: "send_bounded_notice",
          input: { targets: { $step: "find", path: ["targets"] } },
          depends_on: ["find"],
        },
      ],
    };
    const definitions = [
      definition("find_targets", "read"),
      definition("send_bounded_notice", "action"),
    ];
    const tools = { find_targets: read, send_bounded_notice: action };
    await executeReadOnlyWorkflow({
      user: USER,
      plan,
      definitions,
      tools,
      ledger,
    });
    await confirmOrResumeWorkflow({
      user: USER,
      runId: RUN_ID,
      plan,
      definitions,
      tools,
      ledger,
    });
    expect(attempts).toBe(1);
    expect(actionPreview).toHaveBeenCalledTimes(2);

    targets = ["patient-a", "patient-d"];
    await expect(
      confirmOrResumeWorkflow({
        user: USER,
        runId: RUN_ID,
        plan,
        definitions,
        tools,
        ledger,
      }),
    ).rejects.toMatchObject({ reason: "preview_stale" });
    expect(attempts).toBe(1);
    // Resume rebinding resolves the inputs but never invokes an action preview.
    expect(actionPreview).toHaveBeenCalledTimes(2);
  });

  it("expires an unconfirmed preview after fifteen minutes", async () => {
    const ledger = new MemoryLedger();
    const commit = vi.fn();
    const tools = {
      send_bounded_notice: actionTool((mode) =>
        mode === "preview"
          ? {
              action: "send_appointment_reminders",
              draft_status: "awaiting_confirmation",
              count: 1,
            }
          : commit(),
      ),
    };
    const definitions = [definition("send_bounded_notice", "action")];
    await executeReadOnlyWorkflow({
      user: USER,
      plan: PLAN,
      definitions,
      tools,
      ledger,
    });
    ledger.run = {
      ...ledger.run!,
      completedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
    };

    await expect(
      confirmOrResumeWorkflow({
        user: USER,
        runId: RUN_ID,
        plan: PLAN,
        definitions,
        tools,
        ledger,
      }),
    ).rejects.toMatchObject({ reason: "preview_expired" });
    expect(ledger.claims).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it("forbids later steps from depending on non-durable action output", async () => {
    const action = actionTool(() => ({ id: "mutation-result" }));
    const read = tool({
      inputSchema: z.object({ id: z.string() }),
      execute: async () => ({ ok: true }),
    }) as Tool;
    await expect(
      validateWorkflowPlan({
        plan: {
          version: 1,
          steps: [
            {
              id: "action",
              tool: "action",
              input: { target: "row" },
              depends_on: [],
            },
            {
              id: "later",
              tool: "read",
              input: { id: { $step: "action", path: ["id"] } },
              depends_on: ["action"],
            },
          ],
        },
        definitions: [
          definition("action", "action"),
          definition("read", "read"),
        ],
        tools: { action, read },
      }),
    ).rejects.toMatchObject({ reason: "invalid_action_dependency" });
  });
});
