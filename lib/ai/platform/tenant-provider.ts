import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type {
  AiCredentialMode,
  AiProviderOptions,
  AiProviderRequest,
  PreparedAiProvider,
} from "@/lib/ai/platform/types";
import { resolveManagedProvider } from "@/lib/ai/platform/managed-provider";
import { withProviderResilience } from "@/lib/ai/platform/provider-resilience";
import { promptCacheProviderOptions } from "@/lib/ai/platform/prompt-cache";
import {
  classifyAiProviderFailure,
  type AiProviderFailureClass,
} from "@/lib/ai/platform/failure";

export { classifyAiProviderFailure };
export type { AiProviderFailureClass };

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
 * Tenant credentials call Anthropic directly with the clinic's own decrypted
 * key. Since P12 this is the same transport the managed path uses, so the two
 * modes differ in exactly one thing — whose credential pays — and in nothing a
 * prompt, tool, or gate above this layer can observe.
 *
 * Hybrid's fallback target is now the managed DIRECT adapter rather than the
 * gateway. It remains explicit, local, audited, and invoked only after the
 * clinic's own provider fails before a stream is established.
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
  // The clinic's own key gets the same platform concurrency ceiling and the same
  // single bounded retry as the managed key. The clinic pays for its own tokens,
  // but it still runs inside ClinicFlow's process and must not be able to pin a
  // server instance's request slots or hammer a rate-limited provider.
  const directModel = withProviderResilience(
    anthropic(input.request.route.providerModelId),
    {
      clinicId: input.request.clinicId,
      providerId: "anthropic",
      modelId: input.request.route.providerModelId,
    },
  );
  if (input.mode === "byok_strict") {
    return {
      model: directModel,
      // F-14 — the clinic's own key gets the same prompt caching the managed
      // key gets. It is the same provider and the same transport; withholding
      // it would make a BYOK clinic pay more for identical behaviour.
      providerOptions: promptCacheProviderOptions("anthropic_direct"),
      transport: "anthropic_direct",
    };
  }

  const managed = resolveManagedProvider().prepare(input.request);
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
    providerOptions: promptCacheProviderOptions("anthropic_direct_hybrid"),
    transport: "anthropic_direct_hybrid",
  };
}
