import "server-only";

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
    const gatewayOptions = {
      only: [...request.route.allowedServingProviders],
      zeroDataRetention: request.route.privacy.zeroDataRetentionRequired,
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
