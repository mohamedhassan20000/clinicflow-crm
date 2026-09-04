import "server-only";

import { APICallError, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { classifyAiProviderFailure } from "@/lib/ai/platform/failure";

/**
 * Platform protection for direct provider calls.
 *
 * Direct Anthropic changes the blast radius of two failure modes that the
 * gateway used to absorb, so both are handled here rather than at each call
 * site:
 *
 *  1. **One shared account.** Every managed clinic now spends the same
 *     ClinicFlow Anthropic organization's rate limit. A single clinic looping on
 *     a long tool chain could otherwise consume the whole platform's provider
 *     concurrency. The durable per-clinic cap in `reserve_ai_budget`
 *     (`ai_concurrent_requests`) still runs and is unchanged; this adds an
 *     in-process ceiling — global, and a smaller per-clinic share of it — so a
 *     single tenant cannot occupy every slot on a server instance.
 *
 *  2. **Provider 429/5xx.** Retrying these is worth exactly one attempt and no
 *     more. Retries multiply cost, and an uncontrolled retry loop against a
 *     rate-limited account makes the rate limit worse rather than better. So:
 *     at most ONE retry, only for `rate_limit` / `provider_unavailable`, only
 *     when the failure happened before any token was produced, and with a delay
 *     bounded by `RETRY_MAX_DELAY_MS` even if the provider asks for longer.
 *     Everything else fails immediately and is normalized into ClinicFlow's own
 *     error vocabulary so the caller never has to read a provider status code.
 *
 * A saturated semaphore fails as `rate_limit` rather than queueing indefinitely.
 * Failing fast is the safe direction: the turn is denied cleanly, nothing is
 * spent, and the caller's existing budget reconciliation records an ordinary
 * failed attempt.
 */

const DEFAULT_GLOBAL_CONCURRENCY = 32;
const DEFAULT_PER_CLINIC_CONCURRENCY = 8;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
export const RETRY_MAX_ATTEMPTS = 1;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 5_000;

function positiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class AiProviderCapacityError extends Error {
  readonly failureClass = "rate_limit" as const;
  constructor(public readonly scope: "platform" | "clinic") {
    super(`AI provider capacity is saturated (${scope}).`);
    this.name = "AiProviderCapacityError";
  }
}

type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A minimal counting semaphore with a bounded wait. Not fair-queued by design. */
class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number, private readonly scope: "platform" | "clinic") {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new AiProviderCapacityError(this.scope));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
    this.active += 1;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }
}

let globalSemaphore: Semaphore | null = null;
const clinicSemaphores = new Map<string, Semaphore>();

function global(): Semaphore {
  globalSemaphore ??= new Semaphore(
    positiveIntEnv("AI_MANAGED_MAX_CONCURRENCY", DEFAULT_GLOBAL_CONCURRENCY),
    "platform",
  );
  return globalSemaphore;
}

function perClinic(clinicId: string): Semaphore {
  let semaphore = clinicSemaphores.get(clinicId);
  if (!semaphore) {
    semaphore = new Semaphore(
      positiveIntEnv("AI_MANAGED_MAX_CONCURRENCY_PER_CLINIC", DEFAULT_PER_CLINIC_CONCURRENCY),
      "clinic",
    );
    clinicSemaphores.set(clinicId, semaphore);
  }
  return semaphore;
}

/** Test-only reset so concurrency state cannot leak between test files. */
export function resetProviderResilienceState(): void {
  globalSemaphore = null;
  clinicSemaphores.clear();
}

/**
 * Retry delay from the provider's own `retry-after`, clamped. A provider asking
 * for a 60-second pause is telling us to fail the turn, not to hold a request
 * open for a minute — so the clamp deliberately truncates rather than honors.
 */
export function retryDelayMs(error: unknown): number {
  if (!APICallError.isInstance(error)) return RETRY_BASE_DELAY_MS;
  const header =
    error.responseHeaders?.["retry-after"] ?? error.responseHeaders?.["Retry-After"];
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_BASE_DELAY_MS;
  return Math.min(RETRY_MAX_DELAY_MS, Math.ceil(seconds * 1_000));
}

function isRetryable(error: unknown): boolean {
  const failureClass = classifyAiProviderFailure(error);
  return failureClass === "rate_limit" || failureClass === "provider_unavailable";
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function providerResilienceMiddleware(input: {
  clinicId: string;
  /** Overridable for tests; production always uses the real timers. */
  acquireTimeoutMs?: number;
}): LanguageModelMiddleware {
  const acquireTimeoutMs = input.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

  async function guarded<T>(
    run: () => PromiseLike<T>,
    abortSignal: AbortSignal | undefined,
  ): Promise<T> {
    const platform = global();
    await platform.acquire(acquireTimeoutMs);
    const clinic = perClinic(input.clinicId);
    try {
      await clinic.acquire(acquireTimeoutMs);
    } catch (error) {
      platform.release();
      throw error;
    }
    try {
      let attempt = 0;
      for (;;) {
        try {
          return await run();
        } catch (error) {
          // One retry, pre-token only. `doGenerate`/`doStream` rejecting means no
          // stream was established and therefore nothing was billed for content.
          if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryable(error)) throw error;
          attempt += 1;
          await sleep(retryDelayMs(error), abortSignal);
        }
      }
    } finally {
      clinic.release();
      platform.release();
    }
  }

  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params }) {
      return guarded(doGenerate, params.abortSignal);
    },
    async wrapStream({ doStream, params }) {
      return guarded(doStream, params.abortSignal);
    },
  };
}

/** Wraps a direct provider model with the platform concurrency + retry policy. */
export function withProviderResilience(
  model: LanguageModelV3,
  input: { clinicId: string; providerId: string; modelId: string },
): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: providerResilienceMiddleware({ clinicId: input.clinicId }),
    providerId: input.providerId,
    modelId: input.modelId,
  });
}
