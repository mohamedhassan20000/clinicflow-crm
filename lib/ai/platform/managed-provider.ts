import "server-only";

import { managedAnthropicProvider } from "@/lib/ai/platform/managed-anthropic";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";
import { resolveManagedTransport } from "@/lib/ai/platform/transport";
import type { AiExecutionProvider } from "@/lib/ai/platform/types";

/**
 * The single place that decides which managed adapter runs.
 *
 * Both adapters are registered; only the configured transport is constructed.
 * There is intentionally no error path here — a direct-Anthropic failure does
 * NOT re-resolve to the gateway. Silently retrying a failed managed turn on a
 * different processor and a different billing account is not a fallback, it is
 * an unannounced change of vendor mid-request, so it does not exist.
 */
export function resolveManagedProvider(
  env: NodeJS.ProcessEnv = process.env,
): AiExecutionProvider {
  return resolveManagedTransport(env) === "vercel_ai_gateway"
    ? managedGatewayProvider
    : managedAnthropicProvider;
}
