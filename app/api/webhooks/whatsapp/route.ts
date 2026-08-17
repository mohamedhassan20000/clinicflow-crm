import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  enforceWebhookRateLimit,
  unauthorizedWebhookResponse,
  unavailableWebhookResponse,
} from "@/lib/messaging/webhook-http";
import { recordVerifiedWhatsAppWebhook } from "@/lib/messaging/health";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import {
  dialog360WhatsAppProvider,
  extractDialog360PhoneNumberId,
  extractDialog360TemplateId,
} from "@/lib/messaging/whatsapp-dialog360";
import {
  extractMetaPhoneNumberId,
  extractMetaTemplateId,
  extractMetaWabaId,
  metaWhatsAppProvider,
} from "@/lib/messaging/whatsapp-meta";
import { recordWebhookRouteRejection } from "@/lib/messaging/webhook-telemetry";
import { matchesWebhookVerifyToken } from "@/lib/messaging/webhook-verify-token";
import {
  createClinicScopedAdminClient,
  findClinicChannelByProviderAccount,
  findClinicChannelForWebhook,
  findMessageTemplateForWebhook,
  findMessageTemplateBindingForWebhook,
} from "@/lib/supabase/admin";

/**
 * P6C: Meta Cloud API subscription handshake. Meta issues a GET with
 * `hub.mode=subscribe` and a verify token when the webhook is registered; we echo
 * `hub.challenge` only on an exact, timing-independent token match. 360dialog does
 * not use this handshake, so a missing/mismatched token is a plain 403.
 *
 * P7D adds the per-clinic variant. A clinic connecting its own Meta app
 * registers the callback as `…/whatsapp?clinic=<id>` and pastes the verify token
 * ClinicFlow showed them, which is derived from that clinic id. The platform
 * token is still accepted (unparameterized) for every platform-brokered channel.
 * A `clinic` parameter never grants anything by itself — it only selects which
 * token must match, and it plays no part in routing an actual event.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const clinicId = url.searchParams.get("clinic");
  const platformToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const accepted = clinicId
    ? matchesWebhookVerifyToken(clinicId, token)
    : Boolean(platformToken) && token === platformToken;
  if (mode === "subscribe" && accepted && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "content-type": "text/plain", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse("Forbidden", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleMeta(request: Request): Promise<NextResponse> {
  const signatureRequest = request.clone();
  const parseRequest = request.clone();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return unauthorizedWebhookResponse();
  }

  const phoneNumberId = extractMetaPhoneNumberId(payload);
  const wabaId = extractMetaWabaId(payload);
  const providerTemplateId = extractMetaTemplateId(payload);
  const channel = phoneNumberId
    ? await findClinicChannelForWebhook("meta", phoneNumberId)
    : wabaId
      ? await findClinicChannelByProviderAccount("meta", wabaId)
      : { data: null, error: null };
  // A failed lookup is answered before the signature check: we cannot tell an
  // unsigned request from a correctly signed one whose channel we simply could
  // not read, and a 503 asks Meta to retry rather than discarding the event.
  if (channel.error) {
    Sentry.captureException(channel.error, {
      tags: { scope: "webhook-routing", provider: "meta" },
    });
    return unavailableWebhookResponse();
  }
  let routedClinicId = channel.data?.clinic_id;

  // Authenticity, before anything is read out of the payload or written (§9.2).
  //
  // Platform-brokered channels are all signed by our one app with the platform
  // app secret. A P7D channel belongs to the clinic's own Meta app, so Meta
  // signs it with *their* app secret, which lives in that channel's encrypted
  // envelope. Deciding which secret to use therefore requires routing first —
  // the same ordering the 360dialog path below has always used. Routing is a
  // pair of indexed reads with no side effects, and an unroutable or
  // unverifiable request is still a 401 that reaches no clinic data.
  let signingCredentials: Awaited<ReturnType<typeof decryptChannelCredentials>> = {};
  if (channel.data?.credentials_encrypted) {
    try {
      signingCredentials = decryptChannelCredentials(channel.data.credentials_encrypted);
    } catch (error) {
      Sentry.captureException(error, { tags: { scope: "webhook", provider: "meta" } });
      return unavailableWebhookResponse();
    }
  }
  if (
    !(await metaWhatsAppProvider.verifySignature(signatureRequest, signingCredentials))
  ) {
    await recordWebhookRouteRejection("meta", "signature");
    return unauthorizedWebhookResponse();
  }
  if (!routedClinicId && providerTemplateId) {
    const binding = await findMessageTemplateBindingForWebhook(
      "meta",
      providerTemplateId,
    );
    if (binding.error) {
      Sentry.captureException(binding.error, {
        tags: { scope: "webhook-routing", provider: "meta" },
      });
      return unavailableWebhookResponse();
    }
    routedClinicId = binding.data?.clinic_id;
  }

  try {
    if (routedClinicId) {
      await recordVerifiedWhatsAppWebhook({
        clinicId: routedClinicId,
        provider: "meta",
      }).catch((error) => {
        Sentry.captureException(error, {
          tags: { scope: "webhook-health-stamp", provider: "meta" },
        });
      });
    }
    const events = await metaWhatsAppProvider.parseWebhook(parseRequest);
    const summary = await processMessagingWebhookEvents({
      provider: "meta",
      clinicId: routedClinicId,
      senderIdentity:
        phoneNumberId ?? channel.data?.sender_identity ?? undefined,
      events,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "webhook", provider: "meta" } });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Meta-direct traffic carries an X-Hub-Signature-256 header; 360dialog uses
  // Basic auth. Route by that signal so both providers coexist per-clinic during
  // the migration (plan line 1308).
  const isMeta = request.headers.get("x-hub-signature-256") !== null;
  const limited = await enforceWebhookRateLimit(request, isMeta ? "meta" : "dialog360");
  if (limited) return limited;
  if (isMeta) return handleMeta(request);

  const signatureRequest = request.clone();
  const parseRequest = request.clone();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return unauthorizedWebhookResponse();
  }

  const phoneNumberId = extractDialog360PhoneNumberId(payload);
  let channel = phoneNumberId
    ? await findClinicChannelForWebhook("dialog360", phoneNumberId)
    : { data: null, error: null };
  if (!phoneNumberId) {
    const providerTemplateId = extractDialog360TemplateId(payload);
    if (!providerTemplateId) {
      return unauthorizedWebhookResponse();
    }
    const template = await findMessageTemplateForWebhook(providerTemplateId);
    if (template.error) {
      Sentry.captureException(template.error, {
        tags: { scope: "webhook-routing", provider: "dialog360" },
      });
      return unavailableWebhookResponse();
    }
    if (!template.data) {
      return unauthorizedWebhookResponse();
    }
    const scoped = createClinicScopedAdminClient(template.data.clinic_id);
    channel = await scoped
      .from("clinic_channels")
      .select("clinic_id, credentials_encrypted")
      .eq("channel", "whatsapp")
      .eq("provider", "dialog360")
      .eq("status", "active")
      .maybeSingle();
  }
  if (channel.error) {
    Sentry.captureException(channel.error, {
      tags: { scope: "webhook-routing", provider: "dialog360" },
    });
    return unavailableWebhookResponse();
  }
  if (!channel.data?.credentials_encrypted) {
    return unauthorizedWebhookResponse();
  }

  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.data.credentials_encrypted);
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "webhook", provider: "dialog360" } });
    return unavailableWebhookResponse();
  }

  if (!(await dialog360WhatsAppProvider.verifySignature(signatureRequest, credentials))) {
    await recordWebhookRouteRejection("dialog360", "signature");
    return unauthorizedWebhookResponse();
  }

  try {
    await recordVerifiedWhatsAppWebhook({
      clinicId: channel.data.clinic_id,
      provider: "dialog360",
    }).catch((error) => {
      Sentry.captureException(error, {
        tags: { scope: "webhook-health-stamp", provider: "dialog360" },
      });
    });
    const events = await dialog360WhatsAppProvider.parseWebhook(parseRequest);
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: channel.data.clinic_id,
      senderIdentity: phoneNumberId ?? undefined,
      events,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "webhook", provider: "dialog360" } });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
