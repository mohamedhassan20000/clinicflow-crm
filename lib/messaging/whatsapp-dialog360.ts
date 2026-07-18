import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import type {
  ChannelCredentials,
  ProviderMessage,
  ProviderSendResult,
  ProviderTemplateInput,
  ProviderTemplateResult,
  TemplateApprovalStatus,
  WebhookEvent,
} from "@/lib/messaging/types";

const DEFAULT_API_BASE = "https://waba-v2.360dialog.io";

export type Dialog360WebhookConfiguration = {
  url?: string;
  headers?: Record<string, string>;
};

function apiBase(): string {
  return (process.env.DIALOG360_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function safeEqual(candidateValue: string, expectedValue: string): boolean {
  const candidate = Buffer.from(candidateValue, "utf8");
  const expected = Buffer.from(expectedValue, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function webhookConfiguration(value: unknown): Dialog360WebhookConfiguration | null {
  const data = asObject(value);
  if (!data) return null;
  const url = text(data.url);
  const rawHeaders = asObject(data.headers);
  const headers = rawHeaders
    ? Object.fromEntries(
        Object.entries(rawHeaders).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  return {
    ...(url ? { url } : {}),
    ...(headers ? { headers } : {}),
  };
}

function unixTimestamp(value: unknown): string | null {
  const raw = text(value) ?? (typeof value === "number" ? String(value) : null);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const date = new Date(Number(raw) * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function normalizeTemplateStatus(value: unknown): TemplateApprovalStatus | null {
  switch (text(value)?.toUpperCase()) {
    case "APPROVED":
    case "ACTIVE":
      return "approved";
    case "REJECTED":
    case "DISABLED":
    case "PAUSED":
      return "rejected";
    case "PENDING":
    case "IN_REVIEW":
    case "SUBMITTED":
      return "submitted";
    default:
      return null;
  }
}

function inboundBody(message: Record<string, unknown>): string {
  const type = text(message.type) ?? "unknown";
  const content = asObject(message[type]);
  if (type === "text") return text(content?.body) ?? "";
  if (type === "button") return text(content?.text) ?? "[Button reply]";
  if (type === "interactive") {
    const button = asObject(content?.button_reply);
    const list = asObject(content?.list_reply);
    return text(button?.title) ?? text(list?.title) ?? `[${type} message]`;
  }
  return `[${type} message]`;
}

/** Reads only the routing identifier from an untrusted payload. No write occurs before auth. */
export function extractDialog360PhoneNumberId(payload: unknown): string | null {
  const root = asObject(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entryValue of entries) {
    const entry = asObject(entryValue);
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const changeValue of changes) {
      const value = asObject(asObject(changeValue)?.value);
      const metadata = asObject(value?.metadata);
      const phoneNumberId = text(metadata?.phone_number_id);
      if (phoneNumberId) return phoneNumberId;
    }
  }
  return null;
}

/** Template approval callbacks can omit metadata; ids are globally unique in our schema. */
export function extractDialog360TemplateId(payload: unknown): string | null {
  const root = asObject(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entryValue of entries) {
    const changes = Array.isArray(asObject(entryValue)?.changes)
      ? (asObject(entryValue)?.changes as unknown[])
      : [];
    for (const changeValue of changes) {
      const change = asObject(changeValue);
      const field = text(change?.field);
      if (field !== "message_template_status_update" && field !== "template_message_update") {
        continue;
      }
      const value = asObject(change?.value);
      const providerTemplateId = text(value?.message_template_id) ?? text(value?.id);
      if (providerTemplateId) return providerTemplateId;
    }
  }
  return null;
}

/** Snapshot used by the connect-flow compensation boundary before mutation. */
export async function getDialog360WebhookConfiguration(
  apiKey: string,
): Promise<
  | { ok: true; configuration: Dialog360WebhookConfiguration }
  | { ok: false; error: string }
> {
  try {
    const response = await fetch(`${apiBase()}/v1/configs/webhook`, {
      method: "GET",
      headers: { "D360-API-KEY": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    const configuration = webhookConfiguration(payload);
    if (!response.ok || !configuration) {
      return {
        ok: false,
        error: `360dialog webhook lookup failed with HTTP ${response.status}.`,
      };
    }
    return { ok: true, configuration };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

/** Low-level setter used both for activation and compensating restoration. */
export async function setDialog360WebhookConfiguration(input: {
  apiKey: string;
  configuration: Dialog360WebhookConfiguration;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${apiBase()}/v1/configs/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "D360-API-KEY": input.apiKey,
      },
      body: JSON.stringify(input.configuration),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `360dialog webhook setup failed with HTTP ${response.status}.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

export async function configureDialog360Webhook(input: {
  apiKey: string;
  url: string;
  username: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return setDialog360WebhookConfiguration({
    apiKey: input.apiKey,
    configuration: {
      url: input.url,
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`,
      },
    },
  });
}

export async function submitDialog360Template(
  input: ProviderTemplateInput,
  credentials: ChannelCredentials,
): Promise<ProviderTemplateResult> {
  const apiKey = credentials.apiKey;
  if (!apiKey) return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  try {
    const response = await fetch(`${apiBase()}/v1/configs/templates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "D360-API-KEY": apiKey,
      },
      body: JSON.stringify({
        name: input.name,
        language: input.language,
        category: input.category,
        components: [{ type: "BODY", text: input.body }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    const data = asObject(payload);
    const id = text(data?.id) ?? text(asObject(data?.data)?.id);
    if (!response.ok || !id) {
      const message = text(data?.message) ?? `360dialog template submission failed with HTTP ${response.status}.`;
      return { ok: false, error: sanitizeProviderError(message) };
    }
    return {
      ok: true,
      providerTemplateId: id,
      status: normalizeTemplateStatus(data?.status) ?? "submitted",
    };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

/**
 * Deletes a provider-registered template so a local delete cannot strand an
 * orphaned template at 360dialog. A 404 counts as success (already gone).
 */
export async function deleteDialog360Template(
  name: string,
  credentials: ChannelCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = credentials.apiKey;
  if (!apiKey) return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  try {
    const response = await fetch(
      `${apiBase()}/v1/configs/templates/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { "D360-API-KEY": apiKey },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      return {
        ok: false,
        error: `360dialog template deletion failed with HTTP ${response.status}.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

export const dialog360WhatsAppProvider: MessagingProvider = {
  id: "dialog360",
  channel: "whatsapp",

  async send(
    message: ProviderMessage,
    credentials: ChannelCredentials,
  ): Promise<ProviderSendResult> {
    const apiKey = credentials.apiKey;
    if (!apiKey) return { ok: false, error: "WhatsApp channel credentials are unavailable." };
    try {
      const response = await fetch(`${apiBase()}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "D360-API-KEY": apiKey,
        },
        body: JSON.stringify(
          message.template
            ? {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: message.recipient,
                ...(message.clientReference
                  ? { biz_opaque_callback_data: message.clientReference }
                  : {}),
                type: "template",
                template: {
                  name: message.template.name,
                  language: { code: message.template.language },
                  ...(message.template.parameters.length > 0
                    ? {
                        components: [
                          {
                            type: "body",
                            parameters: message.template.parameters.map((text) => ({
                              type: "text",
                              text,
                            })),
                          },
                        ],
                      }
                    : {}),
                },
              }
            : {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: message.recipient,
                ...(message.clientReference
                  ? { biz_opaque_callback_data: message.clientReference }
                  : {}),
                type: "text",
                text: { body: message.body },
              },
        ),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const payload: unknown = await response.json().catch(() => null);
      const data = asObject(payload);
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const messageId = text(asObject(messages[0])?.id);
      if (!response.ok) {
        const providerError = asObject(data?.error);
        const reason = text(providerError?.message) ?? `360dialog send failed with HTTP ${response.status}.`;
        return { ok: false, error: sanitizeProviderError(reason) };
      }
      if (!messageId) {
        // 2xx without a message id: the provider accepted something we could
        // not correlate — treat as ambiguous, never as a definite rejection.
        return {
          ok: false,
          error: "360dialog accepted the request but returned no message id.",
          ambiguous: true,
        };
      }
      return { ok: true, providerMessageId: messageId, costMicro: null };
    } catch (error) {
      // Thrown fetch errors are timeouts/network loss: the request may have
      // reached 360dialog and been accepted, so the outcome is ambiguous.
      return { ok: false, error: sanitizeProviderError(error), ambiguous: true };
    }
  },

  async verifySignature(
    request: Request,
    credentials: ChannelCredentials,
  ): Promise<boolean> {
    const username = credentials.webhookUsername;
    const password = credentials.webhookSecret;
    const authorization = request.headers.get("authorization");
    if (!username || !password || !authorization?.startsWith("Basic ")) return false;
    let decoded: string;
    try {
      const encoded = authorization.slice("Basic ".length).trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
        return false;
      }
      decoded = bytes.toString("utf8");
    } catch {
      return false;
    }
    return safeEqual(decoded, `${username}:${password}`);
  },

  async parseWebhook(request: Request): Promise<WebhookEvent[]> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return [{ kind: "ignored", reason: "invalid_json" }];
    }
    const root = asObject(payload);
    if (!root) return [{ kind: "ignored", reason: "invalid_payload" }];
    const events: WebhookEvent[] = [];
    const entries = Array.isArray(root.entry) ? root.entry : [];
    for (const entryValue of entries) {
      const changes = Array.isArray(asObject(entryValue)?.changes)
        ? (asObject(entryValue)?.changes as unknown[])
        : [];
      for (const changeValue of changes) {
        const change = asObject(changeValue);
        const value = asObject(change?.value);
        const metadata = asObject(value?.metadata);
        const phoneNumberId = text(metadata?.phone_number_id);

        const messages = Array.isArray(value?.messages) ? value.messages : [];
        for (const rawMessage of messages) {
          const message = asObject(rawMessage);
          const sender = text(message?.from);
          const id = text(message?.id);
          if (!message || !phoneNumberId || !sender || !id) continue;
          events.push({
            kind: "inbound",
            phoneNumberId,
            sender,
            providerMessageId: id,
            body: inboundBody(message),
            receivedAt: unixTimestamp(message.timestamp),
          });
        }

        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
        for (const rawStatus of statuses) {
          const statusEvent = asObject(rawStatus);
          const id = text(statusEvent?.id);
          const statusValue = text(statusEvent?.status)?.toLowerCase();
          const status =
            statusValue === "sent" || statusValue === "delivered" || statusValue === "read"
              ? statusValue
              : statusValue === "failed"
                ? "failed"
                : null;
          if (!id || !status) continue;
          const errors = Array.isArray(statusEvent?.errors) ? statusEvent.errors : [];
          events.push({
            kind: "status",
            providerMessageId: id,
            clientReference: text(statusEvent?.biz_opaque_callback_data),
            status,
            error: status === "failed" ? text(asObject(errors[0])?.title) ?? "failed" : null,
            occurredAt: unixTimestamp(statusEvent?.timestamp),
          });
        }

        if (text(change?.field) === "message_template_status_update" || text(change?.field) === "template_message_update") {
          const providerTemplateId = text(value?.message_template_id) ?? text(value?.id);
          const status = normalizeTemplateStatus(value?.event ?? value?.status);
          if (providerTemplateId && status) {
            events.push({
              kind: "template_status",
              providerTemplateId,
              name: text(value?.message_template_name) ?? text(value?.name),
              language: text(value?.message_template_language) ?? text(value?.language),
              status,
            });
          }
        }
      }
    }
    return events.length > 0 ? events : [{ kind: "ignored", reason: "unknown_event" }];
  },
};
