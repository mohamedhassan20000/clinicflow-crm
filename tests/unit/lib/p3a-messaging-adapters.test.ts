import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emailsSend: vi.fn(),
}));

vi.mock("@/lib/email/resend", () => ({
  DEFAULT_FROM: "clinic@clinicflow.fit",
  getResend: () => ({ emails: { send: mocks.emailsSend } }),
}));

import { resendEmailProvider } from "@/lib/messaging/email-resend";

const emailMessage = {
  channel: "email" as const,
  recipient: "patient@example.com",
  body: "Your appointment is tomorrow at 10:00.",
  subject: "Appointment reminder",
  senderIdentity: "reminders@clinic.example",
};

afterEach(() => {
  vi.restoreAllMocks();
  mocks.emailsSend.mockReset();
});

describe("resend email adapter", () => {
  it("sends through Resend and returns the provider message id", async () => {
    mocks.emailsSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
    const result = await resendEmailProvider.send(emailMessage, {});
    expect(result).toEqual({ ok: true, providerMessageId: "email-123", costMicro: null });
    expect(mocks.emailsSend).toHaveBeenCalledWith({
      from: "reminders@clinic.example",
      to: "patient@example.com",
      subject: "Appointment reminder",
      text: emailMessage.body,
    });
  });

  it("fails without a subject and reports provider errors scrubbed", async () => {
    const missingSubject = await resendEmailProvider.send(
      { ...emailMessage, subject: undefined },
      {},
    );
    expect(missingSubject.ok).toBe(false);

    mocks.emailsSend.mockResolvedValue({
      data: null,
      error: { message: "invalid key re_1234567890abcdef provided" },
    });
    const failed = await resendEmailProvider.send(emailMessage, {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).not.toContain("re_1234567890abcdef");
  });

  it("verifies a valid Svix signature and rejects tampered or stale ones", async () => {
    const secretBytes = Buffer.from("super-secret-webhook-key-32bytes");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e-1" } });
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secretBytes)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const makeRequest = (sig: string, ts = timestamp) =>
      new Request("https://example.com/webhook", {
        method: "POST",
        body,
        headers: {
          "svix-id": id,
          "svix-timestamp": ts,
          "svix-signature": `v1,${sig}`,
        },
      });

    await expect(
      resendEmailProvider.verifySignature(makeRequest(signature), {
        webhookSecret: secret,
      }),
    ).resolves.toBe(true);
    await expect(
      resendEmailProvider.verifySignature(makeRequest("v1invalid"), {
        webhookSecret: secret,
      }),
    ).resolves.toBe(false);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const staleSig = createHmac("sha256", secretBytes)
      .update(`${id}.${stale}.${body}`)
      .digest("base64");
    await expect(
      resendEmailProvider.verifySignature(makeRequest(staleSig, stale), {
        webhookSecret: secret,
      }),
    ).resolves.toBe(false);
    await expect(
      resendEmailProvider.verifySignature(makeRequest(signature), {}),
    ).resolves.toBe(false);
  });

  it("parses status callbacks and ignores unknown events", async () => {
    const request = (payload: unknown) =>
      new Request("https://example.com/webhook", {
        method: "POST",
        body: JSON.stringify(payload),
      });

    await expect(
      resendEmailProvider.parseWebhook(
        request({ type: "email.delivered", created_at: "2026-07-17T09:00:00Z", data: { email_id: "e-1" } }),
      ),
    ).resolves.toEqual([
      {
        kind: "status",
        providerMessageId: "e-1",
        status: "delivered",
        error: null,
        occurredAt: "2026-07-17T09:00:00Z",
      },
    ]);
    await expect(
      resendEmailProvider.parseWebhook(
        request({ type: "email.bounced", data: { email_id: "e-2" } }),
      ),
    ).resolves.toMatchObject([{ kind: "status", status: "failed" }]);
    await expect(
      resendEmailProvider.parseWebhook(request({ type: "email.clicked", data: { email_id: "e-3" } })),
    ).resolves.toMatchObject([{ kind: "ignored" }]);
    await expect(
      resendEmailProvider.parseWebhook(
        new Request("https://example.com/webhook", { method: "POST", body: "not json" }),
      ),
    ).resolves.toMatchObject([{ kind: "ignored", reason: "invalid_json" }]);
  });
});
