import "server-only";

import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LanguageModelUsage } from "ai";

type AiJsonValue = string | number | boolean | null | AiJsonValue[] | {
  [key: string]: AiJsonValue | undefined;
};
export type AiProviderOptions = Record<string, Record<string, AiJsonValue | undefined>>;

export type AiTaskClass =
  | "staff_clinical_summary"
  | "staff_administrative"
  | "patient_booking"
  | "patient_faq";

export type AiSurface = "staff_assistant" | "patient_messaging";
export type AiPersona = "doctor" | "administrative_staff" | "patient";
export type AiCredentialMode = "managed" | "byok_strict" | "hybrid";
export type AiTransport = "vercel_ai_gateway" | "anthropic_direct" | "anthropic_direct_hybrid";

export type AiTokenPricing = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
};

export type CertifiedModelRoute = {
  alias: string;
  transport: "vercel_ai_gateway";
  provider: string;
  modelId: string;
  providerModelId: string;
  allowedServingProviders: readonly string[];
  capabilities: readonly ("streaming" | "tool_calling" | "arabic" | "english")[];
  privacy: {
    zeroDataRetentionRequired: true;
    noTrainingRequired: true;
  };
  pricing: AiTokenPricing;
  certification: {
    status: "bootstrap_approved" | "eval_certified";
    version: string;
    evaluationSuiteVersion: string;
    effectiveDate: string;
    rollbackAlias: string | null;
  };
};

export type CertifiedTaskPolicy = {
  task: AiTaskClass;
  version: string;
  primaryModelAlias: string;
  fallbackModelAliases: readonly string[];
  allowedPersonas: readonly AiPersona[];
  allowedCredentialModes: readonly AiCredentialMode[];
  maxInputTokensPerStep: number;
  maxOutputTokens: number;
  maxSteps: number;
  temperature: number;
  privacyPolicyVersion: string;
};

export type AiProviderRequest = {
  route: CertifiedModelRoute;
  task: AiTaskClass;
  surface: AiSurface;
  clinicId: string;
  actorId: string;
  policyVersion: string;
};

export type PreparedAiProvider = {
  model: LanguageModelV3;
  providerOptions: AiProviderOptions;
  transport: AiTransport;
};

export interface AiExecutionProvider {
  readonly mode: AiCredentialMode;
  prepare(request: AiProviderRequest): PreparedAiProvider;
}

export type AiUsageAttempt = {
  attempt_id: string;
  attempt_sequence: number;
  fallback_parent_attempt_id: string | null;
  provider: string;
  model: string;
  model_alias: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  latency_ms: number | null;
  status: "success" | "failed" | "aborted";
  error_class: string | null;
  estimated_cost_micros: number;
  final_cost_micros: number;
};

export type AiObservedStep = {
  stepNumber: number;
  model: { provider: string; modelId: string };
  response: { modelId: string };
  finishReason: string;
  usage: LanguageModelUsage;
};

export type AiExecutionOutcome = "success" | "failed" | "aborted";

export type AiExecutionHandle = PreparedAiProvider & {
  requestId: string;
  taskPolicy: CertifiedTaskPolicy;
  route: Pick<CertifiedModelRoute, "alias">;
  legacyUsage: { used: number; limit: number; remaining: number };
  beginStep(): void;
  observeStep(step: AiObservedStep): void;
  finalize(input: {
    outcome: AiExecutionOutcome;
    errorClass?: string | null;
  }): Promise<void>;
};
