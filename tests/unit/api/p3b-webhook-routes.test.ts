import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  extractPhoneNumberId: vi.fn(),
  extractTemplateId: vi.fn(),
  findChannel: vi.fn(),
  findTemplate: vi.fn(),
  decrypt: vi.fn(),
  verifyWhatsApp: vi.fn(),
  parseWhatsApp: vi.fn(),
  verifyResend: vi.fn(),
  parseResend: vi.fn(),
  process: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/messaging/webhook-http", () => ({
  enforceWebhookRateLimit: mocks.rateLimit,
  unauthorizedWebhookResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  unavailableWebhookResponse: () => Response.json(
    { error: "Webhook temporarily unavailable" },
    { status: 503 },
  ),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: mocks.decrypt }));
vi.mock("@/lib/messaging/webhooks", () => ({ processMessagingWebhookEvents: mocks.process }));
vi.mock("@/lib/supabase/admin", () => ({
  findClinicChannelForWebhook: mocks.findChannel,
  findMessageTemplateForWebhook: mocks.findTemplate,
  createClinicScopedAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { clinic_id: "clinic-a", credentials_encrypted: "ciphertext" }, error: null }) }) }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  extractDialog360PhoneNumberId: mocks.extractPhoneNumberId,
  extractDialog360TemplateId: mocks.extractTemplateId,
  dialog360WhatsAppProvider: { verifySignature: mocks.verifyWhatsApp, parseWebhook: mocks.parseWhatsApp },
}));
vi.mock("@/lib/messaging/email-resend", () => ({
  resendEmailProvider: { verifySignature: mocks.verifyResend, parseWebhook: mocks.parseResend },
}));

import { POST as whatsappPost } from "@/app/api/webhooks/whatsapp/route";
import { POST as resendPost } from "@/app/api/webhooks/resend/route";

const body = JSON.stringify({ event: "fixture" });
const request = (path: string) => new Request(`https://clinic.example${path}`, { method: "POST", body });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(null);
  mocks.extractPhoneNumberId.mockReturnValue("109876543210");
  mocks.extractTemplateId.mockReturnValue(null);
  mocks.findChannel.mockResolvedValue({ data: { clinic_id: "clinic-a", credentials_encrypted: "ciphertext" }, error: null });
  mocks.findTemplate.mockResolvedValue({ data: { clinic_id: "clinic-a", id: "template-1" }, error: null });
  mocks.decrypt.mockReturnValue({ webhookUsername: "user", webhookSecret: "secret" });
  mocks.verifyWhatsApp.mockResolvedValue(false);
  mocks.verifyResend.mockResolvedValue(false);
  mocks.process.mockResolvedValue({ inbound: 1, statuses: 0, templates: 0, replays: 0, ignored: 0 });
});

describe("P3B webhook route boundaries", () => {
  it("rejects unsigned WhatsApp and Resend callbacks with 401", async () => {
    await expect(whatsappPost(request("/api/webhooks/whatsapp"))).resolves.toMatchObject({ status: 401 });
    await expect(resendPost(request("/api/webhooks/resend"))).resolves.toMatchObject({ status: 401 });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("routes each signed WhatsApp fixture to the clinic owning its phone_number_id", async () => {
    mocks.verifyWhatsApp.mockResolvedValue(true);
    mocks.parseWhatsApp.mockResolvedValue([{ kind: "inbound", phoneNumberId: "109876543210", sender: "96551111111", providerMessageId: "wamid.in-1", body: "hello", receivedAt: null }]);

    for (const [phoneNumberId, clinicId] of [["109876543210", "clinic-a"], ["209876543210", "clinic-b"]] as const) {
      mocks.extractPhoneNumberId.mockReturnValueOnce(phoneNumberId);
      mocks.findChannel.mockResolvedValueOnce({ data: { clinic_id: clinicId, credentials_encrypted: "ciphertext" }, error: null });
      const response = await whatsappPost(request("/api/webhooks/whatsapp"));
      expect(response.status).toBe(200);
      expect(mocks.findChannel).toHaveBeenCalledWith("dialog360", phoneNumberId);
      expect(mocks.process).toHaveBeenCalledWith(expect.objectContaining({ clinicId }));
    }
  });

  it("returns the rate-limit response before parsing or tenant lookup", async () => {
    mocks.rateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const response = await whatsappPost(request("/api/webhooks/whatsapp"));
    expect(response.status).toBe(429);
    expect(mocks.findChannel).not.toHaveBeenCalled();
  });

  it("routes template callbacks without phone metadata through the provider template id", async () => {
    mocks.extractPhoneNumberId.mockReturnValue(null);
    mocks.extractTemplateId.mockReturnValue("template-provider-1");
    mocks.verifyWhatsApp.mockResolvedValue(true);
    mocks.parseWhatsApp.mockResolvedValue([{ kind: "template_status", providerTemplateId: "template-provider-1", name: "reminder", language: "en", status: "approved" }]);
    const response = await whatsappPost(request("/api/webhooks/whatsapp"));
    expect(response.status).toBe(200);
    expect(mocks.findTemplate).toHaveBeenCalledWith("template-provider-1");
    expect(mocks.process).toHaveBeenCalledWith(expect.objectContaining({ clinicId: "clinic-a" }));
  });

  it("normalizes malformed and unknown pre-auth routing failures to the same response", async () => {
    mocks.extractPhoneNumberId.mockReturnValue(null);
    mocks.extractTemplateId.mockReturnValue(null);
    const missingRouting = await whatsappPost(request("/api/webhooks/whatsapp"));

    mocks.extractTemplateId.mockReturnValue("unknown-template");
    mocks.findTemplate.mockResolvedValue({ data: null, error: null });
    const unknownTemplate = await whatsappPost(request("/api/webhooks/whatsapp"));

    mocks.extractPhoneNumberId.mockReturnValue("unknown-channel");
    mocks.findChannel.mockResolvedValue({ data: null, error: null });
    const unknownChannel = await whatsappPost(request("/api/webhooks/whatsapp"));

    for (const response of [missingRouting, unknownTemplate, unknownChannel]) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    }
    expect(mocks.verifyWhatsApp).not.toHaveBeenCalled();
  });
});
