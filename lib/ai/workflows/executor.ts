import "server-only";

import type { Tool, ToolExecutionOptions } from "ai";
import type { AuthedUser } from "@/lib/rbac";
import { assertWorkflowAccess } from "@/lib/ai/authorization";
import type { WorkflowMountDefinition } from "@/lib/ai/tools/context";
import {
  resolveWorkflowInput,
  validateResolvedWorkflowInput,
  validateWorkflowPlan,
  workflowActionInputsHash,
  workflowActionSnapshotHash,
  workflowPreviewHash,
  WorkflowPlanError,
  type ValidatedWorkflowPlan,
} from "@/lib/ai/workflows/plan";
import { databaseWorkflowLedger } from "@/lib/ai/workflows/ledger";
import {
  type WorkflowExecutionResult,
  type WorkflowLedger,
  type WorkflowRunState,
  type WorkflowStepLedgerState,
  type WorkflowStepResult,
} from "@/lib/ai/workflows/types";

type Clock = { now(): Date };
type InvocationMode = "preview" | "execute";
const systemClock: Clock = { now: () => new Date() };
export const WORKFLOW_PREVIEW_TTL_MS = 15 * 60 * 1_000;

type ResolvedActionInput = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
};

function initialStepStates(validated: ValidatedWorkflowPlan): WorkflowStepLedgerState[] {
  return validated.plan.steps.map((step) => ({
    id: step.id,
    tool: step.tool,
    status: "pending",
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error_code: null,
  }));
}

function terminalState(states: WorkflowStepLedgerState[]): WorkflowRunState {
  const succeeded = states.filter((step) => step.status === "succeeded").length;
  const actionPartiallyCompleted = states.some(
    (step) => step.error_code === "action_partial_failure",
  );
  const failures = states.some((step) =>
    ["denied", "failed", "skipped"].includes(step.status),
  );
  const clarification = states.some(
    (step) => step.status === "needs_clarification",
  );
  if (!failures && !clarification) return "succeeded";
  if (succeeded > 0 || actionPartiallyCompleted) return "partially_failed";
  if (clarification && !failures) return "needs_clarification";
  return "failed";
}

function safeDenialReason(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  return record.permission_denied === true && typeof record.reason === "string"
    ? record.reason.slice(0, 100)
    : null;
}

function needsClarification(output: unknown): boolean {
  return Boolean(
    output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      (output as Record<string, unknown>).needs_clarification === true,
  );
}

function actionFailureCode(
  output: unknown,
): "action_failed" | "action_partial_failure" | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (record.workflow_action_partial_failure === true) {
    return "action_partial_failure";
  }
  return record.workflow_action_failed === true ? "action_failed" : null;
}

function toolOptions(
  runId: string,
  stepId: string,
  mode: InvocationMode,
  abortSignal?: AbortSignal,
): ToolExecutionOptions {
  return {
    // The mode is server-authored and action tools are hidden from the model.
    // No model/client input can turn a preview invocation into a commit.
    toolCallId: `workflow:${runId}:${stepId}:${mode}`,
    messages: [],
    abortSignal,
  };
}

export function workflowInvocationMode(
  options: Pick<ToolExecutionOptions, "toolCallId">,
): InvocationMode {
  if (options.toolCallId.endsWith(":preview")) return "preview";
  if (options.toolCallId.endsWith(":execute")) return "execute";
  throw new Error("Workflow action invoked outside the workflow executor.");
}

export function workflowInvocationIdentity(
  options: Pick<ToolExecutionOptions, "toolCallId">,
): { runId: string; stepId: string; mode: InvocationMode } {
  const parts = options.toolCallId.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "workflow" ||
    !parts[1] ||
    !parts[2] ||
    (parts[3] !== "preview" && parts[3] !== "execute")
  ) {
    throw new Error("Invalid workflow action invocation.");
  }
  return { runId: parts[1], stepId: parts[2], mode: parts[3] };
}

async function invokeTool(
  tool: Tool,
  input: Record<string, unknown>,
  options: ToolExecutionOptions,
): Promise<unknown> {
  if (typeof tool.execute !== "function") {
    throw new Error("Workflow tool is not executable.");
  }
  const value = await tool.execute(input, options);
  if (value && typeof value === "object" && Symbol.asyncIterator in value) {
    throw new Error("Streaming tools are not supported in workflows.");
  }
  return value;
}

function actionKind(
  definitions: readonly WorkflowMountDefinition[],
  toolName: string,
): boolean {
  return definitions.find((definition) => definition.name === toolName)?.workflow
    .kind === "action";
}

async function runSteps(input: {
  validated: ValidatedWorkflowPlan;
  definitions: readonly WorkflowMountDefinition[];
  tools: Readonly<Record<string, Tool>>;
  runId: string;
  mode: InvocationMode;
  clinicId: string;
  userId: string;
  abortSignal?: AbortSignal;
  ledger?: WorkflowLedger;
  clock: Clock;
  resumeStates?: WorkflowStepLedgerState[];
  skipActionExecution?: boolean;
}): Promise<{
  states: WorkflowStepLedgerState[];
  results: WorkflowStepResult[];
  actionInputs: ResolvedActionInput[];
}> {
  const steps = input.resumeStates?.map((step) => ({ ...step })) ??
    initialStepStates(input.validated);
  const outputs = new Map<string, unknown>();
  const results: WorkflowStepResult[] = [];
  const actionInputs: ResolvedActionInput[] = [];

  for (const [index, plannedStep] of input.validated.plan.steps.entries()) {
    const isAction = actionKind(input.definitions, plannedStep.tool);
    if (
      input.mode === "execute" &&
      isAction &&
      steps[index]?.status === "succeeded"
    ) {
      // Completed actions are terminal across resume. Action outputs cannot be
      // referenced by later steps, enforced during whole-plan validation.
      results.push({ ...steps[index]! });
      continue;
    }

    const dependencyFailed = plannedStep.depends_on.some((dependency) => {
      const state = steps.find((step) => step.id === dependency);
      return state?.status !== "succeeded" && state?.status !== "previewed";
    });
    if (dependencyFailed) {
      const completedAt = input.clock.now().toISOString();
      steps[index] = {
        ...steps[index]!,
        status: "skipped",
        completed_at: completedAt,
        duration_ms: 0,
        error_code: "dependency_failed",
      };
      results.push({ ...steps[index]! });
      if (input.ledger) {
        await input.ledger.update(input.clinicId, input.userId, input.runId, {
          state: "running",
          stepStates: steps,
        });
      }
      continue;
    }

    const stepStarted = input.clock.now();
    steps[index] = {
      ...steps[index]!,
      status: "running",
      started_at: stepStarted.toISOString(),
      completed_at: null,
      duration_ms: null,
      error_code: null,
    };
    if (input.ledger) {
      await input.ledger.update(input.clinicId, input.userId, input.runId, {
        state: "running",
        stepStates: steps,
      });
    }

    let output: unknown;
    try {
      const resolved = resolveWorkflowInput(plannedStep.input, outputs);
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
        throw new WorkflowPlanError("invalid_step_input", plannedStep.id);
      }
      const resolvedInput = resolved as Record<string, unknown>;
      const tool = input.tools[plannedStep.tool]!;
      await validateResolvedWorkflowInput(tool, resolvedInput, plannedStep.id);
      if (isAction) {
        actionInputs.push({
          id: plannedStep.id,
          tool: plannedStep.tool,
          input: structuredClone(resolvedInput),
        });
      }
      output =
        isAction && input.skipActionExecution
          ? undefined
          : await invokeTool(
              tool,
              resolvedInput,
              toolOptions(
                input.runId,
                plannedStep.id,
                input.mode,
                input.abortSignal,
              ),
            );
      const denial = safeDenialReason(output);
      const actionFailure = isAction ? actionFailureCode(output) : null;
      const completed = input.clock.now();
      const status = denial
        ? "denied"
        : needsClarification(output)
          ? "needs_clarification"
          : actionFailure
            ? "failed"
          : input.mode === "preview" && isAction
            ? "previewed"
            : "succeeded";
      steps[index] = {
        ...steps[index]!,
        status,
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - stepStarted.getTime()),
        error_code:
          denial ??
          actionFailure ??
          (status === "needs_clarification" ? "needs_clarification" : null),
      };
      if (status === "succeeded" || status === "previewed") {
        outputs.set(plannedStep.id, output);
      }
    } catch (error) {
      const completed = input.clock.now();
      steps[index] = {
        ...steps[index]!,
        status: "failed",
        completed_at: completed.toISOString(),
        duration_ms: Math.max(0, completed.getTime() - stepStarted.getTime()),
        error_code:
          error instanceof WorkflowPlanError ? error.reason : "tool_error",
      };
    }

    const result: WorkflowStepResult = { ...steps[index]! };
    if (
      steps[index]!.status === "succeeded" ||
      steps[index]!.status === "previewed" ||
      steps[index]!.error_code === "action_partial_failure"
    ) {
      result.output = output;
    }
    results.push(result);
    if (input.ledger) {
      await input.ledger.update(input.clinicId, input.userId, input.runId, {
        state: "running",
        stepStates: steps,
      });
    }
  }

  return { states: steps, results, actionInputs };
}

function previewExpired(completedAt: string | null, now: Date): boolean {
  if (!completedAt) return true;
  const completed = new Date(completedAt).getTime();
  return (
    !Number.isFinite(completed) ||
    now.getTime() - completed > WORKFLOW_PREVIEW_TTL_MS
  );
}

export async function executeReadOnlyWorkflow(input: {
  user: AuthedUser;
  plan: unknown;
  mode?: "dry_run" | "execute";
  definitions: readonly WorkflowMountDefinition[];
  tools: Readonly<Record<string, Tool>>;
  aiRequestId?: string | null;
  abortSignal?: AbortSignal;
  ledger?: WorkflowLedger;
  clock?: Clock;
}): Promise<WorkflowExecutionResult> {
  await assertWorkflowAccess(input.user);
  const validated = await validateWorkflowPlan({
    plan: input.plan,
    definitions: input.definitions,
    tools: input.tools,
  });
  const requestedMode = input.mode ?? "execute";
  // A model can request execution, but an action plan can only become a
  // preview. The authenticated confirmation action is the sole commit path.
  const mode = validated.hasActions ? "dry_run" : requestedMode;
  const ledger = input.ledger ?? databaseWorkflowLedger;
  const clock = input.clock ?? systemClock;
  const preview = {
    version: validated.plan.version,
    step_count: validated.plan.steps.length,
    cost_units: validated.costUnits,
    steps: validated.summary.steps,
  } as const;

  if (mode === "dry_run" && !validated.hasActions) {
    const completedAt = clock.now().toISOString();
    const previewed = initialStepStates(validated).map((step) => ({
      ...step,
      status: "previewed" as const,
      completed_at: completedAt,
      duration_ms: 0,
    }));
    const run = await ledger.create({
      clinicId: input.user.clinicId,
      userId: input.user.id,
      aiRequestId: input.aiRequestId ?? null,
      mode,
      state: "previewed",
      planSummary: validated.summary,
      stepStates: previewed,
      stepCount: validated.plan.steps.length,
      costUnits: validated.costUnits,
      dryRunSnapshotHash: workflowPreviewHash(validated.summary),
    });
    return {
      run_id: run.id,
      mode,
      state: "previewed",
      partial_failure: false,
      steps: previewed,
      preview,
    };
  }

  if (validated.hasActions) {
    // The id exists before any preview tool runs so action previews receive the
    // same stable identity that will later guard dispatch/booking idempotency.
    const placeholderHash = workflowPreviewHash(validated.summary);
    const placeholder = initialStepStates(validated);
    const run = await ledger.create({
      clinicId: input.user.clinicId,
      userId: input.user.id,
      aiRequestId: input.aiRequestId ?? null,
      mode: "dry_run",
      state: "previewed",
      planSummary: validated.summary,
      stepStates: placeholder,
      stepCount: validated.plan.steps.length,
      costUnits: validated.costUnits,
      dryRunSnapshotHash: placeholderHash,
    });
    const previewRun = await runSteps({
      validated,
      definitions: input.definitions,
      tools: input.tools,
      runId: run.id,
      mode: "preview",
      clinicId: input.user.clinicId,
      userId: input.user.id,
      abortSignal: input.abortSignal,
      clock,
    });
    const snapshotHash = workflowActionSnapshotHash(
      validated.plan,
      previewRun.results,
    );
    const confirmable = previewRun.states.every((step) =>
      ["succeeded", "previewed"].includes(step.status),
    );
    await ledger.update(input.user.clinicId, input.user.id, run.id, {
      state: "previewed",
      stepStates: previewRun.states,
      completedAt: clock.now().toISOString(),
      errorCode: confirmable ? null : "preview_has_failed_steps",
      dryRunSnapshotHash: snapshotHash,
    });
    return {
      run_id: run.id,
      mode: "dry_run",
      state: "previewed",
      partial_failure: false,
      requires_confirmation: confirmable,
      steps: previewRun.results,
      preview,
    };
  }

  const startedAt = clock.now().toISOString();
  const run = await ledger.create({
    clinicId: input.user.clinicId,
    userId: input.user.id,
    aiRequestId: input.aiRequestId ?? null,
    mode: "execute",
    state: "running",
    planSummary: validated.summary,
    stepStates: initialStepStates(validated),
    stepCount: validated.plan.steps.length,
    costUnits: validated.costUnits,
    dryRunSnapshotHash: null,
  });
  const execution = await runSteps({
    validated,
    definitions: input.definitions,
    tools: input.tools,
    runId: run.id,
    mode: "execute",
    clinicId: input.user.clinicId,
    userId: input.user.id,
    abortSignal: input.abortSignal,
    ledger,
    clock,
  });
  const state = terminalState(execution.states);
  await ledger.update(input.user.clinicId, input.user.id, run.id, {
    state,
    stepStates: execution.states,
    startedAt,
    completedAt: clock.now().toISOString(),
    errorCode: state === "succeeded" ? null : "partial_or_failed_steps",
  });
  return {
    run_id: run.id,
    mode: "execute",
    state,
    partial_failure: state === "partially_failed",
    steps: execution.results,
  };
}

export async function confirmOrResumeWorkflow(input: {
  user: AuthedUser;
  runId: string;
  plan: unknown;
  definitions: readonly WorkflowMountDefinition[];
  tools: Readonly<Record<string, Tool>>;
  abortSignal?: AbortSignal;
  ledger?: WorkflowLedger;
  clock?: Clock;
}): Promise<WorkflowExecutionResult | null> {
  await assertWorkflowAccess(input.user);
  const validated = await validateWorkflowPlan({
    plan: input.plan,
    definitions: input.definitions,
    tools: input.tools,
  });
  if (!validated.hasActions) return null;

  const ledger = input.ledger ?? databaseWorkflowLedger;
  const clock = input.clock ?? systemClock;
  if (!ledger.get || !ledger.claimConfirmation) return null;
  const stored = await ledger.get(
    input.user.clinicId,
    input.user.id,
    input.runId,
  );
  if (
    !stored ||
    workflowPreviewHash(stored.planSummary) !==
      workflowPreviewHash(validated.summary)
  ) {
    return null;
  }

  let resumeStates = stored.stepStates;
  if (!stored.confirmedAt) {
    if (stored.state !== "previewed" || !stored.dryRunSnapshotHash) return null;
    if (previewExpired(stored.completedAt, clock.now())) {
      throw new WorkflowPlanError("preview_expired");
    }
    const preflight = await runSteps({
      validated,
      definitions: input.definitions,
      tools: input.tools,
      runId: input.runId,
      mode: "preview",
      clinicId: input.user.clinicId,
      userId: input.user.id,
      abortSignal: input.abortSignal,
      clock,
    });
    const currentHash = workflowActionSnapshotHash(
      validated.plan,
      preflight.results,
    );
    if (currentHash !== stored.dryRunSnapshotHash) {
      throw new WorkflowPlanError("preview_stale");
    }
    if (previewExpired(stored.completedAt, clock.now())) {
      throw new WorkflowPlanError("preview_expired");
    }
    const confirmedActionInputsHash = workflowActionInputsHash(
      preflight.actionInputs,
    );
    const confirmedAt = clock.now().toISOString();
    const claimed = await ledger.claimConfirmation(
      input.user.clinicId,
      input.user.id,
      input.runId,
      currentHash,
      confirmedActionInputsHash,
      confirmedAt,
    );
    if (!claimed) return null;
    resumeStates = preflight.states;
  } else if (
    stored.confirmedBy !== input.user.id ||
    !["running", "partially_failed", "failed", "needs_clarification"].includes(
      stored.state,
    )
  ) {
    return null;
  } else {
    if (!stored.dryRunSnapshotHash) return null;
    const rebound = await runSteps({
      validated,
      definitions: input.definitions,
      tools: input.tools,
      runId: input.runId,
      mode: "preview",
      clinicId: input.user.clinicId,
      userId: input.user.id,
      abortSignal: input.abortSignal,
      clock,
      // Completed actions may have changed the data they previewed (notably a
      // pending booking consuming availability). Reconstruct only the resolved
      // inputs; do not invoke any action while checking resume integrity.
      skipActionExecution: true,
    });
    if (
      workflowActionInputsHash(rebound.actionInputs) !==
      stored.dryRunSnapshotHash
    ) {
      throw new WorkflowPlanError("preview_stale");
    }
  }

  const execution = await runSteps({
    validated,
    definitions: input.definitions,
    tools: input.tools,
    runId: input.runId,
    mode: "execute",
    clinicId: input.user.clinicId,
    userId: input.user.id,
    abortSignal: input.abortSignal,
    ledger,
    clock,
    resumeStates,
  });
  const state = terminalState(execution.states);
  const completedAt = clock.now().toISOString();
  await ledger.update(input.user.clinicId, input.user.id, input.runId, {
    mode: "execute",
    state,
    stepStates: execution.states,
    completedAt,
    errorCode: state === "succeeded" ? null : "partial_or_failed_steps",
  });
  return {
    run_id: input.runId,
    mode: "execute",
    state,
    partial_failure: state === "partially_failed",
    resumable:
      state !== "succeeded" &&
      validated.plan.steps.some(
        (step, index) =>
          actionKind(input.definitions, step.tool) &&
          execution.states[index]?.status !== "succeeded",
      ),
    steps: execution.results,
  };
}
