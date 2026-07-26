import type { Json } from "@/types/database";

export const WORKFLOW_PLAN_VERSION = 1 as const;
export const WORKFLOW_MAX_STEPS = 6;
export const WORKFLOW_MAX_COST_UNITS = 12;
export const WORKFLOW_MAX_PLAN_BYTES = 24_000;

export type WorkflowRunMode = "dry_run" | "execute";
export type WorkflowRunState =
  | "previewed"
  | "running"
  | "succeeded"
  | "partially_failed"
  | "needs_clarification"
  | "failed";
export type WorkflowStepState =
  | "pending"
  | "previewed"
  | "running"
  | "succeeded"
  | "needs_clarification"
  | "denied"
  | "failed"
  | "skipped";

export type WorkflowReference = {
  $step: string;
  path: Array<string | number>;
};

export type WorkflowStep = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  depends_on: string[];
};

export type WorkflowPlan = {
  version: typeof WORKFLOW_PLAN_VERSION;
  steps: WorkflowStep[];
};

export type WorkflowParamSummary = {
  key: string;
  shape: string;
  references: string[];
};

export type WorkflowPlanSummary = {
  version: typeof WORKFLOW_PLAN_VERSION;
  step_count: number;
  cost_units: number;
  steps: Array<{
    id: string;
    tool: string;
    depends_on: string[];
    params: WorkflowParamSummary[];
  }>;
};

export type WorkflowStepLedgerState = {
  id: string;
  tool: string;
  status: WorkflowStepState;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
};

export type WorkflowLedgerCreate = {
  clinicId: string;
  userId: string;
  aiRequestId: string | null;
  mode: WorkflowRunMode;
  state: WorkflowRunState;
  planSummary: WorkflowPlanSummary;
  stepStates: WorkflowStepLedgerState[];
  stepCount: number;
  costUnits: number;
  dryRunSnapshotHash: string | null;
};

export type WorkflowLedgerUpdate = {
  state: WorkflowRunState;
  stepStates: WorkflowStepLedgerState[];
  mode?: WorkflowRunMode;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  dryRunSnapshotHash?: string | null;
};

export type WorkflowLedgerRun = {
  id: string;
  clinicId: string;
  userId: string;
  mode: WorkflowRunMode;
  state: WorkflowRunState;
  planSummary: WorkflowPlanSummary;
  stepStates: WorkflowStepLedgerState[];
  dryRunSnapshotHash: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
};

export interface WorkflowLedger {
  create(input: WorkflowLedgerCreate): Promise<{ id: string }>;
  update(
    clinicId: string,
    userId: string,
    runId: string,
    input: WorkflowLedgerUpdate,
  ): Promise<void>;
  get?(
    clinicId: string,
    userId: string,
    runId: string,
  ): Promise<WorkflowLedgerRun | null>;
  claimConfirmation?(
    clinicId: string,
    userId: string,
    runId: string,
    previewSnapshotHash: string,
    confirmedActionInputsHash: string,
    confirmedAt: string,
  ): Promise<boolean>;
}

export type WorkflowStepResult = WorkflowStepLedgerState & {
  output?: unknown;
};

export type WorkflowPreview = {
  version: typeof WORKFLOW_PLAN_VERSION;
  step_count: number;
  cost_units: number;
  steps: WorkflowPlanSummary["steps"];
};

export type WorkflowExecutionResult = {
  run_id: string;
  mode: WorkflowRunMode;
  state: WorkflowRunState;
  partial_failure: boolean;
  requires_confirmation?: boolean;
  resumable?: boolean;
  steps: WorkflowStepResult[];
  preview?: WorkflowPreview;
};

export type WorkflowConfirmationResult =
  | { ok: true; result: WorkflowExecutionResult }
  | {
      ok: false;
      reason:
        | "invalid_request"
        | "not_found"
        | "not_confirmable"
        | "preview_stale"
        | "preview_expired"
        | "rate_limited"
        | "denied"
        | "internal_error";
    };

export function asDatabaseJson(value: unknown): Json {
  return value as Json;
}
