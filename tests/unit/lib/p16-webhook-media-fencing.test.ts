import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P16 — the two invariants a media pass must not quietly break.
 *
 * Adding media to the Inbox touches the ingest path, and the ingest path is
 * where two rules that cost real money and real trust live:
 *
 *   * **replayed and imported media never wakes the assistant.** An import is a
 *     year of somebody's chat history; handing it to the patient agent would
 *     answer messages that were answered months ago, from the clinic's own
 *     number, at the clinic's own cost.
 *   * **the echo of a message ClinicFlow sent is not a second message.** A
 *     linked device reports the clinic's own sends back to us, media included;
 *     the row already exists and the unique provider-message-id index is what
 *     says so.
 */

const persistWhatsAppInbound = vi.fn();
const persistLinkedDeviceInbound = vi.fn();
const runPatientInboundAiReply = vi.fn();
const emitClinicNotification = vi.fn();
const finalizeOutboundMessage = vi.fn();
const markConversationHumanReply = vi.fn();

type Insert = { table: string; payload: Record<string, unknown> };

const state: {
  inserts: Insert[];
  /** Provider message ids already recorded, i.e. what the unique index knows. */
  known: Set<string>;
  conversation: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
} = {
  inserts: [],
  known: new Set(),
  conversation: null,
  session: null,
};

const DUPLICATE_KEY = { code: "23505", message: "duplicate key value" };

function scopedClient() {
  const from = (table: string) => {
    const ctx: { table: string; op: string; payload: Record<string, unknown> | null } = {
      table,
      op: "select",
      payload: null,
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.is = chain;
    builder.in = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.update = (payload: Record<string, unknown>) => {
      ctx.op = "update";
      ctx.payload = payload;
      return builder;
    };
    builder.insert = (payload: Record<string, unknown>) => {
      ctx.op = "insert";
      ctx.payload = payload;
      return builder;
    };
    builder.upsert = (payload: Record<string, unknown>) => {
      ctx.op = "insert";
      ctx.payload = payload;
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(resolve(ctx));
    builder.single = () => Promise.resolve(resolve(ctx));
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(ctx)).then(onF, onR);
    return builder;
  };
  return { from };
}

function resolve(ctx: {
  table: string;
  op: string;
  payload: Record<string, unknown> | null;
}) {
  if (ctx.op === "insert" && ctx.payload) {
    const providerMessageId = ctx.payload.provider_message_id;
    if (typeof providerMessageId === "string" && state.known.has(providerMessageId)) {
      return { data: null, error: DUPLICATE_KEY };
    }
    if (typeof providerMessageId === "string") state.known.add(providerMessageId);
    state.inserts.push({ table: ctx.table, payload: ctx.payload });
    return { data: { id: `${ctx.table}-row` }, error: null };
  }
  if (ctx.table === "conversations") return { data: state.conversation, error: null };
  if (ctx.table === "whatsapp_linked_device_sessions") {
    return { data: state.session, error: null };
  }
  return { data: null, error: null };
}

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => scopedClient(),
  persistWhatsAppInbound: (...a: unknown[]) => persistWhatsAppInbound(...a),
  persistLinkedDeviceInbound: (...a: unknown[]) => persistLinkedDeviceInbound(...a),
  finalizeOutboundMessage: (...a: unknown[]) => finalizeOutboundMessage(...a),
  markConversationHumanReply: (...a: unknown[]) => markConversationHumanReply(...a),
  advanceOutboundMessageStatus: vi.fn(),
  applyMessageTemplateProviderStatus: vi.fn(),
  upsertLinkedDeviceHistoryChat: vi.fn(),
}));
vi.mock("@/lib/ai/patient-reply", () => ({
  runPatientInboundAiReply: (...a: unknown[]) => runPatientInboundAiReply(...a),
}));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: (...a: unknown[]) => emitClinicNotification(...a),
}));
vi.mock("@/lib/ai/conversation-reset", () => ({
  resetConversationAssistantState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn(),
  refreshConnectionStateAfterTemplateChange: vi.fn(),
}));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

const CLINIC = "clinic-1";
const ACCOUNT = "+96555941330";
const PATIENT = "+905384316956";

function inboundImage(overrides: Record<string, unknown> = {}) {
  return {
    kind: "inbound" as const,
    phoneNumberId: ACCOUNT,
    sender: PATIENT,
    providerMessageId: "ld_account_3A5D66178E7DECB5A4BF",
    body: "[image]",
    receivedAt: "2026-09-03T01:32:15.000Z",
    displayName: "Mohamed Hassan",
    historical: false,
    attachments: [
      {
        mediaKind: "image" as const,
        mimeType: "image/jpeg",
        byteSize: 295_703,
        sha256: "32d2df04adbf85849760ac42ffea3c86f200898ece57f53a3fbad9797f54a690",
        storagePath: `${CLINIC}/2026-09/photo.jpg`,
        status: "stored" as const,
        failureReason: null,
        originalFilename: null,
      },
    ],
    ...overrides,
  };
}

function process(events: readonly unknown[]) {
  return processMessagingWebhookEvents({
    provider: "linked_device",
    clinicId: CLINIC,
    senderIdentity: ACCOUNT,
    events: events as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inserts = [];
  state.known = new Set();
  state.conversation = { id: "conversation-1", assigned_to: null, status: "open" };
  state.session = {
    authenticated_account_id: ACCOUNT,
    inbound_active_from: "2026-09-02T14:37:54.767Z",
    created_at: "2026-09-02T14:37:54.767Z",
  };
  persistLinkedDeviceInbound.mockResolvedValue({
    data: [{
      conversation_id: "conversation-1",
      inbound_message_id: "inbound-1",
      inserted: true,
    }],
    error: null,
  });
  persistWhatsAppInbound.mockResolvedValue({
    data: [{
      conversation_id: "conversation-1",
      inbound_message_id: "inbound-1",
      inserted: true,
    }],
    error: null,
  });
  runPatientInboundAiReply.mockResolvedValue({ status: "auto_sent" });
  emitClinicNotification.mockResolvedValue(undefined);
  finalizeOutboundMessage.mockResolvedValue({ data: true, error: null });
  markConversationHumanReply.mockResolvedValue({ data: null, error: null });
});

describe("P16 — replayed and imported media never wakes the assistant", () => {
  it("hands a live inbound image to the assistant exactly once", async () => {
    const summary = await process([inboundImage()]);
    expect(summary.inbound).toBe(1);
    expect(runPatientInboundAiReply).toHaveBeenCalledTimes(1);
  });

  it("runs nothing for a replayed delivery of the same image", async () => {
    persistLinkedDeviceInbound.mockResolvedValue({
      data: [{
        conversation_id: "conversation-1",
        inbound_message_id: "inbound-1",
        inserted: false,
      }],
      error: null,
    });
    const summary = await process([inboundImage()]);
    expect(summary.replays).toBe(1);
    expect(runPatientInboundAiReply).not.toHaveBeenCalled();
  });

  it("runs nothing for an imported historical image", async () => {
    await process([inboundImage({ historical: true, providerMessageId: "ld_account_HIST" })]);
    expect(runPatientInboundAiReply).not.toHaveBeenCalled();
    // And it does not page staff about a message from months ago either.
    expect(emitClinicNotification).not.toHaveBeenCalled();
  });
});

describe("P16 — an outbound media echo is not a second message", () => {
  it("records the clinic's own send once and ignores its echo", async () => {
    // ClinicFlow sent the PDF; the row already carries the provider id the
    // linked device is now echoing back.
    state.known.add("ld_account_3EB09895651CE648335257");

    const summary = await process([
      {
        kind: "outbound_echo",
        recipient: PATIENT,
        providerMessageId: "ld_account_3EB09895651CE648335257",
        body: "[document]",
        occurredAt: "2026-09-03T01:36:29.000Z",
        displayName: "Mohamed Hassan",
        historical: false,
      },
    ]);

    expect(summary.echoes).toBe(0);
    expect(summary.ignored).toBe(1);
    expect(
      state.inserts.filter((insert) => insert.table === "outbound_messages"),
    ).toHaveLength(0);
    expect(finalizeOutboundMessage).not.toHaveBeenCalled();
  });

  it("still records a genuine echo of something typed on the clinic's handset", async () => {
    const summary = await process([
      {
        kind: "outbound_echo",
        recipient: PATIENT,
        providerMessageId: "ld_account_typed_on_the_phone",
        body: "تمام، شكراً",
        occurredAt: "2026-09-03T01:37:00.000Z",
        displayName: "Mohamed Hassan",
        historical: false,
      },
    ]);

    expect(summary.echoes).toBe(1);
    expect(
      state.inserts.filter((insert) => insert.table === "outbound_messages"),
    ).toHaveLength(1);
  });
});
