import "server-only";
import * as Sentry from "@sentry/nextjs";
import { randomBytes } from "node:crypto";
import { encryptChannelCredentials, decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  configureDialog360Webhook,
  getDialog360WebhookConfiguration,
  setDialog360WebhookConfiguration,
} from "@/lib/messaging/whatsapp-dialog360";
import {
  exchangeMetaSignupCode,
  provisionMetaEmbeddedSignup,
} from "@/lib/messaging/whatsapp-meta";
import {
  activateWhatsAppProvider,
  createClinicScopedAdminClient,
  findClinicChannelIdentityOwner,
} from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone/registry";

export type WhatsAppChannelStatus = {
  configured: boolean;
  status: "pending" | "active" | "error" | null;
  displayPhoneNumber: string | null;
  connectedAt: string | null;
};

function webhookUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    return new URL("/api/webhooks/whatsapp", url).toString();
  } catch {
    return null;
  }
}

/**
 * Whether the clinic has an active WhatsApp integration — the gate for
 * attempting a WhatsApp send at all (2026-07-19 flow revision). Email never
 * depends on this. Best-effort: any error resolves to false (email-only).
 */
export async function hasActiveWhatsAppChannel(clinicId: string): Promise<boolean> {
  const client = createClinicScopedAdminClient(clinicId);
  const result = await client
    .from("clinic_channels")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return !result.error && !!result.data;
}

export async function getWhatsAppChannelStatus(
  clinicId: string,
): Promise<WhatsAppChannelStatus> {
  const client = createClinicScopedAdminClient(clinicId);
  const result = await client
    .from("clinic_channels")
    .select("status, connected_at, credentials_encrypted")
    .eq("channel", "whatsapp")
    .eq("provider", "dialog360")
    .maybeSingle();
  if (result.error || !result.data) {
    return { configured: false, status: null, displayPhoneNumber: null, connectedAt: null };
  }
  let displayPhoneNumber: string | null = null;
  if (result.data.credentials_encrypted) {
    try {
      displayPhoneNumber =
        decryptChannelCredentials(result.data.credentials_encrypted).displayPhoneNumber ?? null;
    } catch {
      // A broken envelope is reflected as an error state without exposing details.
      return {
        configured: true,
        status: "error",
        displayPhoneNumber: null,
        connectedAt: result.data.connected_at,
      };
    }
  }
  return {
    configured: true,
    status: result.data.status,
    displayPhoneNumber,
    connectedAt: result.data.connected_at,
  };
}

export type MetaChannelState = {
  configured: boolean;
  /** Derived connection state; null when no Meta channel exists yet. */
  connectionState: string | null;
  /** Sanitized failure-reason code (never raw provider text). */
  reason: string | null;
  status: "pending" | "active" | "error" | null;
  displayPhoneNumber: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  businessVerificationStatus: string | null;
  phoneStatus: string | null;
  lastSyncedAt: string | null;
  connectedAt: string | null;
};

/**
 * P6C safe-metadata read for the onboarding wizard and status card. Returns only
 * the non-secret operational columns — the encrypted credential envelope is
 * decrypted solely to surface the display phone number, and a broken envelope
 * resolves to an `error` state without leaking details.
 */
export async function getMetaChannelState(clinicId: string): Promise<MetaChannelState> {
  const empty: MetaChannelState = {
    configured: false,
    connectionState: null,
    reason: null,
    status: null,
    displayPhoneNumber: null,
    qualityRating: null,
    messagingLimitTier: null,
    businessVerificationStatus: null,
    phoneStatus: null,
    lastSyncedAt: null,
    connectedAt: null,
  };
  const client = createClinicScopedAdminClient(clinicId);
  const result = await client
    .from("clinic_channels")
    .select(
      "status, connection_state, last_state_reason, quality_rating, messaging_limit_tier, business_verification_status, phone_status, last_synced_at, connected_at, credentials_encrypted",
    )
    .eq("channel", "whatsapp")
    .eq("provider", "meta")
    .maybeSingle();
  if (result.error || !result.data) return empty;

  let displayPhoneNumber: string | null = null;
  if (result.data.credentials_encrypted) {
    try {
      displayPhoneNumber =
        decryptChannelCredentials(result.data.credentials_encrypted).displayPhoneNumber ?? null;
    } catch {
      return { ...empty, configured: true, status: "error" };
    }
  }
  return {
    configured: true,
    connectionState: result.data.connection_state,
    reason: result.data.last_state_reason,
    status: result.data.status,
    displayPhoneNumber,
    qualityRating: result.data.quality_rating,
    messagingLimitTier: result.data.messaging_limit_tier,
    businessVerificationStatus: result.data.business_verification_status,
    phoneStatus: result.data.phone_status,
    lastSyncedAt: result.data.last_synced_at,
    connectedAt: result.data.connected_at,
  };
}

/** Connects a new number or rotates an existing number's API/webhook secrets. */
export async function connectDialog360Channel(input: {
  clinicId: string;
  apiKey: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
}): Promise<{ ok: true } | { ok: false; code: "CONFIGURATION" | "PROVIDER" | "DATABASE" }> {
  const callbackUrl = webhookUrl();
  if (!callbackUrl) return { ok: false, code: "CONFIGURATION" };

  const normalizedPhone = normalizePhone(input.displayPhoneNumber);
  if (!normalizedPhone) return { ok: false, code: "CONFIGURATION" };
  const identityOwner = await findClinicChannelIdentityOwner(
    "dialog360",
    input.phoneNumberId,
  );
  if (identityOwner.error) return { ok: false, code: "DATABASE" };
  if (identityOwner.data && identityOwner.data.clinic_id !== input.clinicId) {
    return { ok: false, code: "DATABASE" };
  }
  const webhookUsername = `clinicflow-${input.clinicId.slice(0, 8)}`;
  const webhookSecret = randomBytes(32).toString("base64url");
  let encrypted: string;
  try {
    // Validate the platform key before changing the provider callback.
    encrypted = encryptChannelCredentials({
      apiKey: input.apiKey,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: normalizedPhone,
      webhookUsername,
      webhookSecret,
    });
  } catch {
    return { ok: false, code: "CONFIGURATION" };
  }
  // Snapshot the provider state before mutation so a failed database write can
  // restore the exact prior callback instead of stranding an unknown secret.
  const previousWebhook = await getDialog360WebhookConfiguration(input.apiKey);
  if (!previousWebhook.ok) return { ok: false, code: "PROVIDER" };
  const configured = await configureDialog360Webhook({
    apiKey: input.apiKey,
    url: callbackUrl,
    username: webhookUsername,
    password: webhookSecret,
  });
  if (!configured.ok) return { ok: false, code: "PROVIDER" };
  const now = new Date().toISOString();
  const client = createClinicScopedAdminClient(input.clinicId);
  const stored = await client.from("clinic_channels").upsert(
    {
      clinic_id: input.clinicId,
      channel: "whatsapp",
      provider: "dialog360",
      credentials_encrypted: encrypted,
      // 360dialog/Meta webhooks route by this non-secret identifier.
      sender_identity: input.phoneNumberId,
      status: "pending",
      connected_at: now,
    },
    { onConflict: "clinic_id,channel,provider" },
  );
  if (!stored.error) {
    const activated = await activateWhatsAppProvider(input.clinicId, "dialog360");
    if (!activated.error && activated.data === true) return { ok: true };
  }

  const restored = await setDialog360WebhookConfiguration({
    apiKey: input.apiKey,
    configuration: previousWebhook.configuration,
  });
  if (!restored.ok) {
    Sentry.captureMessage("360dialog webhook compensation failed", {
      level: "error",
      tags: {
        scope: "messaging-connect-compensation",
        provider: "dialog360",
        clinicId: input.clinicId,
      },
    });
  }
  return { ok: false, code: "DATABASE" };
}

export type MetaConnectResult =
  | { ok: true; channelId: string }
  | { ok: false; code: "CONFIGURATION" | "PROVIDER" | "IDENTITY_TAKEN" | "DATABASE" };

/**
 * P6C completion step (plan line 1309, step 4). Exchanges the Embedded Signup
 * authorization code for a per-clinic system-user token, stores the Meta channel
 * through the P3A encryption boundary (status `pending`, state `connecting_to_meta`
 * — sends stay gated until the reconciliation poll derives `connected`), and
 * subscribes our app to the clinic's WABA so their traffic reaches our webhook.
 *
 * Two-clinic safety: the phone-number identity is claimed via
 * findClinicChannelIdentityOwner before any write, so clinic A's completion can
 * never bind a number already owned by clinic B. Credentials never leave this
 * boundary; the code and token are never logged.
 */
export async function connectMetaChannel(input: {
  clinicId: string;
  code: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<MetaConnectResult> {
  const identityOwner = await findClinicChannelIdentityOwner("meta", input.phoneNumberId);
  if (identityOwner.error) return { ok: false, code: "DATABASE" };
  if (identityOwner.data && identityOwner.data.clinic_id !== input.clinicId) {
    return { ok: false, code: "IDENTITY_TAKEN" };
  }

  // Claim the cross-provider identity in the database before any provider-side
  // registration/subscription mutation. The global unique index closes the
  // preflight race; a failed provisioning attempt leaves an honest resumable
  // pending row owned by this clinic.
  const now = new Date().toISOString();
  const client = createClinicScopedAdminClient(input.clinicId);
  const existing = await client
    .from("clinic_channels")
    .select("id, sender_identity, provider_account_id")
    .eq("channel", "whatsapp")
    .eq("provider", "meta")
    .maybeSingle();
  if (existing.error) return { ok: false, code: "DATABASE" };
  if (
    existing.data &&
    (existing.data.sender_identity !== input.phoneNumberId ||
      (existing.data.provider_account_id &&
        existing.data.provider_account_id !== input.wabaId))
  ) {
    return { ok: false, code: "CONFIGURATION" };
  }
  const claim = existing.data
    ? { data: { id: existing.data.id }, error: null }
    : await client
        .from("clinic_channels")
        .insert({
          clinic_id: input.clinicId,
          channel: "whatsapp",
          provider: "meta",
          sender_identity: input.phoneNumberId,
          provider_account_id: input.wabaId,
          status: "pending",
          connection_state: "connecting_to_meta",
          connected_at: null,
          webhook_subscribed: false,
          last_signal_at: now,
          last_state_reason: null,
        })
        .select("id")
        .maybeSingle();
  if (claim.error || !claim.data) {
    return { ok: false, code: identityOwner.data ? "DATABASE" : "IDENTITY_TAKEN" };
  }

  const exchanged = await exchangeMetaSignupCode(input.code);
  if (!exchanged.ok) return { ok: false, code: "PROVIDER" };

  const provisioned = await provisionMetaEmbeddedSignup({
    oauthAccessToken: exchanged.accessToken,
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
  });
  if (!provisioned.ok) return { ok: false, code: "PROVIDER" };

  let encrypted: string;
  try {
    encrypted = encryptChannelCredentials(provisioned.channel);
  } catch {
    return { ok: false, code: "CONFIGURATION" };
  }

  const stored = await client
    .from("clinic_channels")
    .update({
      credentials_encrypted: encrypted,
      status: "pending",
      connection_state: "connecting_to_meta",
      connected_at: null,
      webhook_subscribed: true,
      last_signal_at: now,
      last_state_reason: null,
    })
    .eq("id", claim.data.id)
    .eq("provider", "meta")
    .select("id")
    .maybeSingle();
  if (stored.error || !stored.data) return { ok: false, code: "DATABASE" };

  return { ok: true, channelId: stored.data.id };
}
