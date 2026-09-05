import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { withProviderResilience } from "@/lib/ai/platform/provider-resilience";
import { promptCacheProviderOptions } from "@/lib/ai/platform/prompt-cache";
import type {
  AiExecutionProvider,
  AiProviderRequest,
  PreparedAiProvider,
} from "@/lib/ai/platform/types";

/**
 * ClinicFlow-managed AI, calling Anthropic directly.
 *
 * This is the DEFAULT managed transport. The clinic's turn goes
 * clinic → ClinicFlow control plane → ClinicFlow's managed Anthropic key →
 * Anthropic → Claude, with no third-party inference gateway in the path.
 *
 * The credential is a single platform secret. It is read from the environment
 * on every prepare (never cached across a config change), is never written to a
 * clinic-scoped table, never leaves the server, and is never included in any
 * ledger, audit row, or error message. It is deliberately NOT the ambient
 * `ANTHROPIC_API_KEY` that `@ai-sdk/anthropic` would otherwise pick up on its
 * own: the managed key is named explicitly so that a stray ambient key in some
 * environment can never silently become the platform's billing account.
 */

export const MANAGED_ANTHROPIC_KEY_ENV = "ANTHROPIC_MANAGED_API_KEY" as const;

export class AiManagedCredentialError extends Error {
  constructor() {
    super(
      `Managed AI is not configured: ${MANAGED_ANTHROPIC_KEY_ENV} is missing. ` +
        "ClinicFlow-managed turns fail closed rather than falling back to another transport.",
    );
    this.name = "AiManagedCredentialError";
  }
}

/** Resolves the platform-managed Anthropic secret, failing closed when absent. */
export function resolveManagedAnthropicKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = env[MANAGED_ANTHROPIC_KEY_ENV]?.trim();
  if (!key) throw new AiManagedCredentialError();
  return key;
}

/** True when the platform-managed Anthropic credential is present. */
export function hasManagedAnthropicKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[MANAGED_ANTHROPIC_KEY_ENV]?.trim());
}

class ManagedAnthropicProvider implements AiExecutionProvider {
  readonly mode = "managed" as const;

  prepare(request: AiProviderRequest): PreparedAiProvider {
    const anthropic = createAnthropic({ apiKey: resolveManagedAnthropicKey() });
    // The NATIVE Anthropic model id, not the gateway-qualified one. Sending
    // "anthropic/claude-haiku-4.5" to api.anthropic.com is a 404, so the two ids
    // stay separate fields on the certified route rather than one string that
    // happens to work on whichever transport was configured last.
    const model = anthropic(request.route.providerModelId);
    return {
      model: withProviderResilience(model, {
        clinicId: request.clinicId,
        providerId: "anthropic",
        modelId: request.route.providerModelId,
      }),
      // No gateway options: `zeroDataRetention`, serving-provider pinning, and
      // gateway tags are transport features of the gateway and are inert here.
      // See `AiRoutePrivacy` for why this is not silently treated as equivalent.
      //
      // F-14 — what this transport *does* support is prompt caching, and the
      // decision belongs here rather than in any agent: it is a property of who
      // is being called. The value is a caching directive over content that is
      // sent either way, so no prompt, tool, gate or sampling parameter
      // changes. See `lib/ai/platform/prompt-cache.ts`.
      providerOptions: promptCacheProviderOptions("anthropic_direct"),
      transport: "anthropic_direct",
    };
  }
}

export const managedAnthropicProvider: AiExecutionProvider = new ManagedAnthropicProvider();
