import "server-only";

import type { AiTransport } from "@/lib/ai/platform/types";

/**
 * Registered managed transports, and which one is the default.
 *
 * P12 moved the DEFAULT managed execution path off Vercel AI Gateway and onto a
 * direct Anthropic call made with ClinicFlow's own server-side managed key. The
 * gateway adapter is intentionally kept — it is a working, certified alternate
 * transport and the only quick lever available if Anthropic's direct API is
 * degraded — but it is no longer reachable by accident.
 *
 * "Not by accident" is the whole point of this module. There is exactly one way
 * to reach the gateway on a managed turn: an operator sets
 * `AI_MANAGED_TRANSPORT=vercel_ai_gateway` deliberately. There is no automatic,
 * error-triggered, or credential-triggered fallback from direct Anthropic to the
 * gateway anywhere in the codebase, because such a fallback would silently move
 * a clinic's traffic onto a different billing account and a different data
 * processor without anyone deciding to. Any value other than the two registered
 * names fails closed onto the default rather than guessing.
 */
export const MANAGED_TRANSPORTS = ["anthropic_direct", "vercel_ai_gateway"] as const;

export type ManagedTransport = (typeof MANAGED_TRANSPORTS)[number];

export const DEFAULT_MANAGED_TRANSPORT: ManagedTransport = "anthropic_direct";

export const MANAGED_TRANSPORT_ENV = "AI_MANAGED_TRANSPORT" as const;

function isManagedTransport(value: string): value is ManagedTransport {
  return (MANAGED_TRANSPORTS as readonly string[]).includes(value);
}

/**
 * Resolves the managed transport for this process. Unset, empty, or unrecognized
 * values resolve to the direct default; only the exact registered gateway name
 * selects the gateway.
 */
export function resolveManagedTransport(
  env: NodeJS.ProcessEnv = process.env,
): ManagedTransport {
  const configured = env[MANAGED_TRANSPORT_ENV]?.trim();
  if (!configured) return DEFAULT_MANAGED_TRANSPORT;
  return isManagedTransport(configured) ? configured : DEFAULT_MANAGED_TRANSPORT;
}

/** True when a managed turn in this process would call Anthropic directly. */
export function managedTransportIsDirect(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagedTransport(env) === "anthropic_direct";
}

/** The transport recorded on a reservation/ledger row for a given credential mode. */
export function transportForCredentialMode(
  mode: "managed" | "byok_strict" | "hybrid",
  env: NodeJS.ProcessEnv = process.env,
): AiTransport {
  if (mode === "managed") return resolveManagedTransport(env);
  if (mode === "byok_strict") return "anthropic_direct";
  return "anthropic_direct_hybrid";
}
