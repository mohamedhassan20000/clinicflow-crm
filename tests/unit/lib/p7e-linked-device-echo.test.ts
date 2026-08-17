import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7E — mirroring the messages a clinic sends from their own phone.
 *
 * A linked device sees the clinic's whole conversation, including what was typed
 * on the handset. Reflecting that into the inbox is what makes the thread read
 * as one conversation — but it must not invent conversations, must not duplicate
 * what ClinicFlow itself sent, and must never be reachable from a transport that
 * cannot observe a phone.
 */

const mocks = vi.hoisted(() => ({
  scopedClient: vi.fn(),
  finalize: vi.fn(),
  persistInbound: vi.fn(),
  advanceStatus: vi.fn(),
  applyTemplateStatus: vi.fn(),
  emitNotification: vi.fn(),
  patientAi: vi.fn(),
  buildBodyPreview: vi.fn((body: string) => body.slice(0, 32)),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.scopedClient,
  finalizeOutboundMessage: mocks.finalize,
  persistWhatsAppInbound: mocks.persistInbound,
  advanceOutboundMessageStatus: mocks.advanceStatus,
  applyMessageTemplateProviderStatus: mocks.applyTemplateStatus,
}));
vi.mock("@/lib/messaging/send", () => ({ buildBodyPreview: mocks.buildBodyPreview }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: mocks.emitNotification }));
vi.mock("@/lib/ai/patient-reply", () => ({ runPatientInboundAiReply: mocks.patientAi }));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn(),
  refreshConnectionStateAfterTemplateChange: vi.fn(),
}));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

type Insert = { payload: unknown };

/** Answers the conversation lookup and records the outbound insert. */
function fakeClient(options: {
  conversation: { data: unknown; error: unknown };
  insert: { data: unknown; error: unknown };
  inserts: Insert[];
}) {
  return {
    from(table: string) {
      if (table === "conversations") {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve(options.conversation),
        });
        return chain;
      }
      return {
        insert: (payload: unknown) => {
          options.inserts.push({ payload });
          return {
            select: () => ({ maybeSingle: () => Promise.resolve(options.insert) }),
          };
        },
      };
    },
  };
}

const echo = {
  kind: "outbound_echo" as const,
  recipient: "+201000000000",
  providerMessageId: "WA-PHONE-1",
  body: "See you tomorrow",
  occurredAt: "2026-08-17T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finalize.mockResolvedValue({ data: true, error: null });
});

describe("phone-sent message mirroring", () => {
  it("records the message against the existing conversation and marks it sent", async () => {
    const inserts: Insert[] = [];
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: { id: "out-1" }, error: null },
        inserts,
      }),
    );

    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [echo],
    });

    expect(summary.echoes).toBe(1);
    expect(inserts[0]?.payload).toMatchObject({
      clinic_id: "clinic-a",
      channel: "whatsapp",
      provider: "linked_device",
      provider_message_id: "WA-PHONE-1",
      related_id: "conv-1",
      status: "queued",
    });
    // Finalized through the same RPC every other outbound message uses, so
    // conversation activity is updated exactly once.
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: "clinic-a",
        outboundMessageId: "out-1",
        status: "sent",
        providerMessageId: "WA-PHONE-1",
        costMicro: null,
      }),
    );
  });

  it("does not open a conversation for a patient who never wrote in", async () => {
    const inserts: Insert[] = [];
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: null, error: null },
        insert: { data: null, error: null },
        inserts,
      }),
    );

    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [echo],
    });

    expect(summary.echoes).toBe(0);
    expect(summary.ignored).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("treats a message it already knows as a replay rather than a duplicate", async () => {
    // This is the echo of a message ClinicFlow itself just sent: the unique
    // (provider, provider_message_id) index refuses the second row.
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: null, error: { code: "23505", message: "duplicate key" } },
        inserts: [],
      }),
    );

    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [echo],
    });

    expect(summary.echoes).toBe(0);
    expect(summary.ignored).toBe(1);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("surfaces a genuine write failure instead of silently dropping the message", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: null, error: { code: "08006", message: "connection failure" } },
        inserts: [],
      }),
    );

    await expect(
      processMessagingWebhookEvents({
        provider: "linked_device",
        clinicId: "clinic-a",
        senderIdentity: "+201111111111",
        events: [echo],
      }),
    ).rejects.toThrow("OUTBOUND_ECHO_INSERT_FAILED");
  });

  it("is unreachable from a transport that cannot observe a phone", async () => {
    const inserts: Insert[] = [];
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: { id: "out-1" }, error: null },
        inserts,
      }),
    );

    const summary = await processMessagingWebhookEvents({
      provider: "meta",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [echo],
    });

    expect(summary.echoes).toBe(0);
    expect(summary.ignored).toBe(1);
    expect(inserts).toHaveLength(0);
  });
});
