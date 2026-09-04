import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { previewRegisteredAction } from "@/lib/ai/actions/execute";
import type { ActionInvocationResult } from "@/lib/ai/actions/types";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

const executeActionInputSchema = z
  .object({
    action: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

function modelSafeOutput(output: ActionInvocationResult) {
  if (output.phase !== "preview" || !("confirm_token" in output)) return output;
  return {
    action_id: output.action_id,
    phase: output.phase,
    risk_class: output.risk_class,
    confirmation_required: true as const,
    step_up_required: output.step_up_required,
    expires_at: output.expires_at,
    preview: output.preview,
    guidance:
      "Show this preview and wait. Only the user's on-screen confirmation button can execute it; never call another tool to confirm it.",
  };
}

export function executeActionTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Preview one registered ClinicFlow action. This model-facing tool never commits a write: it validates authorization and input, runs the action's dry-run preview, and returns a human confirmation card. The confirm token is withheld from model context and only the authenticated on-screen button may execute. Use describe_action when the action contract is unclear. Available actions are permission-filtered at execution and may include bounded reminders or one pending booking.",
    inputSchema: executeActionInputSchema,
    execute: async ({ action, input }) => {
      if (!ctx.conversationId) {
        return {
          action_id: action,
          phase: "preview" as const,
          action_denied: true as const,
          confirmation_required: false as const,
          reason: "invalid_request" as const,
        };
      }
      return previewRegisteredAction({
        user: ctx.user,
        conversationId: ctx.conversationId,
        aiRequestId: ctx.aiRequestId ?? null,
        actionId: action,
        actionInput: input,
      });
    },
    // The UI receives the full tool output so its button can send the opaque
    // token to the authenticated Server Action. The model receives a redacted
    // projection with no token, preventing self-confirmation in a later step.
    toModelOutput: ({ output }) => ({
      type: "json",
      value: modelSafeOutput(output) as never,
    }),
  });
}
