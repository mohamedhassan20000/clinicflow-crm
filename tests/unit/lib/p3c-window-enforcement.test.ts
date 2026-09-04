import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  checkUsageLimit: vi.fn(),
  incrementClinicUsage: vi.fn(),
  finalizeOutboundMessage: vi.fn(),
  whatsappSend: vi.fn(),
  linkedDeviceSend: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  state: {
    conversation: {
      data: {
        id: "conversation-1",
        channel: "whatsapp",
        status: "open",
        window_expires_at: "2026-07-17T09:59:00.000Z",
      },
      error: null,
    } as { data: Record<string, unknown> | null; error: unknown },
    template: {
      data: null,
      error: null,
    } as { data: Record<string, unknown> | null; error: unknown },
    inserts: [] as Record<string, unknown>[],
    updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    provider: "dialog360" as "dialog360" | "linked_device",
    authenticatedAccount: null as string | null,
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));

vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  getEntitlements: mocks.getEntitlements,
  checkUsageLimit: mocks.checkUsageLimit,
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

vi.mock("@/lib/messaging/whatsapp-linked-device", () => ({
  linkedDeviceWhatsAppProvider: {
    id: "linked_device",
    channel: "whatsapp",
    send: mocks.linkedDeviceSend,
    verifySignature: vi.fn(),
    parseWebhook: vi.fn(),
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  incrementClinicUsage: mocks.incrementClinicUsage,
  finalizeOutboundMessage: mocks.finalizeOutboundMessage,
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      if (table === "clinic_channels") {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [{
                id: "channel-1",
                clinic_id: "clinic-1",
                channel: "whatsapp",
                provider: mocks.state.provider,
                credentials_encrypted: null,
                sender_identity: "phone-id-1",
                status: "active",
                connected_at: null,
                created_at: "2026-07-17T00:00:00.000Z",
                updated_at: "2026-07-17T00:00:00.000Z",
              }],
              error: null,
            }),
          }),
        };
      }
      if (table === "conversations" || table === "message_templates") {
        const result = table === "conversations" ? mocks.state.conversation : mocks.state.template;
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(result) }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: () => {
              mocks.state.updates.push({ table, payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "outbound_messages") {
        return {
          insert: (payload: Record<string, unknown>) => {
            mocks.state.inserts.push(payload);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: "out-1" }, error: null }) }) };
          },
          update: (payload: Record<string, unknown>) => ({
            eq: () => {
              mocks.state.updates.push({ table, payload });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "whatsapp_linked_device_sessions") {
        // The send path proves the conversation belongs to the account that is
        // authenticated right now, so this row is part of every linked-device
        // reply.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: { authenticated_account_id: mocks.state.authenticatedAccount },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

import { sendMessage } from "@/lib/messaging/send";

const baseInput = {
  clinicId: "clinic-1",
  recipient: "+96551111111",
  body: "Hello",
  relatedType: "manual" as const,
  conversationId: "conversation-1",
  channelPreference: ["whatsapp" as const],
};

/**
 * Puts the clinic on a linked device whose authenticated account owns the
 * conversation under test. All three have to agree — channel sender identity,
 * session account and conversation account — or the send is refused, which is
 * the whole point of account isolation on the outbound path too.
 */
function linkedDeviceAccount(accountId = "phone-id-1") {
  mocks.state.provider = "linked_device";
  mocks.state.authenticatedAccount = accountId;
  mocks.state.conversation.data = {
    ...mocks.state.conversation.data,
    whatsapp_account_id: accountId,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
  mocks.state.conversation = {
    data: {
      id: "conversation-1",
      channel: "whatsapp",
      status: "open",
      window_expires_at: "2026-07-17T09:59:00.000Z",
      // Cloud API traffic is not linked-device traffic and carries no account.
      whatsapp_account_id: null,
    },
    error: null,
  };
  mocks.state.template = { data: null, error: null };
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.state.provider = "dialog360";
  mocks.state.authenticatedAccount = null;
  mocks.getEntitlements.mockResolvedValue({
    clinicId: "clinic-1",
    planSlug: "pro",
    features: { whatsapp: true },
    limits: {},
    subscriptionAllowed: true,
  });
  mocks.checkUsageLimit.mockResolvedValue({ allowed: true, reason: "allowed" });
  mocks.incrementClinicUsage.mockResolvedValue({ data: 1, error: null });
  mocks.finalizeOutboundMessage.mockResolvedValue({ data: true, error: null });
  mocks.whatsappSend.mockResolvedValue({
    ok: true,
    providerMessageId: "wamid.out-1",
    costMicro: null,
  });
  mocks.linkedDeviceSend.mockResolvedValue({
    ok: true,
    providerMessageId: "linked.out-1",
    costMicro: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("P3C WhatsApp service-window enforcement", () => {
  it("blocks a freeform reply at 24 hours plus one minute before recording or dispatching", async () => {
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "SERVICE_WINDOW_CLOSED",
    });
    expect(mocks.state.inserts).toHaveLength(0);
    expect(mocks.whatsappSend).not.toHaveBeenCalled();
  });

  it("allows freeform replies while the service window remains open", async () => {
    mocks.state.conversation.data = {
      ...mocks.state.conversation.data,
      window_expires_at: "2026-07-17T10:01:00.000Z",
    };
    await expect(sendMessage(baseInput)).resolves.toMatchObject({ ok: true, channel: "whatsapp" });
    expect(mocks.whatsappSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello", template: undefined }),
      {},
    );
  });

  it("allows a linked-device freeform reply with no service window", async () => {
    linkedDeviceAccount();
    mocks.state.conversation.data = {
      ...mocks.state.conversation.data,
      window_expires_at: null,
    };
    await expect(sendMessage(baseInput)).resolves.toMatchObject({
      ok: true,
      provider: "linked_device",
    });
    expect(mocks.linkedDeviceSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello", template: undefined }),
      {},
    );
  });

  it("uses an unreviewed linked-device template as reusable text outside the window", async () => {
    linkedDeviceAccount();
    mocks.state.template = {
      data: {
        id: "template-1",
        clinic_id: "clinic-1",
        channel: "whatsapp",
        name: "follow_up",
        language: "en",
        body: "Hello {{1}}",
        variables: ["name"],
        provider_template_id: null,
        approval_status: "draft",
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      error: null,
    };

    await expect(sendMessage({
      ...baseInput,
      body: "",
      templateId: "template-1",
      templateParameters: ["Mona"],
    })).resolves.toMatchObject({ ok: true, provider: "linked_device" });
    expect(mocks.linkedDeviceSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello Mona" }),
      {},
    );
  });

  it("allows an approved template outside the window and records the rendered preview", async () => {
    mocks.state.template = {
      data: {
        id: "template-1",
        clinic_id: "clinic-1",
        channel: "whatsapp",
        name: "follow_up",
        language: "en",
        body: "Hello {{1}}, please call {{phone}}.",
        variables: ["name", "phone"],
        provider_template_id: "provider-template-1",
        approval_status: "approved",
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      error: null,
    };
    const result = await sendMessage({
      ...baseInput,
      body: "",
      templateId: "template-1",
      templateParameters: ["Mona", "+96550000000"],
    });
    expect(result).toMatchObject({ ok: true });
    expect(mocks.state.inserts[0]).toMatchObject({
      template_id: "template-1",
      related_id: "conversation-1",
    });
    expect(mocks.whatsappSend).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Hello Mona, please call +96550000000.",
        template: {
          name: "follow_up",
          language: "en",
          parameters: ["Mona", "+96550000000"],
        },
      }),
      {},
    );
  });

  it("rejects closed threads even when their time window is open", async () => {
    mocks.state.conversation.data = {
      ...mocks.state.conversation.data,
      status: "closed",
      window_expires_at: "2026-07-17T10:01:00.000Z",
    };
    await expect(sendMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "CONVERSATION_CLOSED",
    });
  });
});
