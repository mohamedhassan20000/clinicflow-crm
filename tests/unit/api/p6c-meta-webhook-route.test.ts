import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  extractMetaPhone: vi.fn(),
  extractMetaWaba: vi.fn(),
  extractMetaTemplate: vi.fn(),
  verifyMeta: vi.fn(),
  parseMeta: vi.fn(),
  findChannel: vi.fn(),
  findByWaba: vi.fn(),
  findTemplateBinding: vi.fn(),
  process: vi.fn(),
  recordVerified: vi.fn(),
  recordRejection: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/messaging/webhook-http", () => ({
  enforceWebhookRateLimit: mocks.rateLimit,
  unauthorizedWebhookResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  unavailableWebhookResponse: () =>
    Response.json({ error: "Webhook temporarily unavailable" }, { status: 503 }),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: vi.fn() }));
vi.mock("@/lib/messaging/webhooks", () => ({ processMessagingWebhookEvents: mocks.process }));
vi.mock("@/lib/messaging/health", () => ({
  recordVerifiedWhatsAppWebhook: mocks.recordVerified,
}));
vi.mock("@/lib/messaging/webhook-telemetry", () => ({
  recordWebhookRouteRejection: mocks.recordRejection,
}));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  extractDialog360PhoneNumberId: vi.fn(),
  extractDialog360TemplateId: vi.fn(),
  dialog360WhatsAppProvider: { verifySignature: vi.fn(), parseWebhook: vi.fn() },
}));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  extractMetaPhoneNumberId: mocks.extractMetaPhone,
  extractMetaWabaId: mocks.extractMetaWaba,
  extractMetaTemplateId: mocks.extractMetaTemplate,
  metaWhatsAppProvider: { verifySignature: mocks.verifyMeta, parseWebhook: mocks.parseMeta },
}));
vi.mock("@/lib/supabase/admin", () => ({
  findClinicChannelForWebhook: mocks.findChannel,
  findClinicChannelByProviderAccount: mocks.findByWaba,
  findMessageTemplateBindingForWebhook: mocks.findTemplateBinding,
  findMessageTemplateForWebhook: vi.fn(),
  createClinicScopedAdminClient: vi.fn(),
}));

import { GET as whatsappGet, POST as whatsappPost } from "@/app/api/webhooks/whatsapp/route";

const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
function metaRequest() {
  return new Request("https://clinic.example/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": "sha256=deadbeef", "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(null);
  mocks.extractMetaPhone.mockReturnValue("551234567890");
  mocks.extractMetaWaba.mockReturnValue("waba-1");
  mocks.extractMetaTemplate.mockReturnValue(null);
  mocks.verifyMeta.mockResolvedValue(true);
  mocks.parseMeta.mockResolvedValue([
    { kind: "channel_state", phoneNumberId: "551234567890", wabaId: "waba-1", signals: { phoneStatus: "CONNECTED" } },
  ]);
  mocks.findChannel.mockResolvedValue({
    data: { clinic_id: "clinic-a", sender_identity: "551234567890" },
    error: null,
  });
  mocks.findByWaba.mockResolvedValue({
    data: { clinic_id: "clinic-a", sender_identity: "551234567890" },
    error: null,
  });
  mocks.findTemplateBinding.mockResolvedValue({ data: null, error: null });
  mocks.process.mockResolvedValue({ inbound: 0, statuses: 0, templates: 0, states: 1, replays: 0, ignored: 0 });
  mocks.recordVerified.mockResolvedValue(undefined);
  mocks.recordRejection.mockResolvedValue(undefined);
});

describe("P6C Meta webhook route", () => {
  it("rejects an invalidly-signed Meta callback with 401 before any processing", async () => {
    mocks.verifyMeta.mockResolvedValue(false);
    const response = await whatsappPost(metaRequest());
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.findChannel).not.toHaveBeenCalled();
  });

  it("verifies the signature, routes by phone_number_id, and processes as the meta provider", async () => {
    const response = await whatsappPost(metaRequest());
    expect(response.status).toBe(200);
    expect(mocks.verifyMeta).toHaveBeenCalled();
    expect(mocks.findChannel).toHaveBeenCalledWith("meta", "551234567890");
    expect(mocks.process).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meta", clinicId: "clinic-a", senderIdentity: "551234567890" }),
    );
  });

  it("routes a phone-less WABA account-review event to pending/error-capable channel lookup", async () => {
    mocks.extractMetaPhone.mockReturnValue(null);
    const response = await whatsappPost(metaRequest());
    expect(response.status).toBe(200);
    expect(mocks.findByWaba).toHaveBeenCalledWith("meta", "waba-1");
    expect(mocks.process).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "meta",
        clinicId: "clinic-a",
        senderIdentity: "551234567890",
      }),
    );
  });

  it("routes a phone-less template callback by provider binding", async () => {
    mocks.extractMetaPhone.mockReturnValue(null);
    mocks.extractMetaWaba.mockReturnValue(null);
    mocks.extractMetaTemplate.mockReturnValue("template-meta-1");
    mocks.findTemplateBinding.mockResolvedValue({
      data: { clinic_id: "clinic-a" },
      error: null,
    });
    const response = await whatsappPost(metaRequest());
    expect(response.status).toBe(200);
    expect(mocks.findTemplateBinding).toHaveBeenCalledWith("meta", "template-meta-1");
    expect(mocks.process).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meta", clinicId: "clinic-a" }),
    );
  });

  it("rate-limits before verifying or routing", async () => {
    mocks.rateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const response = await whatsappPost(metaRequest());
    expect(response.status).toBe(429);
    expect(mocks.verifyMeta).not.toHaveBeenCalled();
  });

  it("answers the Meta GET subscription handshake only on an exact verify-token match", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-token-123";
    const ok = whatsappGet(
      new Request(
        "https://clinic.example/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-123&hub.challenge=echo-42",
      ),
    );
    expect(ok.status).toBe(200);
    await expect(ok.text()).resolves.toBe("echo-42");

    const bad = whatsappGet(
      new Request(
        "https://clinic.example/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=echo-42",
      ),
    );
    expect(bad.status).toBe(403);
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  });
});
