import "server-only";

import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import {
  asDatabaseJson,
  type WorkflowLedger,
  type WorkflowLedgerCreate,
  type WorkflowLedgerUpdate,
} from "@/lib/ai/workflows/types";

function assertResult(error: { message: string } | null, message: string): void {
  if (error) throw new Error(message);
}

export const databaseWorkflowLedger: WorkflowLedger = {
  async create(input: WorkflowLedgerCreate): Promise<{ id: string }> {
    const client = createClinicScopedAdminClient(input.clinicId);
    const { data, error } = await client
      .from("ai_workflow_runs")
      .insert({
        clinic_id: input.clinicId,
        user_id: input.userId,
        ai_request_id: input.aiRequestId,
        mode: input.mode,
        state: input.state,
        task_class: "staff_workflow",
        plan: asDatabaseJson(input.planSummary),
        step_states: asDatabaseJson(input.stepStates),
        step_count: input.stepCount,
        cost_units: input.costUnits,
        dry_run_snapshot_hash: input.dryRunSnapshotHash,
        started_at: input.state === "running" ? new Date().toISOString() : null,
        completed_at: input.state === "previewed" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    assertResult(error, "Workflow ledger create failed.");
    if (!data?.id) throw new Error("Workflow ledger create failed.");
    return { id: data.id };
  },

  async update(
    clinicId: string,
    userId: string,
    runId: string,
    input: WorkflowLedgerUpdate,
  ): Promise<void> {
    const client = createClinicScopedAdminClient(clinicId);
    const { data, error } = await client
      .from("ai_workflow_runs")
      .update({
        state: input.state,
        step_states: asDatabaseJson(input.stepStates),
        ...(input.startedAt !== undefined ? { started_at: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completed_at: input.completedAt } : {}),
        ...(input.errorCode !== undefined ? { error_code: input.errorCode } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.confirmedBy !== undefined
          ? { confirmed_by: input.confirmedBy }
          : {}),
        ...(input.confirmedAt !== undefined
          ? { confirmed_at: input.confirmedAt }
          : {}),
        ...(input.dryRunSnapshotHash !== undefined
          ? { dry_run_snapshot_hash: input.dryRunSnapshotHash }
          : {}),
      })
      .eq("id", runId)
      .eq("user_id", userId)
      .select("id")
      .single();
    assertResult(error, "Workflow ledger update failed.");
    if (!data?.id) throw new Error("Workflow ledger update failed.");
  },

  async get(clinicId, userId, runId) {
    const client = createClinicScopedAdminClient(clinicId);
    const { data, error } = await client
      .from("ai_workflow_runs")
      .select(
        "id, clinic_id, user_id, mode, state, plan, step_states, dry_run_snapshot_hash, confirmed_by, confirmed_at, completed_at",
      )
      .eq("id", runId)
      .eq("user_id", userId)
      .maybeSingle();
    assertResult(error, "Workflow ledger lookup failed.");
    if (!data) return null;
    return {
      id: data.id,
      clinicId: data.clinic_id,
      userId: data.user_id,
      mode: data.mode as "dry_run" | "execute",
      state: data.state as import("@/lib/ai/workflows/types").WorkflowRunState,
      planSummary:
        data.plan as unknown as import("@/lib/ai/workflows/types").WorkflowPlanSummary,
      stepStates:
        data.step_states as unknown as import("@/lib/ai/workflows/types").WorkflowStepLedgerState[],
      dryRunSnapshotHash: data.dry_run_snapshot_hash,
      confirmedBy: data.confirmed_by,
      confirmedAt: data.confirmed_at,
      completedAt: data.completed_at,
    };
  },

  async claimConfirmation(
    clinicId,
    userId,
    runId,
    previewSnapshotHash,
    confirmedActionInputsHash,
    confirmedAt,
  ) {
    const client = createClinicScopedAdminClient(clinicId);
    const { data, error } = await client
      .from("ai_workflow_runs")
      .update({
        mode: "execute",
        state: "running",
        confirmed_by: userId,
        confirmed_at: confirmedAt,
        started_at: confirmedAt,
        completed_at: null,
        error_code: null,
        // Once confirmation is claimed, bind every future resume to the
        // server-resolved action inputs that produced the confirmed preview.
        // This remains a one-way, content-free digest.
        dry_run_snapshot_hash: confirmedActionInputsHash,
      })
      .eq("id", runId)
      .eq("user_id", userId)
      .eq("state", "previewed")
      .eq("dry_run_snapshot_hash", previewSnapshotHash)
      .is("confirmed_at", null)
      .select("id")
      .maybeSingle();
    assertResult(error, "Workflow confirmation claim failed.");
    return data?.id === runId;
  },
};
