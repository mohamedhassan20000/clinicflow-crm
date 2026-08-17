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
  requestMetaSmbDataSync,
  verifyManualMetaCredentials,
  type ManualMetaCredentialsInput,
  type MetaOnboardingFlow,
} from "@/lib/messaging/whatsapp-meta";
import {
  activateWhatsAppProvider,
  createClinicScopedAdminClient,
  findClinicChannelIdentityOwner,
} from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone/registry";
import { deriveWebhookVerifyToken } from "@/lib/messaging/webhook-verify-token";
import type { MessagingProviderId } from "@/lib/messaging/types";
import {
  toWhatsAppBusinessConnectionView,
  type WhatsAppBusinessConnectionView,
} from "@/lib/messaging/connection-view";

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
 * P7D — what a clinic must paste into the Webhooks section of *their own* Meta
 * app when connecting with their own credentials.
 *
 * Both values are clinic-specific and safe to show a clinic admin: the callback
 * URL is public by nature, and the verify token is a one-way derivation that
 * only governs Meta's subscription handshake for this clinic. No platform
 * secret, app id or internal identifier is involved. Returns null when the
 * environment cannot produce them, so the UI can say so plainly instead of
 * rendering a half-configured instruction.
 */
export function getMetaWebhookSetup(
  clinicId: string,
): { callbackUrl: string; verifyToken: string } | null {
  const base = webhookUrl();
  const verifyToken = deriveWebhookVerifyToken(clinicId);
  if (!base || !verifyToken) return null;
  const url = new URL(base);
  url.searchParams.set("clinic", clinicId);
  return { callbackUrl: url.toString(), verifyToken };
}

/**
 * Whether the clinic has an active WhatsApp integration — the gate for
 * attempting a WhatsApp send at all (2026-07-19 flow revision). Email never
 * depends on this. Best-effort: any error resolves to false (email-only).
 */
export async function hasActiveWhatsAppChannel(clinicId: string): Promise<boolean> {
  return (await getActiveWhatsAppProvider(clinicId)) !== null;
}

/**
 * Which transport currently carries this clinic's WhatsApp, if any.
 *
 * Callers that only need "can we send at all?" use hasActiveWhatsAppChannel.
 * The automated flows need the transport itself, because a Cloud API send must
 * use a Meta-approved template while a linked device has no template catalogue
 * to approve anything in. Best-effort: any error resolves to null (email-only).
 */
export async function getActiveWhatsAppProvider(
  clinicId: string,
): Promise<MessagingProviderId | null> {
  const client = createClinicScopedAdminClient(clinicId);
  const result = await client
    .from("clinic_channels")
    .select("provider")
    .eq("channel", "whatsapp")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return result.error ? null : (result.data?.provider ?? null);
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
  /** P7C: how this channel was onboarded; null on legacy rows. */
  onboardingFlow: MetaOnboardingFlow | null;
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
    onboardingFlow: null,
  };
  const client = createClinicScopedAdminClient(clinicId);
  const result = await client
    .from("clinic_channels")
    .select(
      "status, connection_state, last_state_reason, quality_rating, messaging_limit_tier, business_verification_status, phone_status, last_synced_at, connected_at, credentials_encrypted, onboarding_flow",
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
    onboardingFlow: asOnboardingFlow(result.data.onboarding_flow),
  };
}

/**
 * P7E — the one answer to "who owns this clinic's WhatsApp number?".
 *
 * A clinic has exactly one WhatsApp channel, and two methods can establish it.
 * Both cards on the settings page render from this single projection, so they
 * can never contradict each other about which of them owns the connection. The
 * linked-device pairing is checked first because it is the only transport whose
 * channel row is written by the worker, and its presence is decisive.
 *
 * Only non-secret facts cross: a coarse status, the display number, when it
 * connected, and which method did it.
 */
export async function getWhatsAppConnectionView(
  clinicId: string,
): Promise<WhatsAppBusinessConnectionView> {
  const client = createClinicScopedAdminClient(clinicId);
  const linked = await client
    .from("clinic_channels")
    .select("status, connected_at, sender_identity")
    .eq("channel", "whatsapp")
    .eq("provider", "linked_device")
    .maybeSingle();
  if (!linked.error && linked.data) {
    return {
      status:
        linked.data.status === "active"
          ? "connected"
          : linked.data.status === "error"
            ? "failed"
            : "verifying",
      // The pairing's sender identity *is* the paired number in E.164; there is
      // no separate provider display value to decrypt.
      displayPhoneNumber: linked.data.sender_identity,
      connectedAt: linked.data.connected_at,
      mode: "linked_device",
    };
  }
  return toWhatsAppBusinessConnectionView(await getMetaChannelState(clinicId));
}

/** Narrows the stored (nullable, legacy-tolerant) column to the known flows. */
function asOnboardingFlow(value: string | null): MetaOnboardingFlow | null {
  return value === "coexistence" ||
    value === "embedded_signup" ||
    value === "manual_api"
    ? value
    : null;
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
  /**
   * P7C. `coexistence` connects a number that stays live in the clinic's
   * WhatsApp Business app: provisioning skips Cloud API phone registration,
   * subscribes the extra Business-app webhook fields, and requests the one-time
   * contacts/history synchronization Meta only allows within 24 hours.
   * Defaults to the P6C Cloud-API-only flow.
   */
  flow?: MetaOnboardingFlow;
}): Promise<MetaConnectResult> {
  const flow: MetaOnboardingFlow = input.flow ?? "embedded_signup";
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
          onboarding_flow: flow,
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
    flow,
  });
  if (!provisioned.ok) return { ok: false, code: "PROVIDER" };

  let encrypted: string;
  try {
    encrypted = encryptChannelCredentials(provisioned.channel);
  } catch {
    return { ok: false, code: "CONFIGURATION" };
  }

  // P7C: Meta only accepts the Business-app contacts/history backfill within 24
  // hours of onboarding, so it is requested here rather than deferred to the
  // reconciliation cron. It is deliberately best-effort — a refused backfill
  // still leaves a fully working channel for new conversations, so it must not
  // fail the connection. Meta answers asynchronously over the webhook.
  const historySync =
    flow === "coexistence"
      ? await requestMetaSmbDataSync(provisioned.channel).catch(() => ({
          contacts: false,
          history: false,
        }))
      : null;

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
      onboarding_flow: flow,
      // Only stamped on an actually-requested backfill; never cleared, so a
      // later reconnect cannot erase the record of the original 24h window.
      ...(historySync?.contacts || historySync?.history
        ? { history_sync_requested_at: now }
        : {}),
    })
    .eq("id", claim.data.id)
    .eq("provider", "meta")
    .select("id")
    .maybeSingle();
  if (stored.error || !stored.data) return { ok: false, code: "DATABASE" };

  return { ok: true, channelId: stored.data.id };
}

export type ManualMetaConnectResult =
  | { ok: true; channelId: string; displayPhoneNumber: string }
  | {
      ok: false;
      code: "CONFIGURATION" | "PROVIDER" | "IDENTITY_TAKEN" | "DATABASE";
    };

/**
 * P7D — connects a clinic's *own* Meta / WhatsApp Cloud API credentials.
 *
 * This is the second of the two supported per-clinic connection methods, and it
 * is the only one in which nothing platform-owned ends up on the channel: the
 * stored envelope holds the clinic's own app id, app secret and permanent access
 * token, so their sends go out on their account and their webhooks are verified
 * against their app secret.
 *
 * Two-clinic safety is identical to the Embedded Signup path and is enforced
 * twice: `findClinicChannelIdentityOwner` refuses a number already owned by
 * another clinic, and the global `clinic_channels_whatsapp_sender_unique_idx`
 * closes the preflight race at the database. A clinic may therefore only ever
 * (re)claim a number no other clinic holds.
 *
 * Unlike the signup flows, the credentials are verified against Meta *before*
 * the identity is claimed: nothing here is resumable — there is no popup to
 * return from — so a rejected credential set should leave no row behind.
 */
export async function connectMetaChannelManually(input: {
  clinicId: string;
  credentials: ManualMetaCredentialsInput;
}): Promise<ManualMetaConnectResult> {
  const { clinicId, credentials } = input;

  const identityOwner = await findClinicChannelIdentityOwner(
    "meta",
    credentials.phoneNumberId,
  );
  if (identityOwner.error) return { ok: false, code: "DATABASE" };
  if (identityOwner.data && identityOwner.data.clinic_id !== clinicId) {
    return { ok: false, code: "IDENTITY_TAKEN" };
  }

  const verified = await verifyManualMetaCredentials(credentials);
  if (!verified.ok) return { ok: false, code: "PROVIDER" };

  let encrypted: string;
  try {
    encrypted = encryptChannelCredentials({
      accessToken: credentials.accessToken,
      phoneNumberId: credentials.phoneNumberId,
      wabaId: credentials.wabaId,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      displayPhoneNumber: verified.verification.displayPhoneNumber,
    });
  } catch {
    return { ok: false, code: "CONFIGURATION" };
  }

  // A clinic reconnecting or rotating its own credentials keeps its existing
  // row; switching to a *different* number requires disconnecting first, so the
  // released identity is never silently re-pointed while conversations,
  // templates and message history still reference it.
  const now = new Date().toISOString();
  const client = createClinicScopedAdminClient(clinicId);
  const existing = await client
    .from("clinic_channels")
    .select("id, sender_identity")
    .eq("channel", "whatsapp")
    .eq("provider", "meta")
    .maybeSingle();
  if (existing.error) return { ok: false, code: "DATABASE" };
  if (existing.data && existing.data.sender_identity !== credentials.phoneNumberId) {
    return { ok: false, code: "CONFIGURATION" };
  }

  const row = {
    credentials_encrypted: encrypted,
    provider_account_id: credentials.wabaId,
    onboarding_flow: "manual_api" as const,
    // The clinic's own account is already live, so the derived state only waits
    // on the reconciliation poll to confirm phone health — it is never claimed
    // as connected here.
    status: "pending" as const,
    connection_state: "connecting_to_meta",
    connected_at: null,
    webhook_subscribed: verified.verification.webhookSubscribed,
    phone_status: verified.verification.phoneStatus,
    last_signal_at: now,
    last_state_reason: null,
  };

  const stored = existing.data
    ? await client
        .from("clinic_channels")
        .update(row)
        .eq("id", existing.data.id)
        .eq("provider", "meta")
        .select("id")
        .maybeSingle()
    : await client
        .from("clinic_channels")
        .insert({
          clinic_id: clinicId,
          channel: "whatsapp",
          provider: "meta",
          sender_identity: credentials.phoneNumberId,
          ...row,
        })
        .select("id")
        .maybeSingle();
  if (stored.error || !stored.data) {
    // A unique-index violation here means another clinic claimed the number
    // between the preflight and the write.
    return { ok: false, code: existing.data ? "DATABASE" : "IDENTITY_TAKEN" };
  }

  return {
    ok: true,
    channelId: stored.data.id,
    displayPhoneNumber: verified.verification.displayPhoneNumber,
  };
}

/**
 * Removes this clinic's Meta WhatsApp channel, whichever flow created it.
 *
 * Deleting the row (rather than deactivating it) is deliberate: it releases the
 * globally unique WhatsApp sender identity so the clinic can reconnect a
 * different number, and so a number a clinic genuinely gave up can be claimed by
 * whoever owns it next. Conversations, templates and message history are keyed
 * by clinic, not by channel, and are untouched.
 *
 * Clinic-scoped by construction — the delete cannot reach another tenant's row.
 * The retained 360dialog channel, if any, is restored as the active transport so
 * disconnecting Meta degrades to the existing provider instead of silencing the
 * clinic.
 */
export async function disconnectMetaChannel(
  clinicId: string,
): Promise<{ ok: true } | { ok: false; code: "DATABASE" }> {
  const client = createClinicScopedAdminClient(clinicId);
  const removed = await client
    .from("clinic_channels")
    .delete()
    .eq("channel", "whatsapp")
    .eq("provider", "meta");
  if (removed.error) return { ok: false, code: "DATABASE" };

  // Best-effort: only meaningful for clinics still carrying a 360dialog row from
  // before the Meta cutover. A clinic without one is simply left with no
  // WhatsApp channel, which the send path already degrades to email for.
  await activateWhatsAppProvider(clinicId, "dialog360").catch(() => undefined);
  return { ok: true };
}
