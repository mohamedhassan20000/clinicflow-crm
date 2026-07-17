import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  enforceWebhookRateLimit,
  unauthorizedWebhookResponse,
  unavailableWebhookResponse,
} from "@/lib/messaging/webhook-http";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import {
  dialog360WhatsAppProvider,
  extractDialog360PhoneNumberId,
  extractDialog360TemplateId,
} from "@/lib/messaging/whatsapp-dialog360";
import {
  createClinicScopedAdminClient,
  findClinicChannelForWebhook,
  findMessageTemplateForWebhook,
} from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const limited = await enforceWebhookRateLimit(request, "dialog360");
  if (limited) return limited;

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
    return unauthorizedWebhookResponse();
  }

  try {
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
