import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistInbound: vi.fn(),
  patientAi: vi.fn(),
  notify: vi.fn(),
  currentAccount: vi.fn(),
}));

type Row = Record<string, unknown>;
const store: { conversation: Row | null; inbound: Row[] } = {
  conversation: null,
  inbound: [],
};

function sharedClinicStore() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.is = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.maybeSingle = () => Promise.resolve({
        data: table === "conversations" ? store.conversation : null,
        error: null,
      });
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve({
        data: table === "inbound_messages" ? store.inbound : [],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => sharedClinicStore(),
  persistLinkedDeviceInbound: mocks.persistInbound,
  persistWhatsAppInbound: mocks.persistInbound,
  finalizeOutboundMessage: vi.fn(),
  advanceOutboundMessageStatus: vi.fn(),
  applyMessageTemplateProviderStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  getCurrentLinkedWhatsAppAccount: mocks.currentAccount,
}));
vi.mock("@/lib/messaging/send", () => ({ buildBodyPreview: (body: string) => body }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: mocks.notify }));
vi.mock("@/lib/ai/patient-reply", () => ({ runPatientInboundAiReply: mocks.patientAi }));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn(),
  refreshConnectionStateAfterTemplateChange: vi.fn(),
}));

import { loadAccountScopedInboxThread } from "@/lib/messaging/inbox-thread";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import { parseLinkedDeviceCallback } from "@/lib/messaging/whatsapp-linked-device";

const CLINIC_ID = "clinic-1";
const ACCOUNT = "+201111111111";
const CONVERSATION_ID = "conversation-1";
const INBOUND_ID = "inbound-live-1";

beforeEach(() => {
  vi.clearAllMocks();
  store.conversation = null;
  store.inbound = [];
  mocks.currentAccount.mockResolvedValue(ACCOUNT);
  mocks.notify.mockResolvedValue(undefined);
  mocks.patientAi.mockResolvedValue({ status: "auto_sent" });
  mocks.persistInbound.mockImplementation(async (input: Row) => {
    store.conversation = {
      id: CONVERSATION_ID,
      clinic_id: CLINIC_ID,
      channel: "whatsapp",
      whatsapp_account_id: ACCOUNT,
    };
    store.inbound = [{
      id: INBOUND_ID,
      conversation_id: CONVERSATION_ID,
      body: input.body,
      sender: input.sender,
      received_at: input.receivedAt,
    }];
    return {
      data: [{
        inserted: true,
        conversation_id: CONVERSATION_ID,
        inbound_message_id: INBOUND_ID,
      }],
      error: null,
    };
  });
});

describe("the real linked-device first-message seam", () => {
  it("creates the account-scoped conversation and returns that same persisted inbound in the thread", async () => {
    const events = parseLinkedDeviceCallback(JSON.stringify({
      clinicId: CLINIC_ID,
      sessionPhone: ACCOUNT,
      events: [{
        kind: "inbound",
        providerMessageId: "3EB0FIRST",
        sender: "+201000000000",
        body: "first live message",
        receivedAt: "2026-09-02T15:44:42.000Z",
      }],
    }), ACCOUNT);

    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: CLINIC_ID,
      senderIdentity: ACCOUNT,
      events,
    });
    const thread = await loadAccountScopedInboxThread({
      clinicId: CLINIC_ID,
      conversationId: CONVERSATION_ID,
      provider: "linked_device",
      pageSize: 50,
    });

    expect(summary).toMatchObject({ inbound: 1, replays: 0 });
    expect(store.conversation?.whatsapp_account_id).toBe(ACCOUNT);
    expect(thread.error).toBeNull();
    expect(thread.inboundResult?.data).toEqual(store.inbound);
    expect(thread.inboundResult?.data?.[0]).toMatchObject({
      id: INBOUND_ID,
      conversation_id: CONVERSATION_ID,
      body: "first live message",
    });
    expect(mocks.patientAi).toHaveBeenCalledTimes(1);
  });
});
