import "server-only";
import type {
  ChannelCredentials,
  MessageChannel,
  MessagingProviderId,
  ProviderMessage,
  ProviderSendResult,
  WebhookEvent,
} from "@/lib/messaging/types";

/**
 * Channel-neutral boundary for messaging providers (§5.2). Domain callers
 * depend on this contract; provider SDK objects and raw HTTP responses must
 * never escape an adapter. Mirrors lib/billing/provider.ts.
 *
 * Webhook routes land in P3B; verifySignature/parseWebhook are part of the
 * contract now so every adapter ships fixture-tested with both directions.
 */
export interface MessagingProvider {
  readonly id: MessagingProviderId;
  readonly channel: MessageChannel;
  send(
    message: ProviderMessage,
    credentials: ChannelCredentials,
  ): Promise<ProviderSendResult>;
  /**
   * Verifies the provider's webhook signature against the raw request body.
   * Callers pass a clone of the request; an unverifiable request is false,
   * never an exception.
   */
  verifySignature(
    request: Request,
    credentials: ChannelCredentials,
  ): Promise<boolean>;
  /** Parses a verified webhook body into normalized events. */
  parseWebhook(request: Request): Promise<WebhookEvent[]>;
}

export class UnsupportedMessagingProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Messaging provider "${provider}" is not available yet.`);
    this.name = "UnsupportedMessagingProviderError";
  }
}
