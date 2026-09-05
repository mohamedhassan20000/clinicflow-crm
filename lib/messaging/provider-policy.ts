import type {
  MessageChannel,
  MessagingProviderId,
  TemplateApprovalStatus,
} from "@/lib/messaging/types";

/**
 * Provider policy shared by every WhatsApp caller, including client UI.
 *
 * Cloud API transports inherit the strict policy by default. That means a
 * missing or unknown active provider can never accidentally loosen Meta's
 * service-window or template-approval rules.
 */
export type WhatsAppProviderCapabilities = Readonly<{
  serviceWindowRequired: boolean;
  approvedTemplateRequired: boolean;
  mediaSupported: boolean;
}>;

const CLOUD_API_CAPABILITIES: WhatsAppProviderCapabilities = {
  serviceWindowRequired: true,
  approvedTemplateRequired: true,
  mediaSupported: false,
};

const LINKED_DEVICE_CAPABILITIES: WhatsAppProviderCapabilities = {
  serviceWindowRequired: false,
  approvedTemplateRequired: false,
  mediaSupported: true,
};

export function getWhatsAppProviderCapabilities(
  provider: MessagingProviderId | null | undefined,
): WhatsAppProviderCapabilities {
  return provider === "linked_device"
    ? LINKED_DEVICE_CAPABILITIES
    : CLOUD_API_CAPABILITIES;
}

/**
 * A linked-device template is reusable clinic-authored text, not a provider
 * template. Explicitly rejected copy remains unusable under current product
 * rules; Meta/360dialog continue to require provider approval.
 */
export function isTemplateUsableForWhatsAppProvider(
  provider: MessagingProviderId | null | undefined,
  approvalStatus: TemplateApprovalStatus,
): boolean {
  const capabilities = getWhatsAppProviderCapabilities(provider);
  return capabilities.approvedTemplateRequired
    ? approvalStatus === "approved"
    : approvalStatus !== "rejected";
}

type ActiveChannelCandidate = {
  channel: MessageChannel;
  provider: MessagingProviderId;
};

/**
 * Resolve active rows exactly once for both sends and read models. The database
 * normally guarantees one active provider per channel; the Meta preference
 * preserves the send path's existing deterministic legacy-data fallback.
 */
export function resolveActiveChannels<T extends ActiveChannelCandidate>(
  rows: readonly T[],
): Map<MessageChannel, T> {
  const active = new Map<MessageChannel, T>();
  for (const row of rows) {
    const existing = active.get(row.channel);
    if (!existing || row.provider === "meta") active.set(row.channel, row);
  }
  return active;
}
