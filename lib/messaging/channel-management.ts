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
      status: "active",
      connected_at: now,
    },
    { onConflict: "clinic_id,channel" },
  );
  if (!stored.error) return { ok: true };

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
