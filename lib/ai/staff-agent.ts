import "server-only";

import { ToolLoopAgent, stepCountIs, type UIMessage } from "ai";
import { assertAiInputWithinPolicy, type AiExecutionHandle } from "@/lib/ai/client";
import { buildStaffSystemPrompt } from "@/lib/ai/prompts/staff";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import { buildStaffTools } from "@/lib/ai/tools";
import type { AuthedUser } from "@/lib/rbac";
import {
  buildAssistantPageContextPrompt,
  patientIdFromAssistantPageContext,
  type AssistantPageContext,
} from "@/lib/ai/page-context";
import {
  activePatientId as activePatientIdFrom,
  buildActiveContextPrompt,
  type ActiveContext,
  type ConversationContextRecorder,
} from "@/lib/ai/conversation-context";

type StaffAgentContext = {
  user: AuthedUser;
  locale: PromptLocale;
  clinicName: string;
  pageContext?: AssistantPageContext | null;
  execution: AiExecutionHandle;
  /** The conversation this turn belongs to (P4.10A session context). */
  conversationId?: string | null;
  /** The persisted active-entity context for the conversation (P4.10A). */
  activeContext?: ActiveContext | null;
  /** Collects an active-context proposal produced during the turn (P4.10A). */
  contextRecorder?: ConversationContextRecorder | null;
};

/**
 * Async because the tool mount is now resolved from the registry, which reads
 * plan entitlements and the caller's per-user AI permissions (P4.6A).
 */
export async function createStaffAgent(ctx: StaffAgentContext) {
  const patientId = ctx.user.role === "doctor"
    ? patientIdFromAssistantPageContext(ctx.pageContext ?? null)
    : null;

  // P4.10A: the active patient defaults to the conversationally-resolved one and
  // falls back to the patient-bound conversation (page launch). Advisory only —
  // every patient tool re-authorizes the effective id on every call.
  const activePatientId =
    activePatientIdFrom(ctx.activeContext ?? null) ?? patientId;

  const tools = await buildStaffTools({
    user: ctx.user,
    locale: ctx.locale,
    patientId,
    // The registry filters the mount by task class, so the certified policy the
    // turn resolved to also decides which tools exist in it (P4.6A).
    taskClass: ctx.execution.taskPolicy.task,
    conversationId: ctx.conversationId ?? null,
    activePatientId,
    activeContext: ctx.activeContext ?? null,
    contextRecorder: ctx.contextRecorder ?? null,
    aiRequestId: ctx.execution.requestId,
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
      }) +
      buildAssistantPageContextPrompt(ctx.pageContext ?? null, ctx.locale) +
      buildActiveContextPrompt(ctx.activeContext ?? null, ctx.locale),
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
