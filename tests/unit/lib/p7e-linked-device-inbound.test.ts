import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7E — a paired device's inbound traffic, from the worker's callback body to the
 * inbox.
 *
 * The worker-side half of this (which WhatsApp JIDs count as a patient chat, and
 * how a LID-addressed chat is resolved to a phone number) lives in the worker's
 * own suite. What is asserted here is the seam after it: a signed callback's
 * events are parsed against the *stored* sender identity, an inbound event opens
 * or updates one inbox conversation, a redelivery of the same message is a replay
 * rather than a second row, and a message the clinic sent from their own phone
 * never enters the inbound path at all.
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
  // P15 (§5): a live echo also disarms the assistant's idle close. Stubbed
  // rather than asserted here — this suite is about what the echo persists.
  markConversationHumanReply: async () => ({ data: true, error: null }),
  persistWhatsAppInbound: mocks.persistInbound,
  persistLinkedDeviceInbound: mocks.persistInbound,
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
import {
  parseLinkedDeviceCallback,
  scopedLinkedDeviceMessageId,
} from "@/lib/messaging/whatsapp-linked-device";

const CLINIC = "clinic-a";
const SESSION_PHONE = "+201111111111";
const PATIENT_PHONE = "+20100000000";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";

/** The exact bytes the worker's CallbackClient posts. */
function callbackBody(events: unknown[]): string {
  return JSON.stringify({ clinicId: CLINIC, sessionPhone: SESSION_PHONE, events });
}

/** Answers the conversation lookup the echo path makes, and records inserts. */
function fakeClient(options: {
  conversation?: { data: unknown; error: unknown };
  inserts: Array<{ table: string; payload: unknown }>;
  upserts?: Array<{ table: string; payload: unknown }>;
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            table === "conversations"
              ? options.conversation ?? { data: { id: CONVERSATION }, error: null }
              : { data: { id: "outbound-1" }, error: null },
          ),
        insert: (payload: unknown) => {
          options.inserts.push({ table, payload });
          return chain;
        },
        upsert: (payload: unknown) => {
          options.upserts?.push({ table, payload });
          return {
            select: () => Promise.resolve({ data: [{ id: "attachment-1" }], error: null }),
          };
        },
      });
      return chain;
    },
  };
}

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "inbound",
    providerMessageId: "3EB0ABCDEF",
    sender: PATIENT_PHONE,
    body: "is the clinic open today?",
    receivedAt: "2026-08-17T09:00:00.000Z",
    ...overrides,
  };
}

async function process(events: unknown[]) {
  return processMessagingWebhookEvents({
    provider: "linked_device",
    clinicId: CLINIC,
    senderIdentity: SESSION_PHONE,
    // Parsed exactly as the route parses it: the sender identity comes from the
    // stored channel, never from the payload.
    events: parseLinkedDeviceCallback(callbackBody(events), SESSION_PHONE),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persistInbound.mockResolvedValue({
    data: [{
      inserted: true,
      conversation_id: CONVERSATION,
      inbound_message_id: "inbound-live-1",
    }],
    error: null,
  });
  mocks.finalize.mockResolvedValue({ data: true, error: null });
  mocks.emitNotification.mockResolvedValue(undefined);
  mocks.patientAi.mockResolvedValue(undefined);
  mocks.scopedClient.mockReturnValue(fakeClient({ inserts: [] }));
});

describe("a paired device's inbound message", () => {
  it("creates or updates the inbox conversation and notifies staff", async () => {
    const summary = await process([inboundEvent()]);

    expect(summary).toMatchObject({ inbound: 1, replays: 0, ignored: 0 });
    // One conversation, keyed by the patient's number — the RPC is what creates
    // it on first contact and appends to it afterwards.
    expect(mocks.persistInbound).toHaveBeenCalledWith({
      clinicId: CLINIC,
      authenticatedAccountId: SESSION_PHONE,
      sender: PATIENT_PHONE,
      body: "is the clinic open today?",
      providerMessageId: scopedLinkedDeviceMessageId(SESSION_PHONE, "3EB0ABCDEF"),
      receivedAt: "2026-08-17T09:00:00.000Z",
      // P8: a live message carries no WhatsApp name here and is not historical,
      // so it opens a service window and reaches the agent as it always did.
      displayName: null,
      historical: false,
    });
    expect(mocks.emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC,
        type: "inbox_message",
        link: `/inbox?conversation=${CONVERSATION}`,
      }),
    );
    expect(mocks.patientAi).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: CLINIC, conversationId: CONVERSATION }),
    );
    expect(mocks.patientAi).toHaveBeenCalledTimes(1);
  });

  it("appends a second message to the same conversation", async () => {
    await process([inboundEvent(), inboundEvent({ providerMessageId: "3EB0SECOND", body: "hello?" })]);
    expect(mocks.persistInbound).toHaveBeenCalledTimes(2);
    expect(mocks.persistInbound.mock.calls.map(([input]) => input.sender)).toEqual([
      PATIENT_PHONE,
      PATIENT_PHONE,
    ]);
  });

  it("counts a redelivered message as a replay rather than a duplicate row", async () => {
    // The worker retries a callback it never got a 2xx for; the provider message
    // id is what makes that safe.
    mocks.persistInbound.mockResolvedValue({
      data: [{ inserted: false, conversation_id: CONVERSATION }],
      error: null,
    });
    const summary = await process([inboundEvent()]);
    expect(summary).toMatchObject({ inbound: 0, replays: 1 });
    expect(mocks.emitNotification).not.toHaveBeenCalled();
    expect(mocks.patientAi).not.toHaveBeenCalled();
  });

  it("persists history sync without notifying staff or invoking the AI", async () => {
    const summary = await process([inboundEvent({ historical: true })]);

    expect(summary).toMatchObject({ inbound: 1, replays: 0 });
    expect(mocks.persistInbound).toHaveBeenCalledWith(
      expect.objectContaining({ historical: true }),
    );
    expect(mocks.emitNotification).not.toHaveBeenCalled();
    expect(mocks.patientAi).not.toHaveBeenCalled();
  });

  it("accepts a bare number and stores it in E.164", async () => {
    // Belt and braces: the worker already sends `+<digits>`, but the inbox key
    // must not depend on that.
    await process([inboundEvent({ sender: "20100000000" })]);
    expect(mocks.persistInbound).toHaveBeenCalledWith(
      expect.objectContaining({ sender: PATIENT_PHONE }),
    );
  });

  it("is refused when it claims an identity the stored channel does not hold", async () => {
    const summary = await processMessagingWebhookEvents({
      provider: "linked_device",
      clinicId: CLINIC,
      senderIdentity: SESSION_PHONE,
      // A callback parsed against one pairing cannot be processed as another's.
      events: parseLinkedDeviceCallback(callbackBody([inboundEvent()]), "+209999999999"),
    });
    expect(summary).toMatchObject({ inbound: 0, ignored: 1 });
    expect(mocks.persistInbound).not.toHaveBeenCalled();
  });

  it("persists inbound PTT metadata as audio on the attachment row", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upserts: Array<{ table: string; payload: unknown }> = [];
    mocks.persistInbound.mockResolvedValue({
      data: [{ inserted: true, conversation_id: CONVERSATION, inbound_message_id: "message-voice" }],
      error: null,
    });
    mocks.scopedClient.mockReturnValue(fakeClient({ inserts: [], upserts }));

    const summary = await process([inboundEvent({
      body: "[voice message]",
      attachments: [{
        mediaKind: "audio",
        voiceNote: true,
        durationSeconds: 8,
        mimeType: "audio/ogg; codecs=opus",
        originalFilename: null,
        byteSize: 4096,
        sha256: "a".repeat(64),
        storagePath: `${CLINIC}/2026-08/voice.ogg`,
        status: "stored",
        failureReason: null,
      }],
    })]);

    expect(summary.attachments).toBe(1);
    expect(upserts).toEqual([
      {
        table: "inbound_message_attachments",
        payload: [expect.objectContaining({
          media_kind: "audio",
          voice_note: true,
          duration_seconds: 8,
          mime_type: "audio/ogg; codecs=opus",
          status: "stored",
        })],
      },
    ]);
    const persistenceDiagnostics = info.mock.calls
      .filter(([label]) => label === "inbound_media")
      .map(([, diagnostic]) => diagnostic);
    expect(persistenceDiagnostics).toEqual([
      {
        stage: "attachment_persist_started",
        clinicId: CLINIC,
        mediaKind: "audio",
        voiceNote: true,
        mimeFamily: "audio",
        byteCount: 4096,
        durationPresent: true,
      },
      {
        stage: "attachment_persist_completed",
        clinicId: CLINIC,
        mediaKind: "audio",
        voiceNote: true,
        mimeFamily: "audio",
        byteCount: 4096,
        durationPresent: true,
      },
    ]);
    expect(JSON.stringify(persistenceDiagnostics)).not.toContain("voice.ogg");
    info.mockRestore();
  });
});

describe("the clinic's own messages", () => {
  it("are mirrored as outbound, never as a message from the patient", async () => {
    const inserts: Array<{ table: string; payload: unknown }> = [];
    mocks.scopedClient.mockReturnValue(fakeClient({ inserts }));

    const summary = await process([
      {
        kind: "outbound_echo",
        providerMessageId: "3EB0REPLY",
        recipient: PATIENT_PHONE,
        body: "we open at 10",
        occurredAt: "2026-08-17T09:01:00.000Z",
      },
    ]);

    expect(summary).toMatchObject({ echoes: 1, inbound: 0, replays: 0 });
    // The decisive assertion: nothing about an echo touches the inbound path, so
    // the clinic's own reply cannot surface in the thread as a patient message or
    // raise a "new patient message" notification.
    expect(mocks.persistInbound).not.toHaveBeenCalled();
    expect(mocks.emitNotification).not.toHaveBeenCalled();
    expect(mocks.patientAi).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: "outbound_messages",
      payload: {
        recipient: PATIENT_PHONE,
        provider: "linked_device",
        provider_message_id: scopedLinkedDeviceMessageId(SESSION_PHONE, "3EB0REPLY"),
      },
    });
  });

  it("do not duplicate a message ClinicFlow itself sent through the session", async () => {
    // ClinicFlow's own send already wrote the row under this provider message id;
    // the echo of it collapses on the unique index instead of appearing twice.
    const inserts: Array<{ table: string; payload: unknown }> = [];
    mocks.scopedClient.mockReturnValue({
      from(table: string) {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(
              table === "conversations"
                ? { data: { id: CONVERSATION }, error: null }
                : { data: null, error: { code: "23505", message: "duplicate key" } },
            ),
          insert: (payload: unknown) => {
            inserts.push({ table, payload });
            return chain;
          },
        });
        return chain;
      },
    });

    const summary = await process([
      {
        kind: "outbound_echo",
        providerMessageId: "3EB0ALREADYSENT",
        recipient: PATIENT_PHONE,
        body: "your appointment is confirmed",
        occurredAt: "2026-08-17T09:02:00.000Z",
      },
    ]);

    expect(summary).toMatchObject({ echoes: 0, ignored: 1, inbound: 0 });
    expect(mocks.persistInbound).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
