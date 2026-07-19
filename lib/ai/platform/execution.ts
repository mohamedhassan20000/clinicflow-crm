import "server-only";

import * as Sentry from "@sentry/nextjs";
import { createHash, randomUUID } from "node:crypto";
import { calculateUsageCostMicros, calculateWorstCaseCostMicros } from "@/lib/ai/platform/cost";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";
import { resolveAiProviderCredential } from "@/lib/ai/platform/provider-connections";
import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import { prepareTenantProvider } from "@/lib/ai/platform/tenant-provider";
import type {
  AiExecutionHandle,
  AiExecutionOutcome,
  AiObservedStep,
  AiPersona,
  AiSurface,
  AiTaskClass,
  AiUsageAttempt,
} from "@/lib/ai/platform/types";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { assertAiTurnAllowed } from "@/lib/ai/usage";
import { logAiProviderFallback, reconcileAiBudget, reserveAiBudget } from "@/lib/supabase/admin";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";
import { getEntitlements, hasAiProviderMode, hasFeature } from "@/lib/entitlements";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";

const RESERVATION_LEASE_SECONDS = 600;

function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable across a transport retry, without hashing or retaining message content.
 * A new logical send/regenerate action must use a new client message id: finalized
 * request ids are intentionally never reusable in the durable reservation ledger.
 */
export function createAiRequestId(input: {
  clinicId: string;
  actorId: string;
  conversationId: string;
  messageId: string;
}): string {
  return stableUuid(
    ["clinicflow-ai-v1", input.clinicId, input.actorId, input.conversationId, input.messageId].join(":"),
  );
}

/**
 * Conservative pre-provider guard: a tokenizer cannot produce more tokens
 * than the UTF-8 bytes supplied. JSON overhead intentionally makes this check
 * stricter, ensuring actual input stays inside the amount cost-reserved.
 */
export function assertAiInputWithinPolicy(messages: unknown, maxInputTokens: number): void {
  const serialized = JSON.stringify(messages);
  if (Buffer.byteLength(serialized, "utf8") > maxInputTokens) {
    const error = new Error("AI input exceeds the certified task policy.");
    error.name = "AiPolicyInputLimitError";
    throw error;
  }
}

export function staffTaskForRole(role: AuthedUser["role"]): {
  task: AiTaskClass;
  persona: AiPersona;
} {
  return role === "doctor"
    ? { task: "staff_clinical_summary", persona: "doctor" }
    : { task: "staff_administrative", persona: "administrative_staff" };
}

function isBudgetDenial(message: string | undefined): boolean {
  return message?.includes("AI_BUDGET_EXCEEDED") === true ||
    message?.includes("AI_BUDGET_CONCURRENCY_EXCEEDED") === true ||
    message?.includes("USAGE_LIMIT_EXCEEDED") === true;
}

function safeErrorClass(value: string | null | undefined): string | null {
  if (!value) return null;
  const allowed = new Set([
    "client_aborted",
    "stream_failed",
    "request_failed",
    "provider_step_error",
    "provider_timeout",
  ]);
  return allowed.has(value) ? value : "execution_failed";
}

function stepStatus(finishReason: string): AiUsageAttempt["status"] {
  return finishReason === "error" ? "failed" : finishReason === "other" ? "aborted" : "success";
}

export async function prepareAiExecution(input: {
  user: AuthedUser;
  requestId: string;
  task: AiTaskClass;
  persona: AiPersona;
  surface: AiSurface;
  now?: Date;
}): Promise<AiExecutionHandle> {
  const now = input.now ?? new Date();
  const taskPolicy = getTaskPolicy(input.task, input.persona);
  const route = getCertifiedModelRoute(taskPolicy);
  const credential = await resolveAiProviderCredential(input.user.clinicId);
  const entitlements = await getEntitlements(input.user.clinicId);
  if (
    !hasFeature(entitlements, AI_ASSISTANT_FEATURE) ||
    !hasFeature(entitlements, "ai.staff_assistant") ||
    !hasAiProviderMode(entitlements, credential.mode)
  ) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
  if (!taskPolicy.allowedCredentialModes.includes(credential.mode)) {
    throw new AiToolAuthorizationError("lookup_failed", "AI provider mode is not permitted.");
  }
  const attempts: AiUsageAttempt[] = [];
  let fallbackRootAttemptId: string | null = null;
  const providerRequest = {
    route,
    task: input.task,
    surface: input.surface,
    clinicId: input.user.clinicId,
    actorId: input.user.id,
    policyVersion: taskPolicy.version,
  } as const;
  const transport = credential.mode === "managed"
    ? "vercel_ai_gateway"
    : credential.mode === "byok_strict"
      ? "anthropic_direct"
      : "anthropic_direct_hybrid";
  // Product decision (roadmap §8): the ai_messages unit is a ClinicFlow
  // request / fair-use cap, not a managed-token cost meter. It is deliberately
  // retained for every credential mode — including byok_strict and hybrid —
  // because "BYOK clinics remain subject to ClinicFlow authorization, safety,
  // fair-use, request/concurrency limits, and platform fees even when provider
  // token cost is billed directly to them" (§8). A BYOK clinic still consumes
  // one request unit per successful AI turn; only its provider token spend is
  // removed from ClinicFlow's included-credit pool (via the reconcile wrapper).
  // Decoupling this cap from BYOK is explicitly NOT the roadmap position and is
  // not done here.
  const legacy = await assertAiTurnAllowed(input.user.clinicId, now);
  const reservedCostMicros = calculateWorstCaseCostMicros(taskPolicy, route);
  // The RPC resolves the same authoritative plan/snapshot limit again inside its
  // transaction; this app-side value remains a backward-compatible reservation
  // hint.
  const budgetLimitMicros = legacy.limit * reservedCostMicros;
  const leaseToken = randomUUID();
  const periodStart = monthStart(now);
  let reservation: Database["public"]["Functions"]["reserve_ai_budget"]["Returns"][number];
  try {
    const result = await reserveAiBudget({
      requestId: input.requestId,
      leaseToken,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      periodStart,
      surface: input.surface,
      persona: input.persona,
      task: input.task,
      transport,
      expectedProvider: route.provider,
      expectedModel: route.modelId,
      modelAlias: route.alias,
      fallbackModelAliases: [...taskPolicy.fallbackModelAliases],
      policyVersion: taskPolicy.version,
      certificationVersion: route.certification.version,
      privacyPolicyVersion: taskPolicy.privacyPolicyVersion,
      reservedCostMicros,
      budgetLimitMicros,
      leaseSeconds: RESERVATION_LEASE_SECONDS,
      credentialMode: credential.mode,
    });
    if (result.error) {
      if (isBudgetDenial(result.error.message)) {
        throw new AiToolAuthorizationError("usage_limit_reached");
      }
      throw result.error;
    }
    reservation = result.data?.[0];
    if (!reservation?.acquired || !reservation.reservation_id) {
      throw new AiToolAuthorizationError(
        "lookup_failed",
        "This AI request has already been handled or is still in progress.",
      );
    }
  } catch (error) {
    if (error instanceof AiToolAuthorizationError) throw error;
    Sentry.captureException(error, {
      tags: { area: "ai-budget-reservation" },
      extra: { clinicId: input.user.clinicId, task: input.task },
    });
    throw new AiToolAuthorizationError(
      "lookup_failed",
      "AI usage is temporarily unavailable. Please try again.",
    );
  }

  const provider = credential.mode === "managed"
    ? managedGatewayProvider.prepare(providerRequest)
    : prepareTenantProvider({
        mode: credential.mode,
        secret: credential.secret,
        request: providerRequest,
        async onFallback(errorClass) {
          const audit = await logAiProviderFallback({
            clinicId: input.user.clinicId,
            actorId: input.user.id,
            requestId: input.requestId,
            provider: credential.provider,
            errorClass,
          });
          if (audit.error) throw audit.error;
          const attemptId = randomUUID();
          attempts.push({
            attempt_id: attemptId,
            attempt_sequence: attempts.length,
            fallback_parent_attempt_id: null,
            provider: route.provider,
            model: route.providerModelId,
            model_alias: route.alias,
            input_tokens: null,
            output_tokens: null,
            cached_input_tokens: null,
            cache_write_tokens: null,
            reasoning_tokens: null,
            latency_ms: null,
            status: "failed",
            error_class: errorClass,
            estimated_cost_micros: 0,
            final_cost_micros: 0,
          });
          fallbackRootAttemptId = attemptId;
        },
      });

  let finalized = false;
  let lastObservedAt = Date.now();
  let currentStepStartedAt: number | null = null;

  function beginStep(): void {
    if (finalized) return;
    currentStepStartedAt = Date.now();
  }

  function observeStep(step: AiObservedStep): void {
    if (finalized) return;
    const observedAt = Date.now();
    const latencyStartedAt = currentStepStartedAt ?? lastObservedAt;
    const cost = calculateUsageCostMicros(route.pricing, step.usage);
    attempts.push({
      attempt_id: randomUUID(),
      attempt_sequence: attempts.length,
      fallback_parent_attempt_id: fallbackRootAttemptId,
      provider: step.model.provider || route.provider,
      model: step.response.modelId || step.model.modelId || route.modelId,
      model_alias: route.alias,
      input_tokens: step.usage.inputTokens ?? null,
      output_tokens: step.usage.outputTokens ?? null,
      cached_input_tokens: step.usage.inputTokenDetails.cacheReadTokens ?? null,
      cache_write_tokens: step.usage.inputTokenDetails.cacheWriteTokens ?? null,
      reasoning_tokens: step.usage.outputTokenDetails.reasoningTokens ?? null,
      latency_ms: Math.max(0, observedAt - latencyStartedAt),
      status: stepStatus(step.finishReason),
      error_class: step.finishReason === "error" ? "provider_step_error" : null,
      estimated_cost_micros: cost,
      final_cost_micros: cost,
    });
    currentStepStartedAt = null;
    lastObservedAt = observedAt;
  }

  async function finalize(final: {
    outcome: AiExecutionOutcome;
    errorClass?: string | null;
  }): Promise<void> {
    if (finalized) return;
    finalized = true;
    const errorClass = safeErrorClass(final.errorClass);
    if (attempts.length === 0) {
      attempts.push({
        attempt_id: randomUUID(),
        attempt_sequence: 0,
        fallback_parent_attempt_id: null,
        provider: route.provider,
        model: route.modelId,
        model_alias: route.alias,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        latency_ms: Math.max(0, Date.now() - (currentStepStartedAt ?? lastObservedAt)),
        status: final.outcome,
        error_class: errorClass,
        estimated_cost_micros: 0,
        final_cost_micros: 0,
      });
    } else if (final.outcome !== "success") {
      const terminalSequence = Math.max(...attempts.map((attempt) => attempt.attempt_sequence)) + 1;
      attempts.push({
        attempt_id: randomUUID(),
        attempt_sequence: terminalSequence,
        fallback_parent_attempt_id: attempts.at(-1)?.attempt_id ?? null,
        provider: route.provider,
        model: route.modelId,
        model_alias: route.alias,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        latency_ms: null,
        status: final.outcome,
        error_class: errorClass,
        estimated_cost_micros: 0,
        final_cost_micros: 0,
      });
    }
    const actualCostMicros = attempts.reduce((sum, attempt) => sum + attempt.final_cost_micros, 0);
    const managedCostMicros = attempts.reduce((sum, attempt) => {
      if (credential.mode === "byok_strict") return sum;
      // Mirror the database billing-disposition trigger exactly so this
      // application-supplied managed split equals the DB-derived managed_included
      // sum the reconcile wrapper re-derives (a mismatch fails closed). For
      // hybrid, only a successful post-fallback attempt is managed_included;
      // pre-fallback and failed attempts are direct/nonbillable and stay out of
      // ClinicFlow's managed pool.
      if (
        credential.mode === "hybrid" &&
        (attempt.fallback_parent_attempt_id === null || attempt.status !== "success")
      ) {
        return sum;
      }
      return sum + attempt.final_cost_micros;
    }, 0);
    const reconciliation = {
      reservationId: reservation.reservation_id,
      leaseToken,
      outcome: final.outcome,
      attempts,
      actualCostMicros,
      managedCostMicros,
      errorClass,
    } as const;
    let result = await reconcileAiBudget(reconciliation);
    // The RPC is lease-bound and idempotent. One immediate retry covers a lost
    // response/transient PostgREST failure without risking duplicate events.
    if (result.error) result = await reconcileAiBudget(reconciliation);
    if (result.error) throw result.error;
  }

  return {
    ...provider,
    requestId: input.requestId,
    taskPolicy,
    route: { alias: route.alias },
    legacyUsage: {
      used: reservation.legacy_used,
      limit: reservation.legacy_limit,
      remaining: Math.max(0, reservation.legacy_limit - reservation.legacy_used),
    },
    beginStep,
    observeStep,
    finalize,
  };
}
