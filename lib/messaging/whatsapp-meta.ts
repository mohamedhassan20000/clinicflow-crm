import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import type {
  ChannelCredentials,
  ProviderMessage,
  ProviderSendResult,
  TemplateApprovalStatus,
  WebhookEvent,
} from "@/lib/messaging/types";

/**
 * P6C — Meta WhatsApp Cloud API adapter (§5.2, §9.2).
 *
 * The direct Tech Provider channel that replaces the 360dialog BSP. Credentials
 * are a per-clinic system-user token (`accessToken`), `phoneNumberId`, and
 * `wabaId`, stored through the P3A encryption boundary. Webhook authenticity is
 * verified with the platform app secret via `X-Hub-Signature-256` (Meta signs all
 * traffic for our single app with one secret — not a per-clinic value).
 *
 * The Graph API onboarding helpers (token exchange, webhook subscription) and the
 * reconciliation poll live here too, mirroring how the 360dialog adapter co-locates
 * its webhook-configuration calls. No provider SDK object or raw HTTP body escapes
 * this module.
 */

const DEFAULT_GRAPH_BASE = "https://graph.facebook.com";
/**
 * P7C: raised from v21.0. Coexistence provisioning reads `is_on_biz_app`, posts
 * to `/smb_app_data`, and subscribes the `history` / `smb_app_state_sync` /
 * `smb_message_echoes` webhook fields — none of which exist before v23.0, where
 * they fail as unknown fields rather than degrading. Keep in step with
 * META_SDK_VERSION.
 */
const DEFAULT_GRAPH_VERSION = "v23.0";

function graphBase(): string {
  return (process.env.META_GRAPH_API_BASE_URL ?? DEFAULT_GRAPH_BASE).replace(/\/$/, "");
}

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? DEFAULT_GRAPH_VERSION;
}

function graphUrl(path: string): string {
  return `${graphBase()}/${graphVersion()}/${path.replace(/^\//, "")}`;
}

/**
 * The app secret Meta signs a webhook with. Platform-brokered channels
 * (Embedded Signup / Coexistence) carry none and fall back to the single
 * platform secret; a P7D manual channel stores the clinic's *own* app secret in
 * its envelope, because Meta signs that clinic's traffic with their app.
 */
function appSecret(credentials?: ChannelCredentials): string | null {
  return (credentials?.appSecret || process.env.META_APP_SECRET) ?? null;
}

/**
 * Which Meta app a subscription check must look for. Platform channels expect
 * our app; a P7D manual channel expects the clinic's own app, whose id lives in
 * the channel envelope. Never falls through to "any app" when an id is known —
 * that would report someone else's subscription as ours.
 */
function expectedAppId(credentials?: ChannelCredentials): string | null {
  return (credentials?.appId || process.env.META_APP_ID) ?? null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

/** Reads only the routing identifier from an untrusted payload; no write before auth. */
export function extractMetaPhoneNumberId(payload: unknown): string | null {
  const root = asObject(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entryValue of entries) {
    const changes = Array.isArray(asObject(entryValue)?.changes)
      ? (asObject(entryValue)?.changes as unknown[])
      : [];
    for (const changeValue of changes) {
      const value = asObject(asObject(changeValue)?.value);
      const metadata = asObject(value?.metadata);
      const phoneNumberId =
        text(metadata?.phone_number_id) ?? text(value?.phone_number_id);
      if (phoneNumberId) return phoneNumberId;
    }
  }
  return null;
}

/** Meta routes account/review/phone updates by WABA id (the `entry[].id`). */
export function extractMetaWabaId(payload: unknown): string | null {
  const root = asObject(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entryValue of entries) {
    const id = text(asObject(entryValue)?.id);
    if (id) return id;
  }
  return null;
}

/** Template approval callbacks may omit metadata; provider ids are globally unique. */
export function extractMetaTemplateId(payload: unknown): string | null {
  const root = asObject(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entryValue of entries) {
    const changes = Array.isArray(asObject(entryValue)?.changes)
      ? (asObject(entryValue)?.changes as unknown[])
      : [];
    for (const changeValue of changes) {
      const change = asObject(changeValue);
      const field = text(change?.field);
      if (field !== "message_template_status_update" && field !== "template_status_update") {
        continue;
      }
      const value = asObject(change?.value);
      const providerTemplateId = text(value?.message_template_id) ?? text(value?.id);
      if (providerTemplateId) return providerTemplateId;
    }
  }
  return null;
}

export const metaWhatsAppProvider: MessagingProvider = {
  id: "meta",
  channel: "whatsapp",

  async send(
    message: ProviderMessage,
    credentials: ChannelCredentials,
  ): Promise<ProviderSendResult> {
    const accessToken = credentials.accessToken;
    const phoneNumberId = credentials.phoneNumberId;
    if (!accessToken || !phoneNumberId) {
      return { ok: false, error: "WhatsApp channel credentials are unavailable." };
    }
    try {
      const response = await fetch(graphUrl(`${phoneNumberId}/messages`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
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
                            parameters: message.template.parameters.map((value) => ({
                              type: "text",
                              text: value,
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
        const reason =
          text(providerError?.message) ??
          `Meta send failed with HTTP ${response.status}.`;
        return { ok: false, error: sanitizeProviderError(reason) };
      }
      if (!messageId) {
        // 2xx without a message id: accepted but uncorrelatable — ambiguous, so
        // callers must not fall back to another channel (P3-M1).
        return {
          ok: false,
          error: "Meta accepted the request but returned no message id.",
          ambiguous: true,
        };
      }
      return { ok: true, providerMessageId: messageId, costMicro: null };
    } catch (error) {
      // Timeouts/network loss may have reached Meta and been accepted.
      return { ok: false, error: sanitizeProviderError(error), ambiguous: true };
    }
  },

  /**
   * Verifies Meta's `X-Hub-Signature-256` (§9.2): `sha256=<hex>` where the digest
   * is HMAC-SHA256(app_secret, raw_body). Any missing/malformed input, or a
   * length mismatch, is a plain `false` — never an exception, never a leak.
   */
  async verifySignature(
    request: Request,
    credentials: ChannelCredentials,
  ): Promise<boolean> {
    const secret = appSecret(credentials);
    const header = request.headers.get("x-hub-signature-256");
    if (!secret || !header?.startsWith("sha256=")) return false;
    const provided = header.slice("sha256=".length).trim();
    if (!/^[0-9a-f]+$/i.test(provided) || provided.length % 2 !== 0) return false;
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return false;
    }
    const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
    let providedBuffer: Buffer;
    try {
      providedBuffer = Buffer.from(provided, "hex");
    } catch {
      return false;
    }
    return (
      providedBuffer.length === expected.length &&
      timingSafeEqual(providedBuffer, expected)
    );
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
      const entry = asObject(entryValue);
      const wabaId = text(entry?.id);
      const changes = Array.isArray(entry?.changes) ? (entry?.changes as unknown[]) : [];
      for (const changeValue of changes) {
        const change = asObject(changeValue);
        const field = text(change?.field);
        const value = asObject(change?.value);

        // P7C Coexistence backfill/mirror fields. These carry the clinic's own
        // Business-app traffic (echoes of messages *they* sent, historical
        // threads, contact-book state) — not new inbound patient messages. They
        // are recognized and skipped here so a future payload shape can never be
        // mistaken for an inbound message or a delivery status.
        if (
          field === "history" ||
          field === "smb_app_state_sync" ||
          field === "smb_message_echoes"
        ) {
          continue;
        }

        const metadata = asObject(value?.metadata);
        const phoneNumberId =
          text(metadata?.phone_number_id) ?? text(value?.phone_number_id);

        // Inbound patient messages.
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

        // Outbound delivery status callbacks.
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
            error:
              status === "failed"
                ? text(asObject(errors[0])?.title) ?? "failed"
                : null,
            occurredAt: unixTimestamp(statusEvent?.timestamp),
          });
        }

        // Template approval status.
        if (field === "message_template_status_update" || field === "template_status_update") {
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

        // Account / phone / review state — feeds the connection-state machine.
        // Only known fields produce a state signal; anything else is ignored so
        // an unknown payload never invents a state (plan line 1316).
        if (field === "account_update") {
          const event = text(value?.event);
          const banState = asObject(value?.ban_info) ? "banned" : null;
          const restriction = Array.isArray(value?.restriction_info) &&
            value.restriction_info.length > 0
            ? "restricted"
            : null;
          events.push({
            kind: "channel_state",
            phoneNumberId,
            wabaId,
            observedAt: unixTimestamp(value?.timestamp ?? value?.event_time),
            signals: {
              businessVerificationStatus: text(value?.business_verification_status),
              phoneStatus: text(asObject(value?.phone_number)?.status),
              failureReason: banState ?? restriction ?? event,
            },
          });
        } else if (field === "account_review_update") {
          events.push({
            kind: "channel_state",
            phoneNumberId,
            wabaId,
            observedAt: unixTimestamp(value?.timestamp ?? value?.event_time),
            signals: { accountReviewStatus: text(value?.decision) },
          });
        } else if (field === "phone_number_quality_update") {
          events.push({
            kind: "channel_state",
            phoneNumberId,
            wabaId,
            observedAt: unixTimestamp(value?.timestamp ?? value?.event_time),
            signals: {
              // `current_limit` is a messaging tier, not a quality rating.
              // Only an explicit quality field may populate quality_rating.
              qualityRating:
                text(value?.quality_rating) ?? text(value?.current_quality_rating),
              messagingLimitTier: text(value?.current_limit),
              phoneStatus: text(value?.event) === "ONBOARDING" ? "PENDING" : null,
            },
          });
        } else if (field === "phone_number_name_update") {
          events.push({
            kind: "channel_state",
            phoneNumberId,
            wabaId,
            observedAt: unixTimestamp(value?.timestamp ?? value?.event_time),
            // Display-name approval is not phone registration/connectivity.
            signals: {
              failureReason:
                text(value?.decision)?.toUpperCase() === "REJECTED"
                  ? "display_name_rejected"
                  : null,
            },
          });
        }
      }
    }
    return events.length > 0 ? events : [{ kind: "ignored", reason: "unknown_event" }];
  },
};

/**
 * Exchanges the Embedded Signup authorization code for Meta's short-lived OAuth
 * user token. This token is used only to prove which WABA the signup shared; it is
 * never mislabeled or persisted as the platform system-user token.
 */
export async function exchangeMetaSignupCode(
  code: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: "Meta app credentials are not configured." };
  }
  try {
    const url = new URL(graphUrl("oauth/access_token"));
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("code", code);
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    const accessToken = text(asObject(payload)?.access_token);
    if (!response.ok || !accessToken) {
      return {
        ok: false,
        error: sanitizeProviderError(
          text(asObject(asObject(payload)?.error)?.message) ??
            `Meta token exchange failed with HTTP ${response.status}.`,
        ),
      };
    }
    return { ok: true, accessToken };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

/**
 * P7C: the extra webhook fields a Coexistence WABA must subscribe to. A number
 * that stays live in the WhatsApp Business app delivers its own traffic through
 * these three fields rather than the plain `messages` field, so a Coexistence
 * subscription that omits them silently loses the clinic's real conversations.
 */
export const META_COEXISTENCE_WEBHOOK_FIELDS = [
  "messages",
  "message_template_status_update",
  "account_update",
  "account_review_update",
  "phone_number_quality_update",
  "phone_number_name_update",
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
] as const;

/**
 * Subscribes our app to the clinic's WABA so their inbound + status traffic
 * reaches our single webhook (plan line 1309, step 4). Idempotent at Meta.
 *
 * `fields` is omitted for the standard Embedded Signup flow — Meta then applies
 * the app's configured default field set, which is the P6C behaviour. The
 * Coexistence flow passes the explicit superset above.
 */
export async function subscribeMetaWabaWebhook(
  credentials: ChannelCredentials,
  options?: { fields?: readonly string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accessToken = credentials.accessToken;
  const wabaId = credentials.wabaId;
  if (!accessToken || !wabaId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  try {
    const url = new URL(graphUrl(`${wabaId}/subscribed_apps`));
    if (options?.fields?.length) {
      url.searchParams.set("subscribed_fields", options.fields.join(","));
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Meta webhook subscription failed with HTTP ${response.status}.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

/** The provider-side webhook subscription state, for the P6D self-check drift compare. */
export async function getMetaWabaSubscription(
  credentials: ChannelCredentials,
): Promise<{ ok: true; subscribed: boolean } | { ok: false; error: string }> {
  const accessToken = credentials.accessToken;
  const wabaId = credentials.wabaId;
  if (!accessToken || !wabaId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  try {
    const response = await fetch(graphUrl(`${wabaId}/subscribed_apps`), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: `Meta subscription lookup failed with HTTP ${response.status}.` };
    }
    const data = Array.isArray(asObject(payload)?.data)
      ? (asObject(payload)!.data as unknown[])
      : [];
    const appId = expectedAppId(credentials);
    return {
      ok: true,
      subscribed: data.some((item) => {
        const app = asObject(asObject(item)?.whatsapp_business_api_data);
        return appId ? text(app?.id) === appId : Boolean(app);
      }),
    };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

type MetaProvisionedChannel = {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
};

/**
 * How a Meta channel was onboarded.
 *
 * `embedded_signup` — P6C, platform-brokered Cloud API (we register the number
 *   with a PIN and store the platform system-user token).
 * `coexistence`     — P7C, the clinic's WhatsApp Business app number mirrored
 *   into Cloud API; it stays live in the app, so registration is skipped.
 * `manual_api`      — P7D, the clinic's *own* Meta app / WABA / permanent token
 *   entered by hand; nothing platform-owned is stored on the channel at all.
 */
export type MetaOnboardingFlow = "embedded_signup" | "coexistence" | "manual_api";

/** What a clinic hands us for a P7D manual Cloud API connection. */
export type ManualMetaCredentialsInput = {
  /** The clinic's own Meta app id. */
  appId: string;
  /** The clinic's own Meta app secret — used to verify *their* webhooks. */
  appSecret: string;
  /** A permanent system-user access token issued by the clinic's own app. */
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
};

export type ManualMetaVerification = {
  displayPhoneNumber: string;
  /** Meta's `code_verification_status` for the number, when reported. */
  phoneStatus: string | null;
  webhookSubscribed: boolean;
};

/**
 * P7D — verifies a clinic-supplied Cloud API credential set against Meta before
 * anything is stored, and subscribes the clinic's own app to their own WABA so
 * their traffic reaches our webhook.
 *
 * Every value the clinic typed is treated as a claim:
 *   1. `debug_token` under the clinic's own app credentials proves, in one call,
 *      that the app id + app secret pair is real *and* that the access token was
 *      issued by that very app — so a token pasted from a different (or our)
 *      app cannot be stored against their app secret.
 *   2. The phone node read proves the token can actually act on that number and
 *      yields the display number we show back.
 *   3. The WABA phone list proves the number really belongs to the claimed WABA
 *      rather than to some other account the token can also see.
 *   4. The subscription is created and then read back, so "connected" is only
 *      ever claimed on a subscription Meta confirms.
 *
 * No credential is logged, and every provider failure is returned sanitized.
 */
export async function verifyManualMetaCredentials(
  input: ManualMetaCredentialsInput,
): Promise<
  | { ok: true; verification: ManualMetaVerification }
  | { ok: false; error: string }
> {
  const credentials: ChannelCredentials = {
    accessToken: input.accessToken,
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    appId: input.appId,
  };

  // 1. App credentials + token provenance, in one call. The app access token
  //    (`<app-id>|<app-secret>`) is the documented inspector credential; it is
  //    built here and never persisted.
  const debugParams = new URLSearchParams({ input_token: input.accessToken });
  const debug = await graphJson(`debug_token?${debugParams.toString()}`, {
    method: "GET",
    accessToken: `${input.appId}|${input.appSecret}`,
  });
  if (!debug.ok) {
    return { ok: false, error: "Meta rejected the supplied app credentials." };
  }
  const debugData = asObject(debug.payload.data);
  if (debugData?.is_valid !== true || text(debugData?.app_id) !== input.appId) {
    return {
      ok: false,
      error: "The access token does not belong to the supplied Meta app.",
    };
  }

  // 2. The number itself, read with the clinic's own token.
  const phone = await graphJson(
    `${input.phoneNumberId}?fields=id,display_phone_number,code_verification_status,platform_type`,
    { method: "GET", accessToken: input.accessToken },
  );
  if (!phone.ok) return phone;
  const displayPhoneNumber = text(phone.payload.display_phone_number);
  if (text(phone.payload.id) !== input.phoneNumberId || !displayPhoneNumber) {
    return { ok: false, error: "The supplied phone number id could not be read." };
  }

  // 3. Ownership: the number must be listed under the claimed WABA.
  const phones = await graphJson(`${input.wabaId}/phone_numbers?fields=id`, {
    method: "GET",
    accessToken: input.accessToken,
  });
  if (!phones.ok) return phones;
  if (!payloadIds(phones.payload).includes(input.phoneNumberId)) {
    return {
      ok: false,
      error: "The phone number does not belong to the supplied WhatsApp Business account.",
    };
  }

  // 4. Subscribe the clinic's own app to their WABA, then read it back.
  const subscribed = await subscribeMetaWabaWebhook(credentials);
  if (!subscribed.ok) return subscribed;
  const subscription = await getMetaWabaSubscription(credentials);
  if (!subscription.ok) return subscription;
  if (!subscription.subscribed) {
    return { ok: false, error: "Meta webhook subscription could not be verified." };
  }

  return {
    ok: true,
    verification: {
      displayPhoneNumber,
      phoneStatus: text(phone.payload.code_verification_status),
      webhookSubscribed: true,
    },
  };
}

/**
 * `requirePin` is false for the Coexistence flow: that number is already
 * registered with WhatsApp, so we never call `/register` and a missing
 * META_PHONE_REGISTRATION_PIN must not block the connection.
 */
function metaProvisioningConfig(requirePin = true):
  | {
      appId: string;
      businessId: string;
      systemUserId: string;
      systemUserAccessToken: string;
      registrationPin: string | null;
    }
  | null {
  const appId = process.env.META_APP_ID;
  const businessId = process.env.META_BUSINESS_ID;
  const systemUserId = process.env.META_SYSTEM_USER_ID;
  const systemUserAccessToken = process.env.META_SYSTEM_USER_ACCESS_TOKEN;
  const rawPin = process.env.META_PHONE_REGISTRATION_PIN;
  const registrationPin = rawPin && /^\d{6}$/.test(rawPin) ? rawPin : null;
  if (
    !appId ||
    !businessId ||
    !systemUserId ||
    !systemUserAccessToken ||
    (requirePin && !registrationPin)
  ) {
    return null;
  }
  return {
    appId,
    businessId,
    systemUserId,
    systemUserAccessToken,
    registrationPin,
  };
}

async function graphJson(
  path: string,
  init: RequestInit & { accessToken: string },
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const { accessToken, ...requestInit } = init;
  try {
    const response = await fetch(graphUrl(path), {
      ...requestInit,
      headers: {
        ...requestInit.headers,
        authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload = asObject(await response.json().catch(() => null)) ?? {};
    if (!response.ok) {
      return {
        ok: false,
        error: sanitizeProviderError(
          text(asObject(payload.error)?.message) ??
            `Meta provisioning failed with HTTP ${response.status}.`,
        ),
      };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

function payloadIds(payload: Record<string, unknown>): string[] {
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data
    .map((item) => text(asObject(item)?.id))
    .filter((value): value is string => value !== null);
}

/**
 * Completes the required server-side Embedded Signup lifecycle before any
 * channel credential is stored:
 * OAuth token debug/asset binding → shared-WABA lookup → system-user assignment
 * and verification → phone ownership lookup/registration → app subscription and
 * verification. The client-provided ids are treated only as claims to verify.
 */
export async function provisionMetaEmbeddedSignup(input: {
  oauthAccessToken: string;
  phoneNumberId: string;
  wabaId: string;
  /** Defaults to the P6C Cloud-API-only flow. */
  flow?: MetaOnboardingFlow;
}): Promise<
  | { ok: true; channel: MetaProvisionedChannel }
  | { ok: false; error: string }
> {
  const flow: MetaOnboardingFlow = input.flow ?? "embedded_signup";
  const config = metaProvisioningConfig(flow === "embedded_signup");
  if (!config) {
    return { ok: false, error: "Meta provisioning credentials are not configured." };
  }

  const debugParams = new URLSearchParams({
    input_token: input.oauthAccessToken,
  });
  const debug = await graphJson(
    `debug_token?${debugParams.toString()}`,
    {
      method: "GET",
      accessToken: config.systemUserAccessToken,
    },
  );
  if (!debug.ok) return debug;
  const debugData = asObject(debug.payload.data);
  const scopes = Array.isArray(debugData?.scopes) ? debugData.scopes : [];
  const granularScopes = Array.isArray(debugData?.granular_scopes)
    ? debugData.granular_scopes
    : [];
  const targetWabas = granularScopes.flatMap((rawScope) => {
    const scope = asObject(rawScope);
    if (text(scope?.scope) !== "whatsapp_business_management") return [];
    return Array.isArray(scope?.target_ids)
      ? scope.target_ids.filter((id): id is string => typeof id === "string")
      : [];
  });
  if (
    debugData?.is_valid !== true ||
    text(debugData?.app_id) !== config.appId ||
    !scopes.includes("whatsapp_business_management") ||
    !targetWabas.includes(input.wabaId)
  ) {
    return { ok: false, error: "Meta signup token is not valid for the selected WABA." };
  }

  const shared = await graphJson(
    `${config.businessId}/client_whatsapp_business_accounts`,
    { method: "GET", accessToken: config.systemUserAccessToken },
  );
  if (!shared.ok) return shared;
  if (!payloadIds(shared.payload).includes(input.wabaId)) {
    return { ok: false, error: "The selected WABA is not shared with this platform." };
  }

  const assignedParams = new URLSearchParams({
    user: config.systemUserId,
    tasks: JSON.stringify(["MANAGE", "DEVELOP"]),
  });
  const assigned = await graphJson(
    `${input.wabaId}/assigned_users?${assignedParams.toString()}`,
    { method: "POST", accessToken: config.systemUserAccessToken },
  );
  if (!assigned.ok) return assigned;
  const assignedUsers = await graphJson(
    `${input.wabaId}/assigned_users?fields=id`,
    { method: "GET", accessToken: config.systemUserAccessToken },
  );
  if (!assignedUsers.ok) return assignedUsers;
  if (!payloadIds(assignedUsers.payload).includes(config.systemUserId)) {
    return { ok: false, error: "Meta system-user assignment could not be verified." };
  }

  const phones = await graphJson(
    `${input.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,is_on_biz_app`,
    { method: "GET", accessToken: config.systemUserAccessToken },
  );
  if (!phones.ok) return phones;
  const phoneRows = Array.isArray(phones.payload.data) ? phones.payload.data : [];
  const phone = phoneRows
    .map(asObject)
    .find((row) => text(row?.id) === input.phoneNumberId);
  const displayPhoneNumber = text(phone?.display_phone_number);
  if (!phone || !displayPhoneNumber) {
    return { ok: false, error: "The selected phone number does not belong to the selected WABA." };
  }

  if (flow === "embedded_signup") {
    // Coexistence numbers are already registered with WhatsApp through the
    // Business app; calling /register on one would fail or unlink it.
    if (!config.registrationPin) {
      return { ok: false, error: "Meta provisioning credentials are not configured." };
    }
    const registered = await graphJson(`${input.phoneNumberId}/register`, {
      method: "POST",
      accessToken: config.systemUserAccessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: config.registrationPin,
      }),
    });
    if (!registered.ok) return registered;
  } else if (phone.is_on_biz_app === false) {
    // The popup claimed a Coexistence onboarding but Meta does not report the
    // number as living on the Business app — refuse rather than mislabel it.
    return {
      ok: false,
      error: "The selected phone number is not connected to the WhatsApp Business app.",
    };
  }

  const subscribed = await subscribeMetaWabaWebhook(
    {
      accessToken: config.systemUserAccessToken,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
    },
    flow === "coexistence" ? { fields: META_COEXISTENCE_WEBHOOK_FIELDS } : undefined,
  );
  if (!subscribed.ok) return subscribed;
  const subscription = await getMetaWabaSubscription({
    accessToken: config.systemUserAccessToken,
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
  });
  if (!subscription.ok) return subscription;
  if (!subscription.subscribed) {
    return { ok: false, error: "Meta webhook subscription could not be verified." };
  }

  return {
    ok: true,
    channel: {
      accessToken: config.systemUserAccessToken,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayPhoneNumber,
    },
  };
}

/**
 * P7C post-onboarding synchronization for a Coexistence number. Meta allows a
 * 24-hour window after onboarding to pull the clinic's Business-app contacts and
 * message history; missing it means the clinic must offboard and reconnect.
 *
 * Both requests are best-effort and reported independently: the channel is
 * usable for new conversations even when the historical backfill is refused, so
 * a failure here must never fail the connection. Meta answers asynchronously
 * over the `smb_app_state_sync` / `history` webhook fields.
 */
export async function requestMetaSmbDataSync(
  credentials: ChannelCredentials,
): Promise<{ contacts: boolean; history: boolean }> {
  const accessToken = credentials.accessToken;
  const phoneNumberId = credentials.phoneNumberId;
  if (!accessToken || !phoneNumberId) return { contacts: false, history: false };

  const request = async (syncType: "smb_app_state_sync" | "history") => {
    const result = await graphJson(`${phoneNumberId}/smb_app_data`, {
      method: "POST",
      accessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
    });
    return result.ok;
  };

  const [contacts, history] = await Promise.all([
    request("smb_app_state_sync"),
    request("history"),
  ]);
  return { contacts, history };
}

export async function submitMetaTemplate(
  input: {
    name: string;
    language: string;
    body: string;
    category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  },
  credentials: ChannelCredentials,
): Promise<
  | { ok: true; providerTemplateId: string; status: TemplateApprovalStatus }
  | { ok: false; error: string }
> {
  if (!credentials.accessToken || !credentials.wabaId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  const result = await graphJson(`${credentials.wabaId}/message_templates`, {
    method: "POST",
    accessToken: credentials.accessToken,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      language: input.language,
      category: input.category,
      components: [{ type: "BODY", text: input.body }],
    }),
  });
  if (!result.ok) return result;
  const providerTemplateId = text(result.payload.id);
  if (!providerTemplateId) {
    return { ok: false, error: "Meta returned no template identifier." };
  }
  return {
    ok: true,
    providerTemplateId,
    status: normalizeTemplateStatus(result.payload.status) ?? "submitted",
  };
}

export type MetaTemplateSnapshot = {
  providerTemplateId: string;
  name: string;
  language: string;
  status: TemplateApprovalStatus;
};

export async function fetchMetaTemplates(
  credentials: ChannelCredentials,
): Promise<
  | { ok: true; templates: MetaTemplateSnapshot[] }
  | { ok: false; error: string }
> {
  if (!credentials.accessToken || !credentials.wabaId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  const result = await graphJson(
    `${credentials.wabaId}/message_templates?fields=id,name,language,status`,
    { method: "GET", accessToken: credentials.accessToken },
  );
  if (!result.ok) return result;
  const rows = Array.isArray(result.payload.data) ? result.payload.data : [];
  return {
    ok: true,
    templates: rows.flatMap((raw) => {
      const row = asObject(raw);
      const providerTemplateId = text(row?.id);
      const name = text(row?.name);
      const language = text(row?.language);
      const status = normalizeTemplateStatus(row?.status);
      return providerTemplateId && name && language && status
        ? [{ providerTemplateId, name, language, status }]
        : [];
    }),
  };
}

export type MetaChannelStateSnapshot = {
  businessVerificationStatus: string | null;
  phoneStatus: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  accountReviewStatus: string | null;
  webhookSubscribed: boolean;
  /**
   * P7C: whether Meta reports the number as live on the WhatsApp Business app.
   * `null` when Meta omitted the field — the state machine then falls back to
   * `code_verification_status` rather than assuming either way.
   */
  phoneOnBusinessApp: boolean | null;
};

/**
 * Reconciliation poll (plan line 1311): fetches the WABA + phone-number status
 * fields Meta exposes and returns them as a normalized snapshot. Read-only and
 * idempotent — the same Graph response always yields the same snapshot, which the
 * transition applier turns into at most one state change. Never returns raw error
 * bodies; a failure is a sanitized string.
 */
export async function fetchMetaChannelState(
  credentials: ChannelCredentials,
): Promise<
  | { ok: true; snapshot: MetaChannelStateSnapshot }
  | { ok: false; error: string }
> {
  const accessToken = credentials.accessToken;
  const phoneNumberId = credentials.phoneNumberId;
  const wabaId = credentials.wabaId;
  if (!accessToken || !phoneNumberId || !wabaId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  const authHeader = { authorization: `Bearer ${accessToken}` };
  try {
    const [wabaResponse, phoneResponse, subscriptionResponse] = await Promise.all([
      fetch(
        `${graphUrl(wabaId)}?fields=account_review_status`,
        { method: "GET", headers: authHeader, cache: "no-store", signal: AbortSignal.timeout(10_000) },
      ),
      fetch(
        `${graphUrl(phoneNumberId)}?fields=verified_name,display_phone_number,code_verification_status,quality_rating,platform_type,is_on_biz_app`,
        { method: "GET", headers: authHeader, cache: "no-store", signal: AbortSignal.timeout(10_000) },
      ),
      fetch(graphUrl(`${wabaId}/subscribed_apps`), {
        method: "GET",
        headers: authHeader,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    const wabaPayload = asObject(await wabaResponse.json().catch(() => null));
    const phonePayload = asObject(await phoneResponse.json().catch(() => null));
    const subscriptionPayload = asObject(
      await subscriptionResponse.json().catch(() => null),
    );
    if (!wabaResponse.ok || !phoneResponse.ok || !subscriptionResponse.ok) {
      const status = !wabaResponse.ok
        ? wabaResponse.status
        : !phoneResponse.ok
          ? phoneResponse.status
          : subscriptionResponse.status;
      return { ok: false, error: `Meta status reconciliation failed with HTTP ${status}.` };
    }
    const subscriptions = Array.isArray(subscriptionPayload?.data)
      ? subscriptionPayload.data
      : [];
    const appId = expectedAppId(credentials);
    const webhookSubscribed = subscriptions.some((item) => {
      const data = asObject(asObject(item)?.whatsapp_business_api_data);
      return appId ? text(data?.id) === appId : Boolean(data);
    });
    return {
      ok: true,
      snapshot: {
        businessVerificationStatus: null,
        accountReviewStatus: text(wabaPayload?.account_review_status),
        phoneStatus: text(phonePayload?.code_verification_status),
        qualityRating: text(phonePayload?.quality_rating),
        // Meta does not document a messaging-limit field on the phone node.
        // A real webhook signal may populate this later; the poll never guesses it.
        messagingLimitTier: null,
        webhookSubscribed,
        phoneOnBusinessApp:
          typeof phonePayload?.is_on_biz_app === "boolean"
            ? phonePayload.is_on_biz_app
            : null,
      },
    };
  } catch (error) {
    return { ok: false, error: sanitizeProviderError(error) };
  }
}

/** Credentialed, side-effect-free provider reachability check for P6D. */
export async function testMetaConnectivity(
  credentials: ChannelCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!credentials.accessToken || !credentials.phoneNumberId) {
    return { ok: false, error: "WhatsApp channel credentials are unavailable." };
  }
  const result = await graphJson(
    `${credentials.phoneNumberId}?fields=id`,
    { method: "GET", accessToken: credentials.accessToken },
  );
  return result.ok ? { ok: true } : result;
}
