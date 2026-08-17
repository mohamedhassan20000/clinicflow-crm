import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import {
  enforceWebhookRateLimit,
  unauthorizedWebhookResponse,
  unavailableWebhookResponse,
} from "@/lib/messaging/webhook-http";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import {
  linkedDeviceWhatsAppProvider,
  parseLinkedDeviceCallback,
  readLinkedDeviceCallbackClinicId,
} from "@/lib/messaging/whatsapp-linked-device";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

/**
 * P7E — the callback the pairing worker posts a clinic's WhatsApp traffic to.
 *
 * Unlike the Meta and 360dialog routes this endpoint has no public provider on
 * the other side: the only legitimate caller is our own worker, authenticated by
 * an HMAC over the exact bytes plus a bounded timestamp. Everything a caller
 * *claims* — including which clinic it is speaking for — is treated as untrusted
 * until it has been proved against a stored channel:
 *
 *   1. the signature is verified before the body is read for meaning,
 *   2. the claimed clinic must own an active linked-device channel,
 *   3. every inbound event is bound to that channel's sender identity, so a
 *      valid-but-misdirected callback cannot write into another tenant, and
 *   4. the events then go through exactly the same pipeline as Cloud API
 *      traffic — one inbox, one conversation model, one set of notifications.
 */
export async function POST(request: Request) {
  const limited = await enforceWebhookRateLimit(request, "linked_device");
  if (limited) return limited;

  // Authenticity first, over the raw bytes. The clone keeps the body readable
  // afterwards; nothing below runs on an unverified request.
  if (!(await linkedDeviceWhatsAppProvider.verifySignature(request.clone(), {}))) {
    return unauthorizedWebhookResponse();
  }

  const body = await request.text();
  const clinicId = readLinkedDeviceCallbackClinicId(body);
  if (!clinicId) return unauthorizedWebhookResponse();

  const channel = await createClinicScopedAdminClient(clinicId)
    .from("clinic_channels")
    .select("sender_identity, status")
    .eq("channel", "whatsapp")
    .eq("provider", "linked_device")
    .maybeSingle();
  if (channel.error) {
    Sentry.captureException(channel.error, {
      tags: { scope: "webhook-routing", provider: "linked_device" },
    });
    // Ask the worker to retry rather than discarding a signed event we merely
    // failed to route.
    return unavailableWebhookResponse();
  }
  if (!channel.data || channel.data.status !== "active") {
    // A pairing that is not (or no longer) the clinic's active channel carries
    // no traffic. Acknowledged so the worker stops retrying.
    return NextResponse.json({ ok: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const events = parseLinkedDeviceCallback(body, channel.data.sender_identity);
    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId,
      senderIdentity: channel.data.sender_identity,
      events,
    });
    return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "webhook", provider: "linked_device" },
    });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
