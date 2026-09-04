import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11N — a message after a closed thread begins a new conversation.
 *
 * `persist_whatsapp_inbound` already re-opens a closed thread, and that is not
 * changed here. What was missing is that the re-opened thread carried its whole
 * previous episode with it, so the assistant picked up an intake the patient had
 * finished days earlier. The webhook now observes the closed→open transition —
 * which is only observable *before* the RPC runs — and resets the assistant's
 * conversational state before the turn reaches the agent.
 */

const mocks = vi.hoisted(() => ({
  scopedClient: vi.fn(),
  finalize: vi.fn(),
  persistInbound: vi.fn(),
  persistLinkedDeviceInbound: vi.fn(),
  advanceStatus: vi.fn(),
  applyTemplateStatus: vi.fn(),
  upsertHistoryChat: vi.fn(),
  emitNotification: vi.fn(),
  patientAi: vi.fn(),
  reset: vi.fn(),
  order: [] as string[],
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.scopedClient,
  finalizeOutboundMessage: mocks.finalize,
  persistWhatsAppInbound: mocks.persistInbound,
  // Linked-device traffic persists through the account-scoped RPC instead; the
  // reopen behaviour under test is the same on either path.
  persistLinkedDeviceInbound: mocks.persistLinkedDeviceInbound,
  advanceOutboundMessageStatus: mocks.advanceStatus,
  applyMessageTemplateProviderStatus: mocks.applyTemplateStatus,
  upsertWhatsAppHistoryChat: mocks.upsertHistoryChat,
}));
vi.mock("@/lib/messaging/send", () => ({ buildBodyPreview: (body: string) => body.slice(0, 32) }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: mocks.emitNotification }));
vi.mock("@/lib/ai/patient-reply", () => ({ runPatientInboundAiReply: mocks.patientAi }));
vi.mock("@/lib/ai/conversation-reset", () => ({
  resetConversationAssistantState: mocks.reset,
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn(),
  refreshConnectionStateAfterTemplateChange: vi.fn(),
}));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

const CLINIC = "clinic-a";
const SESSION_PHONE = "+201111111111";
const PATIENT_PHONE = "+201000000000";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";

/**
 * The conversation row the webhook reads *before* the persist RPC — which is
 * the only moment the previous status is still visible.
 */
function clientWithStatus(status: string | null) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            table === "conversations"
              ? {
                  data: status === null
                    ? null
                    : { id: CONVERSATION, status, assigned_to: null },
                  error: null,
                }
              : { data: null, error: null },
          ),
        insert: () => chain,
        update: () => chain,
      });
      return chain;
    },
  };
}

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "inbound" as const,
    providerMessageId: "3EB0ABCDEF",
    phoneNumberId: SESSION_PHONE,
    sender: PATIENT_PHONE,
    body: "أهلا، عايز أحجز",
    receivedAt: "2026-08-29T09:00:00.000Z",
    ...overrides,
  };
}

async function process(events: ReturnType<typeof inboundEvent>[]) {
  return processMessagingWebhookEvents({
    provider: "linked_device",
    clinicId: CLINIC,
    senderIdentity: SESSION_PHONE,
    events,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  const persisted = {
    data: [{ inserted: true, conversation_id: CONVERSATION }],
    error: null,
  };
  mocks.persistInbound.mockResolvedValue(persisted);
  mocks.persistLinkedDeviceInbound.mockResolvedValue(persisted);
  mocks.emitNotification.mockResolvedValue(undefined);
  mocks.reset.mockImplementation(async () => {
    mocks.order.push("reset");
    return { ok: true, supersededSuggestions: 0 };
  });
  mocks.patientAi.mockImplementation(async () => {
    mocks.order.push("agent");
    return undefined;
  });
});

describe("P11N — a new message on a closed thread", () => {
  it("resets the assistant's conversational state before the agent sees the turn", async () => {
    mocks.scopedClient.mockReturnValue(clientWithStatus("closed"));

    const summary = await process([inboundEvent()]);

    expect(summary).toMatchObject({ inbound: 1 });
    expect(mocks.reset).toHaveBeenCalledWith({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      reason: "reopened",
      // P11O — the episode boundary for a thread closed before the boundary
      // column existed is this message's own arrival, so the message that
      // reopened the thread falls inside the episode it starts.
      boundaryAt: "2026-08-29T09:00:00.000Z",
    });
    // Order is the whole point: a clean state has to be in place before the
    // agent reads it, not after.
    expect(mocks.order).toEqual(["reset", "agent"]);
  });

  it("still hands the message to the assistant — the thread reopens, it does not vanish", async () => {
    mocks.scopedClient.mockReturnValue(clientWithStatus("closed"));
    await process([inboundEvent()]);
    expect(mocks.patientAi).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: CLINIC, conversationId: CONVERSATION }),
    );
    // The message itself is persisted exactly as before — now through the
    // account-scoped linked-device RPC, which stamps the authenticated account
    // on the row. Nothing in this path deletes a message or touches a patient
    // record.
    expect(mocks.persistLinkedDeviceInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: PATIENT_PHONE,
        historical: false,
        authenticatedAccountId: expect.any(String),
      }),
    );
  });

  it("does not reset an open thread mid-conversation", async () => {
    mocks.scopedClient.mockReturnValue(clientWithStatus("open"));
    await process([inboundEvent()]);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.patientAi).toHaveBeenCalledTimes(1);
  });

  it("does not reset a number that has never written before", async () => {
    mocks.scopedClient.mockReturnValue(clientWithStatus(null));
    await process([inboundEvent()]);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("does not reset on a history import", async () => {
    // An imported message is months old and already answered; it is not a
    // patient starting a new conversation.
    mocks.scopedClient.mockReturnValue(clientWithStatus("closed"));
    await process([inboundEvent({ historical: true })]);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.patientAi).not.toHaveBeenCalled();
  });
});
