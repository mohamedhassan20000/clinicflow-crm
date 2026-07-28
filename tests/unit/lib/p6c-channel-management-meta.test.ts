import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOwner: vi.fn(),
  existing: null as Record<string, unknown> | null,
  selectExisting: vi.fn(),
  insertClaim: vi.fn(),
  updateChannel: vi.fn(),
  exchange: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  configureDialog360Webhook: vi.fn(),
  getDialog360WebhookConfiguration: vi.fn(),
  setDialog360WebhookConfiguration: vi.fn(),
}));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  exchangeMetaSignupCode: mocks.exchange,
  provisionMetaEmbeddedSignup: mocks.provision,
}));
vi.mock("@/lib/supabase/admin", () => ({
  activateWhatsAppProvider: vi.fn(),
  findClinicChannelIdentityOwner: mocks.findOwner,
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      if (table !== "clinic_channels") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: mocks.selectExisting,
          };
          return chain;
        },
        insert: mocks.insertClaim,
        update: mocks.updateChannel,
      };
    },
  }),
}));

import { connectMetaChannel } from "@/lib/messaging/channel-management";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";

const input = {
  clinicId: "11111111-1111-4111-8111-111111111111",
  code: "embedded-signup-code",
  phoneNumberId: "551234567890",
  wabaId: "998877665544",
};

beforeEach(() => {
  process.env.MESSAGING_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  mocks.existing = null;
  mocks.findOwner.mockResolvedValue({ data: null, error: null });
  mocks.selectExisting.mockImplementation(() =>
    Promise.resolve({ data: mocks.existing, error: null }),
  );
  mocks.insertClaim.mockImplementation(() => ({
    select: () => ({
      maybeSingle: () => Promise.resolve({ data: { id: "meta-channel" }, error: null }),
    }),
  }));
  mocks.exchange.mockResolvedValue({ ok: true, accessToken: "oauth-user-token" });
  mocks.provision.mockResolvedValue({
    ok: true,
    channel: {
      accessToken: "system-user-token",
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayPhoneNumber: "+1 555 123 4567",
    },
  });
  mocks.updateChannel.mockImplementation(() => {
    const chain = {
      eq: () => chain,
      select: () => ({
        maybeSingle: () =>
          Promise.resolve({ data: { id: "meta-channel" }, error: null }),
      }),
    };
    return chain;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

describe("P6C Meta channel connection boundary", () => {
  it("claims tenant identity before provider mutation and stores only provider-verified assets", async () => {
    await expect(connectMetaChannel(input)).resolves.toEqual({
      ok: true,
      channelId: "meta-channel",
    });
    expect(mocks.findOwner).toHaveBeenCalledWith("meta", input.phoneNumberId);
    expect(mocks.insertClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        clinic_id: input.clinicId,
        provider: "meta",
        provider_account_id: input.wabaId,
        sender_identity: input.phoneNumberId,
        status: "pending",
      }),
    );
    expect(mocks.insertClaim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.provision.mock.invocationCallOrder[0],
    );
    const stored = mocks.updateChannel.mock.calls[0][0];
    expect(stored).toMatchObject({
      status: "pending",
      webhook_subscribed: true,
    });
    expect(decryptChannelCredentials(stored.credentials_encrypted)).toEqual({
      accessToken: "system-user-token",
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayPhoneNumber: "+1 555 123 4567",
    });
  });

  it("rejects an identity owned by another clinic across provider boundaries", async () => {
    mocks.findOwner.mockResolvedValue({
      data: { id: "dialog-channel-b", clinic_id: "clinic-b" },
      error: null,
    });
    await expect(connectMetaChannel(input)).resolves.toEqual({
      ok: false,
      code: "IDENTITY_TAKEN",
    });
    expect(mocks.insertClaim).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("keeps a resumable pending claim and never stores credentials when provisioning fails", async () => {
    mocks.provision.mockResolvedValue({ ok: false, error: "subscription failed" });
    await expect(connectMetaChannel(input)).resolves.toEqual({
      ok: false,
      code: "PROVIDER",
    });
    expect(mocks.insertClaim).toHaveBeenCalledOnce();
    expect(mocks.updateChannel).not.toHaveBeenCalled();
  });
});
