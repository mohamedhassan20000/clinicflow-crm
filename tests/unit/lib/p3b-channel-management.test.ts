import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getWebhook: vi.fn(),
  setWebhook: vi.fn(),
  findOwner: vi.fn(),
  upsert: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: mocks.captureMessage }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  configureDialog360Webhook: mocks.configure,
  getDialog360WebhookConfiguration: mocks.getWebhook,
  setDialog360WebhookConfiguration: mocks.setWebhook,
}));
vi.mock("@/lib/supabase/admin", () => ({
  findClinicChannelIdentityOwner: mocks.findOwner,
  createClinicScopedAdminClient: () => ({
    from: () => ({ upsert: mocks.upsert }),
  }),
}));

import { connectDialog360Channel } from "@/lib/messaging/channel-management";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";

const clinicId = "0f7a2f6e-1111-4222-8333-444455556666";
const input = {
  clinicId,
  apiKey: "dialog360-api-key-secret",
  phoneNumberId: "109876543210",
  displayPhoneNumber: "+96550000001",
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://clinic.example";
  process.env.MESSAGING_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  mocks.findOwner.mockResolvedValue({ data: null, error: null });
  mocks.getWebhook.mockResolvedValue({
    ok: true,
    configuration: {
      url: "https://previous.example/webhook",
      headers: { Authorization: "Basic previous" },
    },
  });
  mocks.configure.mockResolvedValue({ ok: true });
  mocks.setWebhook.mockResolvedValue({ ok: true });
  mocks.upsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

describe("360dialog channel connection", () => {
  it("configures a generated callback secret and stores only its encrypted envelope", async () => {
    await expect(connectDialog360Channel(input)).resolves.toEqual({ ok: true });
    expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: input.apiKey,
      url: "https://clinic.example/api/webhooks/whatsapp",
      username: expect.stringMatching(/^clinicflow-/),
      password: expect.any(String),
    }));
    const row = mocks.upsert.mock.calls[0][0];
    expect(row).toMatchObject({ clinic_id: clinicId, sender_identity: input.phoneNumberId, status: "active" });
    expect(row.credentials_encrypted).not.toContain(input.apiKey);
    expect(decryptChannelCredentials(row.credentials_encrypted)).toMatchObject({
      apiKey: input.apiKey,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber,
    });
  });

  it("fails before changing the provider when encryption is not configured", async () => {
    delete process.env.MESSAGING_CREDENTIALS_KEY;
    await expect(connectDialog360Channel(input)).resolves.toEqual({ ok: false, code: "CONFIGURATION" });
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.getWebhook).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a phone-number identity already owned by another clinic", async () => {
    mocks.findOwner.mockResolvedValue({ data: { id: "channel-b", clinic_id: "clinic-b" }, error: null });
    await expect(connectDialog360Channel(input)).resolves.toEqual({ ok: false, code: "DATABASE" });
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("fails before provider mutation when the prior webhook cannot be snapshotted", async () => {
    mocks.getWebhook.mockResolvedValue({ ok: false, error: "unavailable" });

    await expect(connectDialog360Channel(input)).resolves.toEqual({
      ok: false,
      code: "PROVIDER",
    });
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("restores the prior provider webhook when database persistence fails", async () => {
    mocks.upsert.mockResolvedValue({ error: { code: "23505" } });

    await expect(connectDialog360Channel(input)).resolves.toEqual({
      ok: false,
      code: "DATABASE",
    });
    expect(mocks.setWebhook).toHaveBeenCalledWith({
      apiKey: input.apiKey,
      configuration: {
        url: "https://previous.example/webhook",
        headers: { Authorization: "Basic previous" },
      },
    });
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it("reports a failed compensation without exposing connection secrets", async () => {
    mocks.upsert.mockResolvedValue({ error: { code: "DATABASE_UNAVAILABLE" } });
    mocks.setWebhook.mockResolvedValue({ ok: false, error: "provider unavailable" });

    await expect(connectDialog360Channel(input)).resolves.toEqual({
      ok: false,
      code: "DATABASE",
    });
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      "360dialog webhook compensation failed",
      expect.objectContaining({ level: "error" }),
    );
    expect(JSON.stringify(mocks.captureMessage.mock.calls)).not.toContain(input.apiKey);
  });
});
