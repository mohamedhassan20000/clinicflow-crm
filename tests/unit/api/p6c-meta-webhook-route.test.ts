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
  decrypt: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/messaging/webhook-http", () => ({
  enforceWebhookRateLimit: mocks.rateLimit,
  unauthorizedWebhookResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  unavailableWebhookResponse: () =>
    Response.json({ error: "Webhook temporarily unavailable" }, { status: 503 }),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: mocks.decrypt }));
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
    // P7D: the channel lookup now runs *before* the signature check, because a
    // clinic-owned (manual API) channel is signed with that clinic's own app
    // secret and the route must read the channel to know which secret applies.
    // The invariant that matters is unchanged: an unverified request never
    // reaches processing, and nothing is recorded for the clinic.
    expect(mocks.recordVerified).not.toHaveBeenCalled();
    expect(mocks.recordRejection).toHaveBeenCalledWith("meta", "signature");
  });

  it("verifies a clinic-owned channel against that clinic's own stored app secret", async () => {
    mocks.findChannel.mockResolvedValue({
      data: {
        clinic_id: "clinic-a",
        sender_identity: "551234567890",
        credentials_encrypted: "\\xenvelope",
      },
      error: null,
    });
    mocks.decrypt.mockReturnValue({
      accessToken: "clinic-token",
      appId: "clinic-app-id",
      appSecret: "clinic-app-secret",
    });

    const response = await whatsappPost(metaRequest());

    expect(response.status).toBe(200);
    // The platform secret is not what authenticated this request: the routed
    // channel's own credentials were handed to the verifier.
    expect(mocks.verifyMeta).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appSecret: "clinic-app-secret" }),
    );
  });

  it("falls back to the platform app secret for a platform-brokered channel", async () => {
    // Embedded Signup / Coexistence channels store no app secret of their own.
    const response = await whatsappPost(metaRequest());

    expect(response.status).toBe(200);
    expect(mocks.verifyMeta).toHaveBeenCalledWith(expect.anything(), {});
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

  it("answers a clinic-scoped handshake with that clinic's own derived token only", async () => {
    // P7D: a clinic connecting its own Meta app registers `?clinic=<id>` and the
    // token ClinicFlow derived for it. The platform token must not open that
    // door, and neither must another clinic's token.
    process.env.MESSAGING_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.META_WEBHOOK_VERIFY_TOKEN = "platform-token";
    const { deriveWebhookVerifyToken } = await import(
      "@/lib/messaging/webhook-verify-token"
    );
    const clinicA = deriveWebhookVerifyToken("clinic-a")!;
    const clinicB = deriveWebhookVerifyToken("clinic-b")!;

    const handshake = (clinic: string, token: string) =>
      whatsappGet(
        new Request(
          `https://clinic.example/api/webhooks/whatsapp?clinic=${clinic}&hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=echo-7`,
        ),
      );

    const ok = handshake("clinic-a", clinicA);
    expect(ok.status).toBe(200);
    await expect(ok.text()).resolves.toBe("echo-7");

    expect(handshake("clinic-a", clinicB).status).toBe(403);
    expect(handshake("clinic-a", "platform-token").status).toBe(403);

    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  });
});
