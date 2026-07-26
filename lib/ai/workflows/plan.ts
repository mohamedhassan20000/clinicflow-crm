import "server-only";

import { createHash } from "node:crypto";
import { asSchema, type Tool } from "ai";
import { z } from "zod";
import type { WorkflowMountDefinition } from "@/lib/ai/tools/context";
import {
  WORKFLOW_MAX_COST_UNITS,
  WORKFLOW_MAX_PLAN_BYTES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_PLAN_VERSION,
  type WorkflowParamSummary,
  type WorkflowPlan,
  type WorkflowPlanSummary,
  type WorkflowReference,
} from "@/lib/ai/workflows/types";

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,99}$/;
const BLOCKED_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const workflowStepSchema = z
  .object({
    id: z.string().regex(STEP_ID_RE),
    tool: z.string().regex(TOOL_NAME_RE),
    input: z.record(z.string(), z.unknown()),
    depends_on: z.array(z.string().regex(STEP_ID_RE)).max(WORKFLOW_MAX_STEPS).default([]),
  })
  .strict();

export const workflowPlanSchema = z
  .object({
    version: z.literal(WORKFLOW_PLAN_VERSION),
    steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_MAX_STEPS),
  })
  .strict();

export type WorkflowPlanDenialReason =
  | "invalid_plan"
  | "plan_too_large"
  | "duplicate_step"
  | "invalid_dependency"
  | "invalid_reference"
  | "unknown_or_unmounted_tool"
  | "non_read_only_tool"
  | "non_workflow_tool"
  | "invalid_action_dependency"
  | "preview_stale"
  | "preview_expired"
  | "step_cost_cap_exceeded"
  | "invalid_step_input"
  | "tool_schema_unavailable";

export class WorkflowPlanError extends Error {
  constructor(
    public readonly reason: WorkflowPlanDenialReason,
    public readonly stepId: string | null = null,
  ) {
    super(reason);
    this.name = "WorkflowPlanError";
  }
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isWorkflowReference(value: unknown): value is WorkflowReference {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "$step" || keys[1] !== "path") return false;
  return (
    typeof value.$step === "string" &&
    STEP_ID_RE.test(value.$step) &&
    Array.isArray(value.path) &&
    value.path.length <= 12 &&
    value.path.every(
      (part) =>
        (typeof part === "number" && Number.isInteger(part) && part >= 0) ||
        (typeof part === "string" &&
          part.length > 0 &&
          part.length <= 100 &&
          !BLOCKED_PATH_KEYS.has(part)),
    )
  );
}

function collectReferences(
  value: unknown,
  references: Set<string>,
  depth = 0,
): void {
  if (depth > 12) throw new WorkflowPlanError("invalid_reference");
  if (isWorkflowReference(value)) {
    references.add(value.$step);
    return;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new WorkflowPlanError("invalid_plan");
    value.forEach((item) => collectReferences(item, references, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw new WorkflowPlanError("invalid_plan");
  for (const [key, nested] of Object.entries(value)) {
    if (BLOCKED_PATH_KEYS.has(key)) throw new WorkflowPlanError("invalid_plan");
    collectReferences(nested, references, depth + 1);
  }
}

function shapeOf(value: unknown): string {
  if (isWorkflowReference(value)) return "step_reference";
  if (Array.isArray(value)) return `array:${Math.min(value.length, 100)}`;
  if (value === null) return "null";
  if (isPlainObject(value)) return `object:${Math.min(Object.keys(value).length, 100)}`;
  return typeof value;
}

function summarizeParam(key: string, value: unknown): WorkflowParamSummary {
  const references = new Set<string>();
  collectReferences(value, references);
  return {
    key,
    shape: shapeOf(value),
    references: [...references].sort(),
  };
}

export function summarizeWorkflowPlan(
  plan: WorkflowPlan,
  costUnits: number,
): WorkflowPlanSummary {
  return {
    version: plan.version,
    step_count: plan.steps.length,
    cost_units: costUnits,
    steps: plan.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      depends_on: [...step.depends_on],
      // Values are intentionally absent. This summary is safe for the durable
      // ledger even when the runtime plan contains patient names or ids.
      params: Object.entries(step.input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => summarizeParam(key, value)),
    })),
  };
}

export function workflowPreviewHash(summary: WorkflowPlanSummary): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(summary)))
    .digest("hex");
}

async function validateToolInput(
  tool: Tool,
  input: Record<string, unknown>,
  stepId: string,
): Promise<void> {
  const schema = asSchema(tool.inputSchema);
  if (!schema.validate) {
    throw new WorkflowPlanError("tool_schema_unavailable", stepId);
  }
  const validation = await schema.validate(input);
  if (!validation.success) {
    throw new WorkflowPlanError("invalid_step_input", stepId);
  }
}

export type ValidatedWorkflowPlan = {
  plan: WorkflowPlan;
  summary: WorkflowPlanSummary;
  costUnits: number;
  hasActions: boolean;
};

/**
 * Validates the complete plan before creating a run. Unknown, unmounted, or
 * non-read-only tools deny the whole plan; no prefix may execute.
 */
export async function validateWorkflowPlan(input: {
  plan: unknown;
  definitions: readonly WorkflowMountDefinition[];
  tools: Readonly<Record<string, Tool>>;
}): Promise<ValidatedWorkflowPlan> {
  if (serializedBytes(input.plan) > WORKFLOW_MAX_PLAN_BYTES) {
    throw new WorkflowPlanError("plan_too_large");
  }
  const parsed = workflowPlanSchema.safeParse(input.plan);
  if (!parsed.success) throw new WorkflowPlanError("invalid_plan");
  const plan = parsed.data;

  const seen = new Set<string>();
  const definitions = new Map(input.definitions.map((definition) => [
    definition.name,
    definition,
  ]));
  let costUnits = 0;
  let hasActions = false;
  const actionSteps = new Set<string>();

  for (const step of plan.steps) {
    if (seen.has(step.id)) throw new WorkflowPlanError("duplicate_step", step.id);

    const definition = definitions.get(step.tool);
    const tool = input.tools[step.tool];
    if (!definition || !tool || typeof tool.execute !== "function") {
      throw new WorkflowPlanError("unknown_or_unmounted_tool", step.id);
    }
    if (definition.workflow.kind === "orchestrator") {
      throw new WorkflowPlanError("non_read_only_tool", step.id);
    }

    const dependencies = new Set(step.depends_on);
    if (dependencies.size !== step.depends_on.length) {
      throw new WorkflowPlanError("invalid_dependency", step.id);
    }
    if ([...dependencies].some((dependency) => !seen.has(dependency))) {
      throw new WorkflowPlanError("invalid_dependency", step.id);
    }

    const references = new Set<string>();
    try {
      collectReferences(step.input, references);
    } catch (error) {
      if (error instanceof WorkflowPlanError) {
        throw new WorkflowPlanError(error.reason, step.id);
      }
      throw error;
    }
    if (
      [...references].some(
        (reference) => !seen.has(reference) || !dependencies.has(reference),
      )
    ) {
      throw new WorkflowPlanError("invalid_reference", step.id);
    }
    if (
      [...dependencies].some((dependency) => actionSteps.has(dependency)) ||
      [...references].some((reference) => actionSteps.has(reference))
    ) {
      // Action outputs are intentionally not durable. Keeping them terminal in
      // a plan lets a safe resume reconstruct all read outputs without ever
      // re-running a completed mutation to feed a later step.
      throw new WorkflowPlanError("invalid_action_dependency", step.id);
    }

    costUnits += definition.workflow.costUnits;
    if (costUnits > WORKFLOW_MAX_COST_UNITS) {
      throw new WorkflowPlanError("step_cost_cap_exceeded", step.id);
    }

    // Inputs containing references are validated after resolution. Literal
    // inputs are rejected before the ledger is created and before any step runs.
    if (references.size === 0) {
      await validateToolInput(tool, step.input, step.id);
    }
    if (definition.workflow.kind === "action") {
      hasActions = true;
      actionSteps.add(step.id);
    }
    seen.add(step.id);
  }

  return {
    plan,
    costUnits,
    hasActions,
    summary: summarizeWorkflowPlan(plan, costUnits),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function workflowActionSnapshotHash(
  plan: WorkflowPlan,
  steps: readonly { id: string; status: string; output?: unknown }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({
      // Hash the exact ephemeral plan values as well as the preview outputs.
      // Only the digest is durable, so PHI stays out of the ledger while a
      // client cannot swap one same-shaped authorized target for another
      // between preview and confirmation.
      plan,
      steps: steps.map((step) => ({
        id: step.id,
        status: step.status,
        output: step.output,
      })),
    })))
    .digest("hex");
}

export function workflowActionInputsHash(
  inputs: readonly {
    id: string;
    tool: string;
    input: Record<string, unknown>;
  }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(inputs)))
    .digest("hex");
}

export function readReference(
  outputs: ReadonlyMap<string, unknown>,
  reference: WorkflowReference,
): unknown {
  let value = outputs.get(reference.$step);
  for (const part of reference.path) {
    if (Array.isArray(value) && typeof part === "number") {
      value = value[part];
      continue;
    }
    if (isPlainObject(value) && typeof part === "string" && !BLOCKED_PATH_KEYS.has(part)) {
      value = value[part];
      continue;
    }
    throw new WorkflowPlanError("invalid_reference");
  }
  if (value === undefined) throw new WorkflowPlanError("invalid_reference");
  return value;
}

export function resolveWorkflowInput(
  value: unknown,
  outputs: ReadonlyMap<string, unknown>,
  depth = 0,
): unknown {
  if (depth > 12) throw new WorkflowPlanError("invalid_reference");
  if (isWorkflowReference(value)) return readReference(outputs, value);
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowInput(item, outputs, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        resolveWorkflowInput(nested, outputs, depth + 1),
      ]),
    );
  }
  return value;
}

export async function validateResolvedWorkflowInput(
  tool: Tool,
  input: Record<string, unknown>,
  stepId: string,
): Promise<void> {
  return validateToolInput(tool, input, stepId);
}
