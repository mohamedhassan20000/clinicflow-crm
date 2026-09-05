import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  checkUsageLimit: vi.fn(),
  incrementClinicUsage: vi.fn(),
  finalizeOutboundMessage: vi.fn(),
  emailSend: vi.fn(),
  whatsappSend: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  state: {
    channels: { data: [] as unknown[] | null, error: null as unknown },
    channelUpserts: [] as Array<{ payload: unknown; options: unknown }>,
    provisionResult: { data: null as unknown, error: null as unknown },
    inserts: [] as unknown[],
    insertResult: { data: { id: "out-1" }, error: null } as {
      data: { id: string } | null;
      error: unknown;
    },
    updates: [] as Array<{ payload: unknown; filters: unknown[] }>,
    updateResult: { error: null } as { error: unknown },
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}));

vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return {
    ...actual,
    getEntitlements: mocks.getEntitlements,
    checkUsageLimit: mocks.checkUsageLimit,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      if (table === "clinic_channels") {
        return {
          select: () => ({ eq: () => Promise.resolve(mocks.state.channels) }),
          upsert: (payload: unknown, options: unknown) => {
            mocks.state.channelUpserts.push({ payload, options });
            return {
              select: () => ({
                single: () => Promise.resolve(mocks.state.provisionResult),
              }),
            };
          },
        };
      }
      if (table === "outbound_messages") {
        return {
          insert: (payload: unknown) => {
            mocks.state.inserts.push(payload);
            return {
              select: () => ({
                single: () => Promise.resolve(mocks.state.insertResult),
              }),
            };
          },
          update: (payload: unknown) => {
            const filters: unknown[] = [];
            const chain = {
              eq: (...args: unknown[]) => {
                filters.push(args);
                return chain;
              },
              then: (resolve: (value: unknown) => unknown) => {
                mocks.state.updates.push({ payload, filters });
                return resolve(mocks.state.updateResult);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  }),
  incrementClinicUsage: mocks.incrementClinicUsage,
  finalizeOutboundMessage: mocks.finalizeOutboundMessage,
}));

vi.mock("@/lib/messaging/email-resend", () => ({
  resendEmailProvider: {
    id: "resend",
    channel: "email",
    send: mocks.emailSend,
    verifySignature: vi.fn(),
    parseWebhook: vi.fn(),
  },
}));

vi.mock("@/lib/email/resend", () => ({
  DEFAULT_FROM: "messaging@clinicflow.fit",
}));

vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  dialog360WhatsAppProvider: {
    id: "dialog360",
    channel: "whatsapp",
    send: mocks.whatsappSend,
    verifySignature: vi.fn(),
    parseWebhook: vi.fn(),
  },
}));

vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  metaWhatsAppProvider: {
    id: "meta",
    channel: "whatsapp",
    send: mocks.whatsappSend,
    verifySignature: vi.fn(),
    parseWebhook: vi.fn(),
  },
}));

vi.mock("@/lib/messaging/whatsapp-linked-device", () => ({
  linkedDeviceWhatsAppProvider: {
    id: "linked_device",
    channel: "whatsapp",
    send: mocks.whatsappSend,
    verifySignature: vi.fn(),
    parseWebhook: vi.fn(),
  },
}));

import { encryptChannelCredentials } from "@/lib/messaging/crypto";
import { buildBodyPreview, sendMessage } from "@/lib/messaging/send";

const CLINIC_ID = "0f7a2f6e-1111-4222-8333-444455556666";
const WHATSAPP_API_KEY = "whatsapp-api-key-super-secret";

function channelRow(
  channel: "whatsapp" | "email",
  overrides: Record<string, unknown> = {},
) {
  const provider = channel === "email" ? "resend" : "dialog360";
  return {
    id: `chan-${channel}`,
    clinic_id: CLINIC_ID,
    channel,
    provider,
    credentials_encrypted: null,
    sender_identity: channel === "email" ? "care@clinic.example" : "CLINIC",
    status: "active",
    connected_at: null,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
    ...overrides,
  };
}

function entitled(features: Record<string, boolean> = {}) {
  return {
    clinicId: CLINIC_ID,
    planSlug: "pro",
    features,
    limits: {},
    subscriptionAllowed: true,
  };
}

const allowedUsage = { allowed: true, reason: "allowed" };
const blockedUsage = { allowed: false, reason: "limit_reached" };

const baseInput = {
  clinicId: CLINIC_ID,
  recipient: "patient@example.com",
  body: "Reminder: appointment tomorrow at 10:00.",
  subject: "Appointment reminder",
  relatedType: "manual" as const,
};

beforeEach(() => {
  process.env.MESSAGING_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  mocks.state.channels = { data: [channelRow("email")], error: null };
  mocks.state.channelUpserts = [];
  mocks.state.provisionResult = { data: channelRow("email"), error: null };
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.state.updateResult = { error: null };
  mocks.state.insertResult = { data: { id: "out-1" }, error: null };
  mocks.getEntitlements.mockResolvedValue(entitled());
  mocks.checkUsageLimit.mockResolvedValue(allowedUsage);
  mocks.incrementClinicUsage.mockResolvedValue({ data: 1, error: null });
  mocks.finalizeOutboundMessage.mockResolvedValue({ data: true, error: null });
  mocks.emailSend.mockResolvedValue({
    ok: true,
    providerMessageId: "email-1",
    costMicro: null,
  });
  mocks.whatsappSend.mockResolvedValue({
    ok: true,
    providerMessageId: "wa-1",
    costMicro: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

describe("sendMessage", () => {
  it("rejects blank input without touching the database", async () => {
    await expect(
      sendMessage({ ...baseInput, body: "  " }),
    ).resolves.toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(mocks.state.inserts).toHaveLength(0);
  });

  it("sends via email, records the row lifecycle, and counts usage", async () => {
    const result = await sendMessage(baseInput);
    expect(result).toEqual({
      ok: true,
      outboundMessageId: "out-1",
      channel: "email",
      provider: "resend",
      providerMessageId: "email-1",
    });
    expect(mocks.state.inserts[0]).toMatchObject({
      clinic_id: CLINIC_ID,
      channel: "email",
      provider: "resend",
      status: "queued",
      related_type: "manual",
    });
    expect(mocks.finalizeOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      status: "sent",
      providerMessageId: "email-1",
    }));
    expect(mocks.incrementClinicUsage).toHaveBeenCalledWith(CLINIC_ID, "emails");
    expect(mocks.emailSend).toHaveBeenCalledWith(
      expect.objectContaining({ senderIdentity: "care@clinic.example" }),
      {},
    );
  });

  it("skips WhatsApp when the clinic is not entitled and degrades to email", async () => {
    mocks.state.channels = {
      data: [channelRow("whatsapp"), channelRow("email")],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: false }));
    const result = await sendMessage(baseInput);
    expect(result).toMatchObject({ ok: true, channel: "email" });
    expect(mocks.whatsappSend).not.toHaveBeenCalled();
  });

  it("selects the registered Meta adapter through the production send boundary", async () => {
    const encrypted = encryptChannelCredentials({
      accessToken: "meta-token",
      phoneNumberId: "meta-phone-id",
      wabaId: "meta-waba-id",
    });
    mocks.state.channels = {
      data: [
        channelRow("whatsapp", {
          provider: "meta",
          credentials_encrypted: encrypted,
          sender_identity: "meta-phone-id",
        }),
      ],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    const result = await sendMessage({
      ...baseInput,
      recipient: "+15551234567",
      relatedType: "appointment",
      channelPreference: ["whatsapp"],
    });
    expect(result).toMatchObject({ ok: true, channel: "whatsapp", provider: "meta" });
    expect(mocks.whatsappSend).toHaveBeenCalledWith(
      expect.objectContaining({ senderIdentity: "meta-phone-id" }),
      expect.objectContaining({
        accessToken: "meta-token",
        phoneNumberId: "meta-phone-id",
      }),
    );
  });

  it("skips WhatsApp over its usage cap and degrades to email", async () => {
    mocks.state.channels = {
      data: [channelRow("whatsapp"), channelRow("email")],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    mocks.checkUsageLimit.mockImplementation(async (_clinicId, metric) =>
      metric === "wa_messages" ? blockedUsage : allowedUsage,
    );
    const result = await sendMessage(baseInput);
    expect(result).toMatchObject({ ok: true, channel: "email" });
  });

  it("provisions and sends email without an existing WhatsApp or email row", async () => {
    mocks.state.channels = { data: [], error: null };
    const result = await sendMessage(baseInput);
    expect(result).toMatchObject({ ok: true, channel: "email", provider: "resend" });
    expect(mocks.state.channelUpserts).toEqual([
      {
        payload: expect.objectContaining({
          channel: "email",
          provider: "resend",
          sender_identity: "messaging@clinicflow.fit",
          status: "active",
        }),
        options: { onConflict: "clinic_id,channel,provider" },
      },
    ]);
  });

  it("reports the first blocking reason when every channel is unavailable", async () => {
    mocks.getEntitlements.mockResolvedValue(entitled());
    mocks.checkUsageLimit.mockResolvedValue(blockedUsage);
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "USAGE_LIMIT_REACHED",
    });
    expect(mocks.state.inserts).toHaveLength(0);
  });

  it("fails closed on inactive subscriptions and lookup errors", async () => {
    mocks.getEntitlements.mockResolvedValue({
      ...entitled(),
      subscriptionAllowed: false,
    });
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "SUBSCRIPTION_INACTIVE",
    });
    expect(mocks.state.channelUpserts).toHaveLength(0);

    mocks.getEntitlements.mockResolvedValue(entitled());
    mocks.state.channels = { data: null, error: { message: "boom" } };
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "CHANNEL_LOOKUP_FAILED",
    });

    mocks.state.channels = { data: [], error: null };
    await expect(sendMessage({ ...baseInput, channelPreference: ["whatsapp"] })).resolves.toEqual({
      ok: false,
      code: "NO_ACTIVE_CHANNEL",
    });
  });

  it("requires a subject when the resolved channel is email", async () => {
    await expect(
      sendMessage({ ...baseInput, subject: undefined }),
    ).resolves.toEqual({ ok: false, code: "EMAIL_SUBJECT_REQUIRED" });
    expect(mocks.state.inserts).toHaveLength(0);
  });

  it("decrypts WhatsApp credentials for the adapter without persisting them", async () => {
    mocks.state.channels = {
      data: [
        channelRow("whatsapp", {
          credentials_encrypted: encryptChannelCredentials({
            apiKey: WHATSAPP_API_KEY,
          }),
        }),
      ],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    const result = await sendMessage({
      ...baseInput,
      recipient: "+96550000000",
      subject: undefined,
      relatedType: "appointment",
      channelPreference: ["whatsapp"],
    });
    expect(result).toMatchObject({ ok: true, channel: "whatsapp", provider: "dialog360" });
    expect(mocks.whatsappSend).toHaveBeenCalledWith(expect.anything(), {
      apiKey: WHATSAPP_API_KEY,
    });
    const persisted = JSON.stringify({
      inserts: mocks.state.inserts,
      updates: mocks.state.updates,
    });
    expect(persisted).not.toContain(WHATSAPP_API_KEY);
    expect(mocks.incrementClinicUsage).toHaveBeenCalledWith(
      CLINIC_ID,
      "wa_messages",
    );
  });

  it("fails with CREDENTIALS_UNAVAILABLE on an undecryptable envelope", async () => {
    mocks.state.channels = {
      data: [channelRow("whatsapp", { credentials_encrypted: "\\x00" })],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    await expect(sendMessage({
      ...baseInput,
      recipient: "+96550000000",
      subject: undefined,
      relatedType: "appointment",
      channelPreference: ["whatsapp"],
    })).resolves.toEqual({
      ok: false,
      code: "CREDENTIALS_UNAVAILABLE",
    });
    expect(mocks.state.inserts).toHaveLength(0);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it("marks the row failed on provider failure and does not count usage", async () => {
    mocks.emailSend.mockResolvedValue({ ok: false, error: "mailbox unavailable" });
    const result = await sendMessage(baseInput);
    expect(result).toEqual({
      ok: false,
      code: "PROVIDER_SEND_FAILED",
      outboundMessageId: "out-1",
    });
    expect(mocks.finalizeOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "mailbox unavailable",
    }));
    expect(mocks.incrementClinicUsage).not.toHaveBeenCalled();
  });

  it("preserves the worker's safe media failure stage", async () => {
    mocks.state.channels = {
      data: [channelRow("whatsapp", { provider: "linked_device" })],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    mocks.whatsappSend.mockResolvedValue({
      ok: false,
      error: "Linked device send failed (400)",
      failureCode: "MEDIA_REQUEST_REJECTED",
    });

    await expect(sendMessage({
      ...baseInput,
      recipient: "+201000000000",
      subject: undefined,
      relatedType: "appointment",
      channelPreference: ["whatsapp"],
      media: {
        mediaId: "media-1",
        kind: "image",
        mimeType: "image/jpeg",
        bucket: "whatsapp-outbound",
        storagePath: `${CLINIC_ID}/2026-08/photo.jpg`,
        fileName: "photo.jpg",
        voiceNote: false,
      },
    })).resolves.toEqual({
      ok: false,
      code: "MEDIA_REQUEST_REJECTED",
      outboundMessageId: "out-1",
    });
  });

  it("leaves the row queued on an ambiguous provider outcome (P3-M1)", async () => {
    mocks.state.channels = {
      data: [
        channelRow("whatsapp", {
          credentials_encrypted: encryptChannelCredentials({ apiKey: WHATSAPP_API_KEY }),
        }),
      ],
      error: null,
    };
    mocks.getEntitlements.mockResolvedValue(entitled({ whatsapp: true }));
    mocks.whatsappSend.mockResolvedValue({
      ok: false,
      error: "timeout",
      ambiguous: true,
    });
    const result = await sendMessage({
      ...baseInput,
      recipient: "+96550000000",
      subject: undefined,
      relatedType: "appointment",
      channelPreference: ["whatsapp"],
    });
    expect(result).toEqual({
      ok: false,
      code: "PROVIDER_SEND_AMBIGUOUS",
      outboundMessageId: "out-1",
    });
    // The lifecycle is NOT finalized as failed — the row stays queued for the
    // delivery callback, and only the error note is written under a queued guard.
    expect(mocks.finalizeOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.incrementClinicUsage).not.toHaveBeenCalled();
    expect(mocks.state.updates).toHaveLength(1);
    expect(mocks.state.updates[0]).toMatchObject({ payload: { error: "timeout" } });
    expect(JSON.stringify(mocks.state.updates[0].filters)).toContain("queued");
  });

  it("sanitizes thrown adapter errors before persisting them", async () => {
    mocks.emailSend.mockRejectedValue(
      new Error("send blew up with Bearer secret-token-value"),
    );
    const result = await sendMessage(baseInput);
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_SEND_FAILED" });
    const persisted = JSON.stringify(mocks.finalizeOutboundMessage.mock.calls);
    expect(persisted).not.toContain("secret-token-value");
  });

  it("fails with RECORD_FAILED when the queued row cannot be written", async () => {
    mocks.state.insertResult = { data: null, error: { message: "denied" } };
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "RECORD_FAILED",
    });
    expect(mocks.emailSend).not.toHaveBeenCalled();
  });

  it("does not report success when provider acceptance cannot be persisted after retries", async () => {
    mocks.finalizeOutboundMessage.mockResolvedValue({
      data: false,
      error: { message: "database unavailable" },
    });

    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "RECORD_FAILED",
      outboundMessageId: "out-1",
    });
    expect(mocks.finalizeOutboundMessage).toHaveBeenCalledTimes(3);
    expect(mocks.incrementClinicUsage).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalled();
  });
});

describe("buildBodyPreview", () => {
  it("masks digit runs and truncates under the column bound", () => {
    const preview = buildBodyPreview(
      `Call 96550001111 about file 20260717 — ${"long text ".repeat(30)}`,
    );
    expect(preview).not.toContain("96550001111");
    expect(preview).not.toContain("20260717");
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("keeps short bodies intact apart from digit masking", () => {
    expect(buildBodyPreview("See you at 10:00")).toBe("See you at 10:00");
  });
});
