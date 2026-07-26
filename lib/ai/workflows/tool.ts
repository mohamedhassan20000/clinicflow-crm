import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { executeReadOnlyWorkflow } from "@/lib/ai/workflows/executor";
import {
  workflowPlanSchema,
  WorkflowPlanError,
} from "@/lib/ai/workflows/plan";

export function executeReadOnlyWorkflowTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Plan one bounded ClinicFlow workflow from the available hidden registry steps. Build the complete plan first. Dependencies must point only to earlier read steps, and a step reference must also name that step in depends_on. Read-only plans may execute. Any plan containing send_appointment_reminders, send_invoice_reminders, or create_pending_booking is always previewed first regardless of dry_run; show the returned preview and wait for the user's on-screen confirmation button. Never claim an action happened from preview output. This tool cannot confirm its own run, schedule work, delete, override status, mutate billing, or call itself.",
    inputSchema: z
      .object({
        plan: workflowPlanSchema,
        dry_run: z.boolean().optional(),
      })
      .strict(),
    execute: async ({ plan, dry_run }, options) => {
      const mount = ctx.workflowStepMount?.();
      if (!mount) {
        return {
          workflow_denied: true as const,
          reason: "workflow_mount_unavailable",
        };
      }
      try {
        const result = await executeReadOnlyWorkflow({
          user: ctx.user,
          plan,
          mode: dry_run ? "dry_run" : "execute",
          definitions: mount.definitions,
          tools: mount.tools,
          aiRequestId: ctx.aiRequestId ?? null,
          abortSignal: options.abortSignal,
        });
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "execute_read_only_workflow",
          tableName: "ai_workflow_runs",
          recordId: result.run_id,
          params: {
            mode: result.mode,
            state: result.state,
            step_count: result.steps.length,
          },
        });
        return result;
      } catch (error) {
        if (!(error instanceof WorkflowPlanError)) throw error;
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "execute_read_only_workflow",
          tableName: "ai_workflow_runs",
          params: {
            outcome: "denied",
            reason: error.reason,
            step_id_present: Boolean(error.stepId),
          },
        });
        return {
          workflow_denied: true as const,
          reason: error.reason,
          step_id: error.stepId,
        };
      }
    },
  });
}
