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
  /** P4.6A: typed aggregate/list/report queries for administrative personas. */
  | "staff_operational_query"
  /**
   * P4.7A: "how do I use ClinicFlow?" turns. The first class whose tool mount is
   * genuinely narrower than its role would otherwise allow — help and navigation
   * only, no clinic data at all — which is why it also routes to a cheaper model.
   */
  | "staff_help"
  /**
   * Multi-step staff work. Unlike the retired workflow class this is a normal
   * agent loop over the caller's full authorized mount.
   */
  | "staff_composite"
  | "patient_booking"
  | "patient_faq";

export type AiSurface = "staff_assistant" | "patient_messaging";
export type AiPersona = "doctor" | "administrative_staff" | "patient";
export type AiCredentialMode = "managed" | "byok_strict" | "hybrid";
export type AiTransport = "vercel_ai_gateway" | "anthropic_direct" | "anthropic_direct_hybrid";

/**
 * Why a turn ran on the credential it ran on.
 *
 *  * `policy` — the clinic's configured mode, unchanged.
 *  * `auto_byok_fallback` — the clinic is configured for ClinicFlow-managed AI,
 *    the managed allowance was exhausted, and a healthy clinic-owned Anthropic
 *    key carried the turn instead of it being denied.
 *  * `hybrid_degraded_to_byok` — a hybrid clinic ran direct-only, because the
 *    managed leg it would otherwise fall back to has no allowance left.
 *
 * Recorded on the reservation so an operator can answer "whose key paid for
 * this month?" from the ledger rather than by inference.
 */
export type AiProviderResolutionReason =
  | "policy"
  | "auto_byok_fallback"
  | "hybrid_degraded_to_byok";

/**
 * Privacy posture of a certified route, split by what is actually enforceable.
 *
 * The two halves are deliberately NOT interchangeable, and the split exists
 * because conflating them was a real defect: the pre-P12 route carried a single
 * `zeroDataRetentionRequired: true` flag, and the only thing that flag ever did
 * was set Vercel AI Gateway's `zeroDataRetention` request option. On any direct
 * Anthropic call it was inert — a claim with no mechanism behind it.
 *
 *  * `gatewayZeroDataRetention` is a TRANSPORT option. It is sent to, and
 *    honored by, Vercel AI Gateway. It says nothing whatsoever about a direct
 *    Anthropic call and is ignored on the direct transport.
 *  * `directProviderRetention` records that on `anthropic_direct` the provider's
 *    retention behavior is governed by the ClinicFlow↔Anthropic commercial
 *    agreement and Anthropic account configuration. Neither is expressible in a
 *    request parameter, so ClinicFlow does not pretend to set it per call.
 *
 * What ClinicFlow *does* enforce in code on every transport is its own data
 * minimization: no prompt, completion, tool payload, patient identifier, or
 * message body is ever written to the usage/audit ledgers
 * (`ai_usage_events` is content-free by database constraint), and the
 * conversation retention job in `lib/ai/retention.ts` bounds what is stored.
 * See `docs/reviews/AI_PROVIDER_DIRECT_ANTHROPIC.md`.
 */
export type AiRoutePrivacy = {
  /** Vercel AI Gateway request flag. Meaningful on the gateway transport only. */
  gatewayZeroDataRetention: boolean;
  /**
   * Not enforceable per request on the direct transport. Documented, contractual,
   * and verified out-of-band — never asserted to the clinic as a code-level control.
   */
  directProviderRetention: "contractual_only";
  noTrainingRequired: true;
};

export type AiTokenPricing = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheReadMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
};

export type CertifiedModelRoute = {
  alias: string;
  /**
   * The transport a MANAGED turn on this route uses by default.
   *
   * `anthropic_direct` since P12: ClinicFlow calls Anthropic itself with its own
   * server-side managed key. `vercel_ai_gateway` remains a registered, non-default
   * alternate transport (see `lib/ai/platform/transport.ts`) and is only reachable
   * through an explicit operator opt-in.
   */
  transport: AiTransport;
  provider: string;
  /** Gateway-qualified id ("anthropic/claude-haiku-4.5"). Gateway transport only. */
  modelId: string;
  /** Native Anthropic model id ("claude-haiku-4-5"). Direct transport. */
  providerModelId: string;
  /** Serving-provider allow-list. Gateway transport only; direct calls Anthropic. */
  allowedServingProviders: readonly string[];
  capabilities: readonly ("streaming" | "tool_calling" | "arabic" | "english")[];
  privacy: AiRoutePrivacy;
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
  /** The credential that actually ran, after ordered resolution. */
  credentialMode: AiCredentialMode;
  resolutionReason: AiProviderResolutionReason;
  legacyUsage: { used: number; limit: number; remaining: number };
  beginStep(): void;
  observeStep(step: AiObservedStep): void;
  finalize(input: {
    outcome: AiExecutionOutcome;
    errorClass?: string | null;
  }): Promise<void>;
};
