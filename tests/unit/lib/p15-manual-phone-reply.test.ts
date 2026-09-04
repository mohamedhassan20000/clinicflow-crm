import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P15 §5 — a reply typed on the clinic's own handset is a person answering.
 *
 * The Inbox has to be able to say "Active conversation" about a thread a
 * colleague is answering from their phone, exactly as it does for one answered
 * from ClinicFlow. That means the echo path has to record two things it did
 * not record before:
 *
 *   1. **provenance** — whether this outbound row is live or was replayed by
 *      the history import. Without it, the first history sync would relabel
 *      every imported thread as actively handled, which is the opposite of
 *      true; and
 *   2. **the assistant standing down** — a live human reply disarms the idle
 *      close so the assistant does not talk over the colleague mid-sentence.
 *
 * Everything the echo path already refused to do it must still refuse: no
 * conversation is created, no cross-account ownership is possible, the patient
 * agent is never invoked, and a message ClinicFlow itself sent collapses onto
 * the same provider-message-id row rather than being duplicated.
 */

const mocks = vi.hoisted(() => ({
  scopedClient: vi.fn(),
  finalize: vi.fn(),
  markHumanReply: vi.fn(),
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
  markConversationHumanReply: mocks.markHumanReply,
  persistWhatsAppInbound: mocks.persistInbound,
  advanceOutboundMessageStatus: mocks.advanceStatus,
  applyMessageTemplateProviderStatus: mocks.applyTemplateStatus,
  upsertLinkedDeviceHistoryChat: vi.fn(async () => ({
    data: [{ conversation_id: "conv-1" }],
    error: null,
  })),
  persistLinkedDeviceInbound: mocks.persistInbound,
}));
vi.mock("@/lib/messaging/send", () => ({ buildBodyPreview: mocks.buildBodyPreview }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: mocks.emitNotification }));
vi.mock("@/lib/ai/patient-reply", () => ({ runPatientInboundAiReply: mocks.patientAi }));
vi.mock("@/lib/ai/conversation-reset", () => ({ resetConversationAssistantState: vi.fn() }));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn(),
  refreshConnectionStateAfterTemplateChange: vi.fn(),
}));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

type Insert = { payload: Record<string, unknown> };

function fakeClient(options: {
  conversation: { data: unknown; error: unknown };
  insert: { data: unknown; error: unknown };
  inserts: Insert[];
  /** The linked-device session row the boundary reader asks for. */
  session?: { data: unknown; error: unknown };
}) {
  return {
    from(table: string) {
      if (table === "conversations" || table === "whatsapp_linked_device_sessions") {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(
              table === "conversations"
                ? options.conversation
                : options.session ?? { data: null, error: null },
            ),
        });
        return chain;
      }
      return {
        insert: (payload: Record<string, unknown>) => {
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
  // Deliberately in the past: `echoTimestamp` clamps a future stamp to now,
  // because a phone with a skewed clock must not pin a thread to the top of
  // the Inbox forever.
  occurredAt: "2026-08-08T10:00:00.000Z",
};

function runEcho(
  overrides: Partial<typeof echo> & { historical?: true } = {},
  clientOptions: Partial<Parameters<typeof fakeClient>[0]> = {},
) {
  const inserts: Insert[] = [];
  mocks.scopedClient.mockReturnValue(
    fakeClient({
      conversation: { data: { id: "conv-1" }, error: null },
      insert: { data: { id: "out-1" }, error: null },
      inserts,
      ...clientOptions,
    }),
  );
  return {
    inserts,
    summary: processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [{ ...echo, ...overrides }],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finalize.mockResolvedValue({ data: true, error: null });
  mocks.markHumanReply.mockResolvedValue({ data: true, error: null });
});

describe("P15 §5 — a live reply from the linked handset", () => {
  it("is recorded as live and stands the assistant down", async () => {
    const run = runEcho();
    const summary = await run.summary;

    expect(summary.echoes).toBe(1);
    expect(run.inserts[0]!.payload).toMatchObject({
      ingestion_origin: "live",
      related_type: "manual",
      related_id: "conv-1",
    });
    // Live only, and scoped to the conversation the lookup proved belongs to
    // this authenticated account.
    expect(mocks.markHumanReply).toHaveBeenCalledWith({
      clinicId: "clinic-a",
      conversationId: "conv-1",
      occurredAt: "2026-08-08T10:00:00.000Z",
    });
  });

  it("never invokes the patient assistant", async () => {
    await runEcho().summary;
    // An echo is something *we* said. Handing it to the assistant as though the
    // patient had written would have the assistant answering the clinic.
    expect(mocks.patientAi).not.toHaveBeenCalled();
  });

  it("never opens a conversation of its own", async () => {
    const run = runEcho({}, { conversation: { data: null, error: null } });
    const summary = await run.summary;

    expect(summary.echoes).toBe(0);
    expect(run.inserts).toHaveLength(0);
    expect(mocks.markHumanReply).not.toHaveBeenCalled();
  });

  it("treats a duplicate provider message id as a replay, not a second reply", async () => {
    // The unique (provider, provider_message_id) index is what collapses the
    // echo of a message ClinicFlow itself sent, and a callback delivered twice.
    const run = runEcho({}, { insert: { data: null, error: { code: "23505" } } });
    const summary = await run.summary;

    expect(summary.echoes).toBe(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.markHumanReply).not.toHaveBeenCalled();
  });
});

describe("P15 §5 — a historical outbound replay is not a human reply", () => {
  it("is recorded as history and stands nobody down", async () => {
    const run = runEcho(
      { historical: true, occurredAt: "2025-04-02T10:00:00.000Z" },
      {
        // The boundary reader has to find a session that predates the message,
        // or the import is refused before it reaches the echo path at all.
        session: {
          data: {
            authenticated_account_id: "+201111111111",
            inbound_active_from: "2025-01-01T00:00:00.000Z",
            created_at: "2025-01-01T00:00:00.000Z",
          },
          error: null,
        },
      },
    );
    await run.summary;

    expect(run.inserts[0]!.payload).toMatchObject({ ingestion_origin: "history_sync" });
    // The whole point: importing a year of the clinic's sent messages must not
    // walk a year of threads into "Active conversation".
    expect(mocks.markHumanReply).not.toHaveBeenCalled();
    expect(mocks.patientAi).not.toHaveBeenCalled();
  });
});

describe("P15 §5 — account isolation is unchanged", () => {
  it("refuses an echo from a transport that cannot observe a phone", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: { id: "out-1" }, error: null },
        inserts: [],
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
    expect(mocks.markHumanReply).not.toHaveBeenCalled();
  });

  it("refuses an echo with no authenticated account to bind it to", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        conversation: { data: { id: "conv-1" }, error: null },
        insert: { data: { id: "out-1" }, error: null },
        inserts: [],
      }),
    );
    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: "clinic-a",
      events: [echo],
    });
    expect(summary.echoes).toBe(0);
    expect(summary.ignored).toBe(1);
  });
});
