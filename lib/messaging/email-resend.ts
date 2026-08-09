import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_FROM, getResend } from "@/lib/email/resend";
import type { MessagingProvider } from "@/lib/messaging/provider";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import type {
  ChannelCredentials,
  ProviderMessage,
  ProviderSendResult,
  WebhookEvent,
} from "@/lib/messaging/types";

/**
 * Email adapter over Resend — generalizes the lib/email/resend.ts wiring the
 * P1.5B invitation email introduced. Email is the platform-key channel: the
 * send boundary provisions the platform sender identity; RESEND_API_KEY stays
 * platform-side, so clinic_channels stores no secret for email.
 *
 * Webhook signatures are Svix-format (Resend's scheme): HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` with the base64 secret from
 * `whsec_…`, compared against each `v1,<sig>` entry in `svix-signature`.
 */

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** Resend delivery events → outbound_messages statuses. */
const EVENT_STATUS: Record<
  string,
  Extract<WebhookEvent, { kind: "status" }>["status"]
> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "read",
  "email.bounced": "failed",
  "email.failed": "failed",
};

function resolveWebhookSecret(credentials: ChannelCredentials): string | null {
  return credentials.webhookSecret ?? process.env.RESEND_WEBHOOK_SECRET ?? null;
}

async function verifySvixSignature(
  request: Request,
  secret: string,
): Promise<boolean> {
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatureHeader = request.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const skew = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (skew > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64",
  );
  if (key.length === 0) return false;

  const body = await request.text();
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();

  for (const entry of signatureHeader.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || !signature) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(signature, "base64");
    } catch {
      continue;
    }
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return true;
    }
  }
  return false;
}

export const resendEmailProvider: MessagingProvider = {
  id: "resend",
  channel: "email",

  // Email uses the platform Resend key; per-clinic credentials are unused.
  async send(message: ProviderMessage): Promise<ProviderSendResult> {
    if (!message.subject?.trim()) {
      return { ok: false, error: "Email sends require a subject." };
    }
    try {
      const attachments = message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      }));
      const result = await getResend().emails.send({
        from: message.senderIdentity || DEFAULT_FROM,
        to: message.recipient,
        subject: message.subject,
        text: message.body,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      if (result.error) {
        return { ok: false, error: sanitizeProviderError(result.error.message) };
      }
      return {
        ok: true,
        providerMessageId: result.data?.id ?? null,
        costMicro: null,
      };
    } catch (error) {
      return { ok: false, error: sanitizeProviderError(error) };
    }
  },

  async verifySignature(
    request: Request,
    credentials: ChannelCredentials,
  ): Promise<boolean> {
    const secret = resolveWebhookSecret(credentials);
    if (!secret) return false;
    try {
      return await verifySvixSignature(request, secret);
    } catch {
      return false;
    }
  },

  async parseWebhook(request: Request): Promise<WebhookEvent[]> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return [{ kind: "ignored", reason: "invalid_json" }];
    }
    if (!payload || typeof payload !== "object") {
      return [{ kind: "ignored", reason: "invalid_payload" }];
    }
    const event = payload as {
      type?: unknown;
      created_at?: unknown;
      data?: { email_id?: unknown };
    };
    const type = typeof event.type === "string" ? event.type : "";
    const emailId =
      typeof event.data?.email_id === "string" ? event.data.email_id : null;
    const status = EVENT_STATUS[type];
    if (!status || !emailId) {
      return [{ kind: "ignored", reason: type || "unknown_event" }];
    }
    return [
      {
        kind: "status",
        providerMessageId: emailId,
        status,
        error: status === "failed" ? type : null,
        occurredAt:
          typeof event.created_at === "string" ? event.created_at : null,
      },
    ];
  },
};
