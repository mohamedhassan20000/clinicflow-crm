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
import {
  buildToolMemory,
  renderToolMemory,
  staffToolMemoryEnabled,
  withToolMemory,
} from "@/lib/ai/staff-tool-memory";
import {
  createStaffToolCallRepair,
  staffToolCallRepairEnabled,
} from "@/lib/ai/staff-tool-call-repair";
import { evaluateStaffLoopGuard } from "@/lib/ai/staff-loop-guard";

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
  /**
   * The turn's full UI history, including persisted tool parts.
   *
   * Optional and advisory: it is the source for the bounded cross-turn tool
   * memory only (`lib/ai/staff-tool-memory.ts`). It is read here rather than in
   * the route because the projection is gated on the *live* tool mount, which
   * is resolved below — a tool the caller can no longer mount cannot contribute
   * a memory.
   */
  history?: readonly UIMessage[] | null;
};

/**
 * Async because the tool mount is now resolved from the registry, which reads
 * plan entitlements and the caller's per-user AI permissions (P4.6A).
 */
export async function createStaffAgent(ctx: StaffAgentContext) {
  const patientId =
    ctx.user.role === "doctor" || ctx.user.role === "assistant"
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
    // Task policy selects cost/model behavior only. Except for the explicit
    // help containment route, the registry mounts the full authorized union.
    taskClass: ctx.execution.taskPolicy.task,
    conversationId: ctx.conversationId ?? null,
    activePatientId,
    activeContext: ctx.activeContext ?? null,
    contextRecorder: ctx.contextRecorder ?? null,
    aiRequestId: ctx.execution.requestId,
  });

  // Cross-turn tool memory (study §12.1). Projected once per turn against the
  // mount resolved above, then injected per step — `prepareStep`'s messages
  // apply to that step only, so a single injection would vanish after step 0.
  const toolMemoryBlock =
    staffToolMemoryEnabled() && ctx.history?.length
      ? renderToolMemory(buildToolMemory(ctx.history, new Set(Object.keys(tools))))
      : null;

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
    // Two recoverable stops beside the step cap: a model repeating one identical
    // call, and one that has failed too many calls to be converging. Both end
    // the loop so the final message is still produced from what was gathered.
    stopWhen: [
      stepCountIs(ctx.execution.taskPolicy.maxSteps),
      ({ steps }) => evaluateStaffLoopGuard(steps).stop,
    ],
    temperature: ctx.execution.taskPolicy.temperature,
    maxOutputTokens: ctx.execution.taskPolicy.maxOutputTokens,
    // Malformed staff tool calls are repaired into a valid call on a *mounted*
    // tool, or abandoned. The repair only ever subtracts; see the invariants in
    // lib/ai/staff-tool-call-repair.ts.
    ...(staffToolCallRepairEnabled()
      ? {
          experimental_repairToolCall: createStaffToolCallRepair({
            clinicId: ctx.user.clinicId,
            actorId: ctx.user.id,
          }),
        }
      : {}),
    prepareStep: ({ messages }) => {
      ctx.execution.beginStep();
      const withMemory = withToolMemory(messages, toolMemoryBlock);
      // Asserted against the messages actually sent, so recall counts against
      // the same certified per-step input budget as everything else.
      assertAiInputWithinPolicy(withMemory, ctx.execution.taskPolicy.maxInputTokensPerStep);
      return toolMemoryBlock ? { messages: withMemory } : {};
    },
    onStepFinish: ctx.execution.observeStep,
  });
}

// UI messages stay deliberately generic because the mounted tool set varies by
// authenticated role. Tool inputs/outputs are never rendered directly.
export type StaffAssistantUIMessage = UIMessage;
