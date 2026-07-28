import "server-only";

import { ToolLoopAgent, stepCountIs, type UIMessage } from "ai";
import { assertAiInputWithinPolicy, type AiExecutionHandle } from "@/lib/ai/client";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import { buildPatientSystemPrompt } from "@/lib/ai/prompts/patient";
import {
  buildPatientTools,
} from "@/lib/ai/patient-tools";
import type { PatientToolContext } from "@/lib/ai/patient-authorization";

type PatientAgentContext = {
  clinicId: string;
  conversationId: string;
  locale: PromptLocale;
  execution: AiExecutionHandle;
};

export function createPatientAgent(ctx: PatientAgentContext) {
  const task = ctx.execution.taskPolicy.task;
  if (task !== "patient_booking" && task !== "patient_faq") {
    throw new Error("Patient agent requires a certified patient task class.");
  }
  const toolContext: PatientToolContext = {
    clinicId: ctx.clinicId,
    conversationId: ctx.conversationId,
    locale: ctx.locale,
    aiRequestId: ctx.execution.requestId,
  };

  return new ToolLoopAgent({
    id: "clinicflow-patient-assistant",
    model: ctx.execution.model,
    providerOptions: ctx.execution.providerOptions,
    instructions: buildPatientSystemPrompt(ctx.locale),
    tools: buildPatientTools(toolContext, task),
    stopWhen: stepCountIs(ctx.execution.taskPolicy.maxSteps),
    temperature: ctx.execution.taskPolicy.temperature,
    maxOutputTokens: ctx.execution.taskPolicy.maxOutputTokens,
    prepareStep: ({ messages }) => {
      ctx.execution.beginStep();
      assertAiInputWithinPolicy(
        messages,
        ctx.execution.taskPolicy.maxInputTokensPerStep,
      );
      return {};
    },
    onStepFinish: ctx.execution.observeStep,
  });
}

export type PatientAssistantUIMessage = UIMessage;
