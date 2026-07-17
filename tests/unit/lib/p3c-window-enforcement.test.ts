import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  checkUsageLimit: vi.fn(),
  incrementClinicUsage: vi.fn(),
  finalizeOutboundMessage: vi.fn(),
  whatsappSend: vi.fn(),
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
                provider: "dialog360",
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
  mocks.state.conversation = {
    data: {
      id: "conversation-1",
      channel: "whatsapp",
      status: "open",
      window_expires_at: "2026-07-17T09:59:00.000Z",
    },
    error: null,
  };
  mocks.state.template = { data: null, error: null };
  mocks.state.inserts = [];
  mocks.state.updates = [];
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
