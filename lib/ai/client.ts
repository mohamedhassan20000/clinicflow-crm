import "server-only";

/**
 * The only public server-side entry point for model execution. Callers choose
 * a certified task/persona, never a raw provider or model identifier.
 */
export {
  createAiRequestId,
  assertAiInputWithinPolicy,
  AiPolicyInputLimitError,
  clampTaskPolicySteps,
  prepareAiExecution,
  staffTaskForRole,
} from "@/lib/ai/platform/execution";
export type {
  AiExecutionHandle,
  AiExecutionOutcome,
  AiPersona,
  AiSurface,
  AiTaskClass,
} from "@/lib/ai/platform/types";
