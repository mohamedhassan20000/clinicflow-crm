import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  APICallError,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type {
  AiCredentialMode,
  AiProviderOptions,
  AiProviderRequest,
  PreparedAiProvider,
} from "@/lib/ai/platform/types";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";

export type AiProviderFailureClass =
  | "authentication"
  | "permission"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "request_failed";

export function classifyAiProviderFailure(error: unknown): AiProviderFailureClass {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && (error.name === "AbortError" || /timed?\s*out/i.test(error.message))) {
    return "timeout";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) return "authentication";
    if (error.statusCode === 403) return "permission";
    if (error.statusCode === 402) return "quota";
    if (error.statusCode === 429) return "rate_limit";
    if (error.statusCode === undefined || error.statusCode >= 500) {
      return "provider_unavailable";
    }
  }
  return "request_failed";
}

function mergeProviderOptions(
  current: AiProviderOptions | undefined,
  fallback: AiProviderOptions,
): AiProviderOptions {
  return { ...(current ?? {}), ...fallback };
}

function hybridFallbackMiddleware(input: {
  managed: PreparedAiProvider;
  onFallback: (errorClass: AiProviderFailureClass) => Promise<void>;
}): LanguageModelMiddleware {
  let managedActivated = false;

  function managedParams<T extends { providerOptions?: AiProviderOptions }>(params: T): T {
    return {
      ...params,
      providerOptions: mergeProviderOptions(params.providerOptions, input.managed.providerOptions),
    };
  }

  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params }) {
      if (managedActivated) {
        return input.managed.model.doGenerate(managedParams(params));
      }
      try {
        return await doGenerate();
      } catch (error) {
        const errorClass = classifyAiProviderFailure(error);
        if (errorClass === "request_failed") throw error;
        await input.onFallback(errorClass);
        managedActivated = true;
        return input.managed.model.doGenerate(managedParams(params));
      }
    },
    async wrapStream({ doStream, params }) {
      if (managedActivated) {
        return input.managed.model.doStream(managedParams(params));
      }
      try {
        return await doStream();
      } catch (error) {
        const errorClass = classifyAiProviderFailure(error);
        if (errorClass === "request_failed") throw error;
        await input.onFallback(errorClass);
        managedActivated = true;
        return input.managed.model.doStream(managedParams(params));
      }
    },
  };
}

/**
 * Tenant credentials use the direct provider adapter. Current Gateway BYOK
 * always permits system-credential fallback, so it cannot enforce strict mode.
 * Hybrid fallback is consequently explicit, local, audited, and invoked only
 * after the direct provider fails before a stream is established.
 */
export function prepareTenantProvider(input: {
  mode: Exclude<AiCredentialMode, "managed">;
  secret: string;
  request: AiProviderRequest;
  onFallback: (errorClass: AiProviderFailureClass) => Promise<void>;
}): PreparedAiProvider {
  // Fail closed on an empty secret. Otherwise @ai-sdk/anthropic would fall back
  // to a process-level ANTHROPIC_API_KEY, silently serving a BYOK/hybrid turn
  // from an ambient key instead of the tenant's resolved credential.
  if (!input.secret) {
    const error = new Error("BYOK credential secret is empty.");
    error.name = "AiProviderConfigurationError";
    throw error;
  }
  const anthropic = createAnthropic({ apiKey: input.secret });
  const directModel = anthropic(input.request.route.providerModelId);
  if (input.mode === "byok_strict") {
    return {
      model: directModel,
      providerOptions: {},
      transport: "anthropic_direct",
    };
  }

  const managed = managedGatewayProvider.prepare(input.request);
  return {
    model: wrapLanguageModel({
      model: directModel,
      middleware: hybridFallbackMiddleware({
        managed,
        onFallback: input.onFallback,
      }),
      modelId: input.request.route.providerModelId,
      providerId: "anthropic-hybrid",
    }),
    providerOptions: {},
    transport: "anthropic_direct_hybrid",
  };
}
