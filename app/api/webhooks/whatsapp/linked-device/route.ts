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
  readLinkedDeviceCallbackAccountId,
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
  const callbackAccountId = readLinkedDeviceCallbackAccountId(body);
  if (!clinicId || !callbackAccountId) return unauthorizedWebhookResponse();

  const client = createClinicScopedAdminClient(clinicId);
  const [channel, session] = await Promise.all([
    client
      .from("clinic_channels")
      .select("sender_identity, status")
      .eq("channel", "whatsapp")
      .eq("provider", "linked_device")
      .maybeSingle(),
    client
      .from("whatsapp_linked_device_sessions")
      .select("authenticated_account_id")
      .eq("clinic_id", clinicId)
      .maybeSingle(),
  ]);
  if (channel.error || session.error) {
    Sentry.captureException(channel.error ?? session.error, {
      tags: { scope: "webhook-routing", provider: "linked_device" },
    });
    // Ask the worker to retry rather than discarding a signed event we merely
    // failed to route.
    return unavailableWebhookResponse();
  }
  if (
    !channel.data ||
    channel.data.status !== "active" ||
    channel.data.sender_identity !== callbackAccountId ||
    session.data?.authenticated_account_id !== callbackAccountId
  ) {
    // A pairing that is not (or no longer) the clinic's active channel carries
    // no traffic. Acknowledged so the worker stops retrying.
    return NextResponse.json({ ok: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const events = parseLinkedDeviceCallback(body, callbackAccountId);
    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId,
      // The signed account, not the channel column — even though the guard
      // above has just proved the two are equal. The equality is what makes it
      // safe to proceed; the *identity that was signed for* is what the rest of
      // the pipeline should be scoped by. Reading the column back here would
      // reintroduce a second source of truth for account ownership, and the
      // next person to relax one of those three comparisons would silently be
      // choosing which of them wins.
      senderIdentity: callbackAccountId,
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
