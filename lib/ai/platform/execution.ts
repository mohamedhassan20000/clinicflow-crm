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

/**
 * Deterministic operational-intent detection for the task-class router.
 *
 * Keyword-based on purpose: the router decides a *budget and policy*, so it has
 * to be cheap, predictable, and inspectable in a test. An LLM classifier here
 * would mean a model call to decide how much model call to allow.
 *
 * Getting it wrong is safe in both directions — this selects a certified policy
 * from a fixed set, never an authorization. A missed operational turn simply
 * runs on the roomier administrative budget; a false positive runs a chatty turn
 * on a tighter one. Authorization, entitlement, and the tool mount are decided
 * elsewhere and are unaffected.
 */
const OPERATIONAL_INTENT_RE = new RegExp(
  [
    // English: aggregates, lists, reports, financial questions.
    "\\b(how many|how much|count|total|totals|average|rate|rates|trend|trends|compare|comparison)\\b",
    "\\b(list|show me|report|reports|statistics|stats|summary|breakdown|distribution)\\b",
    "\\b(revenue|invoice|invoices|outstanding|unpaid|deposit|deposits|billing|income)\\b",
    "\\b(no.?show|no.?shows|cancellation|cancellations|follow.?up|follow.?ups)\\b",
    // Arabic equivalents.
    "(كم عدد|كم|إجمالي|اجمالي|عدد|متوسط|نسبة|مقارنة|اتجاه)",
    "(قائمة|اعرض|أعرض|تقرير|تقارير|إحصائيات|احصائيات|ملخص|توزيع)",
    "(إيراد|ايراد|إيرادات|ايرادات|فاتورة|فواتير|مستحق|مستحقات|غير مدفوع|دفعة|دفعات)",
    "(عدم الحضور|إلغاء|الغاء|إلغاءات|متابعة|متابعات)",
  ].join("|"),
  "iu",
);

export function isOperationalQueryIntent(text: string | null | undefined): boolean {
  return typeof text === "string" && OPERATIONAL_INTENT_RE.test(text);
}

/**
 * Deterministic help-intent detection (P4.7A).
 *
 * Same keyword approach as the operational router, but held to a **stricter
 * standard**, because the two failure modes are not symmetric. Misrouting an
 * operational turn only changes its budget. Misrouting a turn to `staff_help`
 * also changes its *mount*: the help class is the first one narrow enough to
 * exclude every tool that reads clinic data, so a false positive would leave a
 * real data question with no tool able to answer it.
 *
 * Two guards make that unlikely, and make the residual risk one-directional:
 *
 *  1. The phrasing must look like a request for instructions — "how do I…",
 *     "where is…", "كيف أ…", "أين أجد…" — not merely mention a feature.
 *  2. The turn must not already read as an *aggregation or list* request. This
 *     is narrower than the full operational matcher on purpose. That matcher
 *     flags any domain noun — "invoice", "revenue", "follow-up" — so deferring
 *     to it wholesale would misroute "how do I issue an invoice", a textbook
 *     help question, back to the data class. What actually distinguishes a data
 *     turn is an aggregation or listing verb ("how many", "list", "show me",
 *     "compare", "total"), so only those override an instructional opener.
 *
 * So a missed help turn costs a little money and answers correctly (the help
 * tools are mounted in every class), while a false positive is filtered out by
 * guard 2 in exactly the cases where it would have hurt — "how many invoices are
 * outstanding" keeps its data tools; "how do I issue an invoice" becomes help.
 * That asymmetry is the design, not a happy accident.
 */
const HELP_INTENT_RE = new RegExp(
  [
    // English: asking to be taught or directed.
    "\\b(how (do|can|would) (i|we|you)|how to)\\b",
    "\\bwhere (is|are|do|can) (i|we|it|the|that)\\b",
    "\\b(walk me through|show me how|steps to|guide me|teach me)\\b",
    "\\b(how does .* work|what does .* (button|page|screen|setting) do)\\b",
    // Arabic: كيف/ازاي/وين/فين + طلب الشرح والخطوات.
    "(كيف (أ|ا|ن|ي)|كيفية|ازاي|إزاي)",
    "(اين|أين|وين|فين) (أجد|اجد|هو|هي|يمكن|أستطيع|استطيع)",
    "(اشرح لي|وضح لي|خطوات|كيف استخدم|كيف أستخدم|دلني|علمني)",
  ].join("|"),
  "iu",
);

/**
 * The subset of operational phrasing that overrides an instructional opener:
 * aggregation and listing, not domain nouns. "show me how" is excluded so it
 * stays a help phrase.
 */
const AGGREGATION_LEAD_RE = new RegExp(
  [
    "\\b(how many|how much|count|total|totals|average|rate|rates|trend|trends|compare|comparison|breakdown|distribution|statistics|stats)\\b",
    "\\b(list|report|reports)\\b",
    "\\bshow me (?!how)\\b",
    "(كم عدد|كم |إجمالي|اجمالي|عدد|متوسط|نسبة|مقارنة|اتجاه|توزيع|إحصائيات|احصائيات)",
    "(قائمة|اعرض|أعرض|تقرير|تقارير)",
  ].join("|"),
  "iu",
);

export function isHelpIntent(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  // Guard 2: an aggregation/list request keeps its data tools even when phrased
  // as a question. A bare domain noun does not — that is the difference between
  // this and the full operational matcher.
  if (AGGREGATION_LEAD_RE.test(text)) return false;
  return HELP_INTENT_RE.test(text);
}

/**
 * Resolves the certified task class for a staff turn.
 *
 * Doctors always route to the clinical class. Administrative personas route by
 * the *intent of the turn*, which is what §12 of the expansion proposal
 * describes ("`staff_operational_query` for lists/stats") — not by entitlement.
 *
 * Routing on entitlement instead, as this first did, had a consequence worth
 * spelling out: `ai.staff_analytics` resolves true exactly on `pro_ai`, and
 * `pro`/`basic` have no assistant at all, so *every* administrative turn on
 * every paying clinic ran as `staff_operational_query`. That made
 * `staff_administrative` unreachable in production and silently cut the budget
 * for turns that touch no analytics tool at all — a plain patient lookup, an
 * availability check, an open-ended question — from 8 steps / 1500 tokens to
 * 6 / 1200. The tighter budget is right for typed aggregates and bounded lists;
 * it was never justified for the general administrative persona, and applying
 * it there was a regression against the shipped P4B surface.
 *
 * Intent routing restores the administrative baseline for administrative turns
 * while keeping the cheaper class for the turns it was designed for. The
 * entitlement still matters — without it the analytics tools do not mount — but
 * it decides *capability*, not *budget*.
 */
export function staffTaskForRole(
  role: AuthedUser["role"],
  options: { analyticsEntitled?: boolean; messageText?: string | null } = {},
): {
  task: AiTaskClass;
  persona: AiPersona;
} {
  // Help routing is checked before the persona split because "how do I use
  // this?" is the same question from every role, and answering it out of the
  // clinical budget is the exact waste P4.7 exists to stop. The persona still
  // differs — `staff_help` admits both, and the system prompt is still built
  // from the caller's real role.
  if (isHelpIntent(options.messageText)) {
    return {
      task: "staff_help",
      persona: role === "doctor" ? "doctor" : "administrative_staff",
    };
  }

  if (role === "doctor") {
    return { task: "staff_clinical_summary", persona: "doctor" };
  }

  // The operational class is only meaningful when the operational tools can
  // actually mount, so the entitlement remains a precondition — but it is no
  // longer sufficient on its own.
  const operational =
    options.analyticsEntitled === true && isOperationalQueryIntent(options.messageText);

  return {
    task: operational ? "staff_operational_query" : "staff_administrative",
    persona: "administrative_staff",
  };
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
