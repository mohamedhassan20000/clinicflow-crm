import "server-only";

import { ToolLoopAgent, stepCountIs, type UIMessage } from "ai";
import { assertAiInputWithinPolicy, type AiExecutionHandle } from "@/lib/ai/client";
import { buildStaffSystemPrompt } from "@/lib/ai/prompts/staff";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import { buildStaffTools } from "@/lib/ai/tools";
import type { AuthedUser } from "@/lib/rbac";

type StaffAgentContext = {
  user: AuthedUser;
  locale: PromptLocale;
  clinicName: string;
  patientId?: string | null;
  execution: AiExecutionHandle;
};

/**
 * Async because the tool mount is now resolved from the registry, which reads
 * plan entitlements and the caller's per-user AI permissions (P4.6A).
 */
export async function createStaffAgent(ctx: StaffAgentContext) {
  const patientContext = ctx.user.role === "doctor" && ctx.patientId
    ? `\n\nThis chat was opened from a patient profile. When the user refers to "this patient", use the internal patient id "${ctx.patientId}" as the patient_id tool argument. Never display that internal id in your answer.`
    : "";

  const tools = await buildStaffTools({
    user: ctx.user,
    locale: ctx.locale,
    patientId: ctx.user.role === "doctor" ? ctx.patientId : null,
    // The registry filters the mount by task class, so the certified policy the
    // turn resolved to also decides which tools exist in it (P4.6A).
    taskClass: ctx.execution.taskPolicy.task,
  });

  return new ToolLoopAgent({
    id: `clinicflow-${ctx.user.role}-assistant`,
    model: ctx.execution.model,
    providerOptions: ctx.execution.providerOptions,
    instructions:
      buildStaffSystemPrompt({
        locale: ctx.locale,
        clinicName: ctx.clinicName,
        doctorName: ctx.user.fullName,
        role: ctx.user.role,
      }) + patientContext,
    tools,
    stopWhen: stepCountIs(ctx.execution.taskPolicy.maxSteps),
    temperature: ctx.execution.taskPolicy.temperature,
    maxOutputTokens: ctx.execution.taskPolicy.maxOutputTokens,
    prepareStep: ({ messages }) => {
      ctx.execution.beginStep();
      assertAiInputWithinPolicy(messages, ctx.execution.taskPolicy.maxInputTokensPerStep);
      return {};
    },
    onStepFinish: ctx.execution.observeStep,
  });
}

// UI messages stay deliberately generic because the mounted tool set varies by
// authenticated role. Tool inputs/outputs are never rendered directly.
export type StaffAssistantUIMessage = UIMessage;
