import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureDialog360Webhook,
  dialog360WhatsAppProvider,
  extractDialog360PhoneNumberId,
  getDialog360WebhookConfiguration,
  submitDialog360Template,
} from "@/lib/messaging/whatsapp-dialog360";

const inbound = JSON.parse(readFileSync("tests/fixtures/messaging/dialog360-inbound.json", "utf8"));
const status = JSON.parse(readFileSync("tests/fixtures/messaging/dialog360-status.json", "utf8"));
const templateStatus = JSON.parse(readFileSync("tests/fixtures/messaging/dialog360-template-status.json", "utf8"));
const credentials = {
  apiKey: "dialog360-api-key-secret",
  webhookUsername: "clinicflow-abcd1234",
  webhookSecret: "webhook-secret",
};

function request(payload: unknown, authorization?: string) {
  return new Request("https://clinic.example/api/api/webhooks/whatsapp", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.DIALOG360_API_BASE_URL = "https://dialog360.test";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.DIALOG360_API_BASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("360dialog WhatsApp adapter", () => {
  it("sends through the current messages endpoint without leaking the credential", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.sent-1" }] }), { status: 200 }));
    const result = await dialog360WhatsAppProvider.send({
      channel: "whatsapp",
      recipient: "+96551111111",
      body: "Appointment tomorrow",
      senderIdentity: "109876543210",
      clientReference: "11111111-1111-4111-8111-111111111111",
    }, credentials);
    expect(result).toEqual({ ok: true, providerMessageId: "wamid.sent-1", costMicro: null });
    expect(fetch).toHaveBeenCalledWith("https://dialog360.test/messages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "D360-API-KEY": credentials.apiKey }),
    }));
    const [, sendInit] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(sendInit?.body))).toMatchObject({
      biz_opaque_callback_data: "11111111-1111-4111-8111-111111111111",
    });

    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 }));
    const failed = await dialog360WhatsAppProvider.send({ channel: "whatsapp", recipient: "+1", body: "x", senderIdentity: "1" }, credentials);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(credentials.apiKey);
  });

  it("classifies a definite HTTP rejection as unambiguous (Email fallback allowed)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid recipient" } }), { status: 400 }),
    );
    const result = await dialog360WhatsAppProvider.send(
      { channel: "whatsapp", recipient: "+1", body: "x", senderIdentity: "1" },
      credentials,
    );
    expect(result).toMatchObject({ ok: false });
    expect("ambiguous" in result && result.ambiguous).toBeFalsy();
  });

  it("classifies a fetch timeout as ambiguous so callers do not fall back (P3-M1)", async () => {
    vi.mocked(fetch).mockRejectedValue(
      Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
    );
    const result = await dialog360WhatsAppProvider.send(
      { channel: "whatsapp", recipient: "+96551111111", body: "x", senderIdentity: "1" },
      credentials,
    );
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  it("classifies a 2xx without a message id as ambiguous", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    const result = await dialog360WhatsAppProvider.send(
      { channel: "whatsapp", recipient: "+96551111111", body: "x", senderIdentity: "1" },
      credentials,
    );
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  it("dispatches approved template messages with ordered body parameters", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.template-1" }] }), { status: 200 }));
    await expect(dialog360WhatsAppProvider.send({
      channel: "whatsapp",
      recipient: "+96551111111",
      body: "Hello Mona",
      senderIdentity: "109876543210",
      template: {
        name: "follow_up",
        language: "en",
        parameters: ["Mona"],
      },
    }, credentials)).resolves.toMatchObject({ ok: true });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: "template",
      template: {
        name: "follow_up",
        language: { code: "en" },
        components: [{
          type: "body",
          parameters: [{ type: "text", text: "Mona" }],
        }],
      },
    });
  });

  it("authenticates configured Basic credentials and rejects missing or tampered requests", async () => {
    const valid = `Basic ${Buffer.from(`${credentials.webhookUsername}:${credentials.webhookSecret}`).toString("base64")}`;
    await expect(dialog360WhatsAppProvider.verifySignature(request(inbound, valid), credentials)).resolves.toBe(true);
    await expect(dialog360WhatsAppProvider.verifySignature(request(inbound, `${valid}x`), credentials)).resolves.toBe(false);
    await expect(dialog360WhatsAppProvider.verifySignature(request(inbound), credentials)).resolves.toBe(false);
  });

  it("parses recorded inbound, delivery, and template approval fixtures", async () => {
    expect(extractDialog360PhoneNumberId(inbound)).toBe("109876543210");
    await expect(dialog360WhatsAppProvider.parseWebhook(request(inbound))).resolves.toMatchObject([{
      kind: "inbound",
      phoneNumberId: "109876543210",
      sender: "96551111111",
      providerMessageId: "wamid.inbound-1",
      body: "Please confirm my appointment",
    }]);
    await expect(dialog360WhatsAppProvider.parseWebhook(request(status))).resolves.toMatchObject([{
      kind: "status", providerMessageId: "wamid.outbound-1", status: "delivered",
    }]);
    await expect(dialog360WhatsAppProvider.parseWebhook(request(templateStatus))).resolves.toMatchObject([{
      kind: "template_status", providerTemplateId: "template-provider-1", status: "approved",
    }]);
  });

  it("configures the provider callback with generated Basic auth", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    await expect(configureDialog360Webhook({
      apiKey: credentials.apiKey,
      url: "https://clinic.example/api/webhooks/whatsapp",
      username: credentials.webhookUsername,
      password: credentials.webhookSecret,
    })).resolves.toEqual({ ok: true });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://clinic.example/api/webhooks/whatsapp",
      headers: { Authorization: `Basic ${Buffer.from(`${credentials.webhookUsername}:${credentials.webhookSecret}`).toString("base64")}` },
    });
  });

  it("snapshots the current webhook configuration for connect compensation", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      url: "https://previous.example/webhook",
      headers: { Authorization: "Basic previous", Ignored: 42 },
    }), { status: 200 }));

    await expect(getDialog360WebhookConfiguration(credentials.apiKey)).resolves.toEqual({
      ok: true,
      configuration: {
        url: "https://previous.example/webhook",
        headers: { Authorization: "Basic previous" },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://dialog360.test/v1/configs/webhook",
      expect.objectContaining({
        method: "GET",
        headers: { "D360-API-KEY": credentials.apiKey },
      }),
    );
  });

  it("submits templates and normalizes provider approval state", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "template-provider-1", status: "PENDING" }), { status: 200 }));
    await expect(submitDialog360Template({
      name: "appointment_reminder",
      language: "en",
      body: "Your appointment is tomorrow.",
      category: "UTILITY",
    }, credentials)).resolves.toEqual({
      ok: true,
      providerTemplateId: "template-provider-1",
      status: "submitted",
    });
  });
});
