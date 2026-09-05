import "server-only";

/**
 * Vercel AI Gateway adapter — RETAINED, NON-DEFAULT.
 *
 * Since P12 the default managed transport is a direct Anthropic call
 * (`lib/ai/platform/managed-anthropic.ts`). This adapter stays in the codebase
 * as a registered alternate/emergency transport, reachable only through an
 * explicit `AI_MANAGED_TRANSPORT=vercel_ai_gateway` operator opt-in resolved in
 * `lib/ai/platform/transport.ts`. Nothing in the runtime selects it on error.
 */

import { createHmac } from "node:crypto";
import { gateway } from "ai";
import type {
  AiExecutionProvider,
  AiProviderRequest,
  PreparedAiProvider,
} from "@/lib/ai/platform/types";

function pseudonymousGatewayUser(clinicId: string, actorId: string): string | undefined {
  const key = process.env.AI_TRACKING_HMAC_KEY?.trim();
  if (!key) return undefined;
  return createHmac("sha256", key)
    .update(`clinic:${clinicId}:actor:${actorId}`)
    .digest("hex")
    .slice(0, 32);
}

class ManagedGatewayProvider implements AiExecutionProvider {
  readonly mode = "managed" as const;

  prepare(request: AiProviderRequest): PreparedAiProvider {
    const user = pseudonymousGatewayUser(request.clinicId, request.actorId);
    // Certified routes require zero-data-retention ON THIS TRANSPORT. Production
    // ALWAYS enforces it. A local development environment — where the Gateway
    // account may not yet have ZDR provisioned — may explicitly opt out via
    // AI_GATEWAY_ZDR=false. That flag is ignored in production, so it can never
    // weaken deployed behavior.
    //
    // This flag is a gateway request option and nothing more. It is read from
    // `privacy.gatewayZeroDataRetention` (not from a transport-neutral name)
    // precisely so it cannot be mistaken for a guarantee that also covers the
    // direct Anthropic transport, where no such per-request control exists.
    const zeroDataRetention =
      request.route.privacy.gatewayZeroDataRetention &&
      !(process.env.NODE_ENV !== "production" && process.env.AI_GATEWAY_ZDR === "false");
    const gatewayOptions = {
      only: [...request.route.allowedServingProviders],
      zeroDataRetention,
      tags: [
        "product:clinicflow",
        `surface:${request.surface}`,
        `task:${request.task}`,
        `policy:${request.policyVersion}`,
      ],
      ...(user ? { user } : {}),
    };
    return {
      model: gateway(request.route.modelId),
      providerOptions: { gateway: gatewayOptions },
      transport: "vercel_ai_gateway",
    };
  }
}

export const managedGatewayProvider: AiExecutionProvider = new ManagedGatewayProvider();
