import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { resendEmailProvider } from "@/lib/messaging/email-resend";
import {
  enforceWebhookRateLimit,
  unauthorizedWebhookResponse,
} from "@/lib/messaging/webhook-http";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

export async function POST(request: Request) {
  const limited = await enforceWebhookRateLimit(request, "resend");
  if (limited) return limited;

  if (!(await resendEmailProvider.verifySignature(request.clone(), {}))) {
    return unauthorizedWebhookResponse();
  }

  try {
    const events = await resendEmailProvider.parseWebhook(request.clone());
    const summary = await processMessagingWebhookEvents({ provider: "resend", events });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "webhook", provider: "resend" } });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
