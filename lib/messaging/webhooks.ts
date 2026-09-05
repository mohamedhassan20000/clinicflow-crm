import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  applyMessageTemplateProviderStatus,
  advanceOutboundMessageStatus,
  createClinicScopedAdminClient,
  finalizeOutboundMessage,
  markConversationHumanReply,
  persistLinkedDeviceInbound,
  persistWhatsAppInbound,
  upsertLinkedDeviceHistoryChat,
} from "@/lib/supabase/admin";
import { buildBodyPreview } from "@/lib/messaging/send";
import { normalizePhone } from "@/lib/phone/registry";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import { logAttachmentPersistDiagnostic } from "@/lib/messaging/inbound-media-diagnostics";
import { emitClinicNotification } from "@/lib/notifications/emit";
import { runPatientInboundAiReply } from "@/lib/ai/patient-reply";
import { resetConversationAssistantState } from "@/lib/ai/conversation-reset";
import {
  applyChannelStateSignals,
  refreshConnectionStateAfterTemplateChange,
} from "@/lib/messaging/meta-reconcile";
import type {
  InboundAttachment,
  MessagingProviderId,
  TemplateApprovalStatus,
  WebhookEvent,
} from "@/lib/messaging/types";
import {
  inboundDisplayName,
  isHistoryBeforeBoundary,
} from "@/lib/messaging/history-boundary";

type ProcessingSummary = {
  inbound: number;
  /** P7E: messages mirrored in from the clinic's own phone. */
  echoes: number;
  statuses: number;
  templates: number;
  states: number;
  replays: number;
  ignored: number;
  /** P8: conversations opened or renamed from the linked device's history. */
  historyChats: number;
  /** P8: attachment rows written alongside inbound messages. */
  attachments: number;
  historyPending: number;
  historyReconciled: number;
  historyDeduplicated: number;
  historyChatsReceived: number;
  historyMessagesReceived: number;
  historyUnsupported: number;
};

function receivedAt(value: string | null): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * P8/H1: the time an echoed message was actually sent.
 *
 * Clamped to now rather than trusted outright — the timestamp comes off the
 * phone's own clock via the history sync, and a message stamped in the future
 * would sort above everything and pin the conversation to the top of the Inbox
 * for as long as the skew lasted. An unparseable or missing value falls back to
 * now, which is the correct reading for a live echo and the only honest one for
 * a historical event that carried no time at all.
 */
function echoTimestamp(value: string | null | undefined): string {
  const now = Date.now();
  if (!value) return new Date(now).toISOString();
  const parsed = new Date(value);
  const at = parsed.valueOf();
  if (Number.isNaN(at)) return new Date(now).toISOString();
  return new Date(Math.min(at, now)).toISOString();
}

function senderE164(sender: string): string {
  const candidate = sender.startsWith("+") ? sender : `+${sender}`;
  return normalizePhone(candidate) ?? candidate;
}

/**
 * P8: writes the attachment rows for one inbound message.
 *
 * The worker reports a storage path it has already written; this is where the
 * application proves that path belongs to the clinic the callback was verified
 * for. A path outside `<clinicId>/` is not stored as a file reference at all —
 * the row survives as `failed`, so staff still see that something arrived
 * without ClinicFlow pointing them at another tenant's bytes.
 *
 * Never throws. A message must not be lost because one of its files could not be
 * recorded.
 */
async function persistInboundAttachments(input: {
  clinicId: string;
  conversationId: string;
  inboundMessageId: string;
  attachments: readonly InboundAttachment[];
}): Promise<number> {
  if (input.attachments.length === 0) return 0;
  for (const attachment of input.attachments) {
    logAttachmentPersistDiagnostic({
      stage: "attachment_persist_started",
      clinicId: input.clinicId,
      attachment,
    });
  }
  const client = createClinicScopedAdminClient(input.clinicId);
  const rows = input.attachments.map((attachment) => {
    const tenantOwned =
      attachment.storagePath !== null &&
      attachment.storagePath.startsWith(`${input.clinicId}/`);
    const usable = attachment.status === "stored" && tenantOwned;
    return {
      clinic_id: input.clinicId,
      conversation_id: input.conversationId,
      inbound_message_id: input.inboundMessageId,
      media_kind: attachment.mediaKind,
      voice_note: attachment.voiceNote,
      duration_seconds: attachment.durationSeconds,
      mime_type: attachment.mimeType,
      original_filename: attachment.originalFilename,
      byte_size: attachment.byteSize,
      sha256: attachment.sha256,
      storage_path: usable ? attachment.storagePath : null,
      status: usable ? "stored" : attachment.status === "stored" ? "failed" : attachment.status,
      failure_reason: usable
        ? attachment.failureReason
        : attachment.status === "stored"
          ? "foreign_storage_path"
          : attachment.failureReason,
    };
  });
  // Replayed callbacks land on the partial unique index over
  // (clinic, message, kind, digest) and are ignored rather than duplicated.
  const write = (payload: typeof rows | Array<Omit<(typeof rows)[number], "voice_note" | "duration_seconds">>) => client
    .from("inbound_message_attachments")
    .upsert(payload, {
      onConflict: "clinic_id,inbound_message_id,media_kind,sha256",
      ignoreDuplicates: true,
    })
    .select("id");
  let inserted = await write(rows);
  if (inserted.error?.code === "42703" || inserted.error?.code === "PGRST204") {
    // Rolling-schema compatibility: an old database can still persist and
    // render the coarse audio/image/document kind. PTT and duration begin
    // landing as soon as P8D is applied, without dropping working image paths.
    inserted = await write(rows.map(({ voice_note, duration_seconds, ...row }) => {
      void voice_note;
      void duration_seconds;
      return row;
    }));
  }
  if (inserted.error) {
    for (const attachment of input.attachments) {
      logAttachmentPersistDiagnostic({
        stage: "attachment_persist_failed",
        clinicId: input.clinicId,
        attachment,
        errorCategory: "database",
        errorCode: inserted.error.code,
      });
    }
    // Do not attach the PostgREST message/details/hint: they can contain a
    // storage path or content digest. The stage diagnostic above retains the
    // safe SQL/service code needed to diagnose the boundary.
    Sentry.captureMessage("inbound attachment rows could not be written", {
      level: "error",
      tags: { scope: "webhook-attachments", provider: "linked_device" },
      extra: { clinicId: input.clinicId, errorCategory: "database", errorCode: inserted.error.code },
    });
    return 0;
  }
  for (const attachment of input.attachments) {
    logAttachmentPersistDiagnostic({
      stage: "attachment_persist_completed",
      clinicId: input.clinicId,
      attachment,
    });
  }
  return inserted.data?.length ?? 0;
}

/**
 * P8/P8B: opens the inbox thread for a chat the history sync listed, without any
 * of the effects a live message has.
 *
 * P8B removed the admission test that used to live here. Every one-to-one chat
 * the linked account has is a conversation ClinicFlow shows; the patient-number
 * match now only decides whether the thread arrives already *linked*. See the
 * migration's §3 for why the staging model was retired rather than kept
 * alongside this one.
 */
async function persistHistoryChat(
  clinicId: string,
  authenticatedAccountId: string,
  event: Extract<WebhookEvent, { kind: "history_chat" }>,
): Promise<"imported" | "ignored"> {
  const participant = senderE164(event.participant);
  const upserted = await upsertLinkedDeviceHistoryChat({
    clinicId,
    authenticatedAccountId,
    participant,
    displayName: event.displayName,
    lastMessageAt: event.lastMessageAt,
  });
  if (upserted.error) throw new Error("HISTORY_CHAT_UPSERT_FAILED");
  const row = upserted.data?.[0];
  return row?.conversation_id ? "imported" : "ignored";
}

async function historyParticipantForLid(
  clinicId: string,
  authenticatedAccountId: string,
  lid: string,
): Promise<string | null> {
  const result = await createClinicScopedAdminClient(clinicId)
    .from("whatsapp_lid_mappings")
    .select("participant_address")
    .eq("authenticated_account_id", authenticatedAccountId)
    .eq("lid_jid", lid)
    .maybeSingle();
  if (result.error) throw new Error("HISTORY_MAPPING_LOOKUP_FAILED");
  return result.data?.participant_address ?? null;
}

async function storePendingHistoryChat(
  clinicId: string,
  authenticatedAccountId: string,
  event: Extract<WebhookEvent, { kind: "history_pending_chat" }>,
): Promise<void> {
  const participant = await historyParticipantForLid(clinicId, authenticatedAccountId, event.lid);
  if (participant) {
    await persistHistoryChat(clinicId, authenticatedAccountId, {
      kind: "history_chat",
      participant,
      displayName: event.displayName,
      lastMessageAt: event.lastMessageAt,
    });
    return;
  }
  const stored = await createClinicScopedAdminClient(clinicId)
    .from("whatsapp_pending_history_chats")
    .upsert({
      clinic_id: clinicId,
      authenticated_account_id: authenticatedAccountId,
      lid_jid: event.lid,
      display_name: event.displayName,
      last_message_at: event.lastMessageAt,
      status: "pending",
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "clinic_id,authenticated_account_id,lid_jid",
      // A history replay must never turn an already reconciled row back into
      // pending. The original payload remains authoritative until resolution.
      ignoreDuplicates: true,
    });
  if (stored.error) throw new Error("HISTORY_PENDING_CHAT_STORE_FAILED");
}

async function persistResolvedPendingMessage(input: {
  clinicId: string;
  authenticatedAccountId: string;
  participant: string;
  providerMessageId: string;
  direction: "inbound" | "outbound";
  body: string;
  occurredAt: string;
  displayName: string | null;
  attachments: InboundAttachment[];
  summary: ProcessingSummary;
}): Promise<"inserted" | "replay"> {
  await persistHistoryChat(input.clinicId, input.authenticatedAccountId, {
    kind: "history_chat",
    participant: input.participant,
    displayName: input.displayName,
    lastMessageAt: input.occurredAt,
  });
  if (input.direction === "inbound") {
    return persistInboundMessage(
      input.clinicId,
      {
        kind: "inbound",
        phoneNumberId: "linked-device-history",
        sender: input.participant,
        providerMessageId: input.providerMessageId,
        body: input.body,
        receivedAt: input.occurredAt,
        displayName: input.displayName,
        historical: true,
        attachments: input.attachments,
      },
      input.summary,
      "linked_device",
      input.authenticatedAccountId,
    );
  }
  const inserted = await persistOutboundEcho(input.clinicId, input.authenticatedAccountId, {
    kind: "outbound_echo",
    recipient: input.participant,
    providerMessageId: input.providerMessageId,
    body: input.body,
    occurredAt: input.occurredAt,
    displayName: input.displayName,
    historical: true,
  });
  return inserted ? "inserted" : "replay";
}

async function storePendingHistoryMessage(
  clinicId: string,
  authenticatedAccountId: string,
  event: Extract<WebhookEvent, { kind: "history_pending_message" }>,
  summary: ProcessingSummary,
): Promise<"inserted" | "replay" | "pending"> {
  const participant = await historyParticipantForLid(clinicId, authenticatedAccountId, event.lid);
  if (participant) {
    return persistResolvedPendingMessage({
      clinicId,
      authenticatedAccountId,
      participant,
      providerMessageId: event.providerMessageId,
      direction: event.direction,
      body: event.body || "[Empty message]",
      occurredAt: event.occurredAt,
      displayName: event.displayName ?? null,
      attachments: event.attachments ?? [],
      summary,
    });
  }
  const stored = await createClinicScopedAdminClient(clinicId)
    .from("whatsapp_pending_history_messages")
    .upsert({
      clinic_id: clinicId,
      authenticated_account_id: authenticatedAccountId,
      lid_jid: event.lid,
      provider_message_id: event.providerMessageId,
      direction: event.direction,
      body: event.body || "[Empty message]",
      occurred_at: event.occurredAt,
      display_name: event.displayName ?? null,
      attachments: (event.attachments ?? []).map((attachment) => ({ ...attachment })),
      status: "pending",
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "clinic_id,authenticated_account_id,provider_message_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (stored.error) throw new Error("HISTORY_PENDING_MESSAGE_STORE_FAILED");
  return (stored.data?.length ?? 0) > 0 ? "pending" : "replay";
}

async function reconcileHistoryIdentity(
  clinicId: string,
  authenticatedAccountId: string,
  event: Extract<WebhookEvent, { kind: "history_identity" }>,
  summary: ProcessingSummary,
  inboundActiveFrom: string | null,
): Promise<void> {
  const participant = senderE164(event.participant);
  const client = createClinicScopedAdminClient(clinicId);
  const inserted = await client.from("whatsapp_lid_mappings").upsert({
    clinic_id: clinicId,
    authenticated_account_id: authenticatedAccountId,
    lid_jid: event.lid,
    participant_address: participant,
    last_asserted_at: new Date().toISOString(),
  }, { onConflict: "clinic_id,authenticated_account_id,lid_jid", ignoreDuplicates: true });
  if (inserted.error) throw new Error("HISTORY_MAPPING_STORE_FAILED");
  const asserted = await historyParticipantForLid(clinicId, authenticatedAccountId, event.lid);
  if (asserted !== participant) throw new Error("HISTORY_MAPPING_CONFLICT");

  let pendingChatQuery = client
    .from("whatsapp_pending_history_chats")
    .select("id, display_name, last_message_at")
    .eq("authenticated_account_id", authenticatedAccountId)
    .eq("lid_jid", event.lid)
    .eq("status", "pending");
  if (inboundActiveFrom) pendingChatQuery = pendingChatQuery.gte("last_message_at", inboundActiveFrom);
  const pendingChat = await pendingChatQuery.maybeSingle();
  if (pendingChat.error) throw new Error("HISTORY_PENDING_CHAT_LOOKUP_FAILED");
  if (pendingChat.data) {
    const chatResult = await upsertLinkedDeviceHistoryChat({
      clinicId,
      authenticatedAccountId,
      participant,
      displayName: pendingChat.data.display_name,
      lastMessageAt: pendingChat.data.last_message_at,
    });
    const conversationId = chatResult.data?.[0]?.conversation_id;
    if (chatResult.error || !conversationId) throw new Error("HISTORY_CHAT_RECONCILE_FAILED");
    const marked = await client.from("whatsapp_pending_history_chats").update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      conversation_id: conversationId,
      updated_at: new Date().toISOString(),
    }).eq("id", pendingChat.data.id);
    if (marked.error) throw new Error("HISTORY_PENDING_CHAT_FINALIZE_FAILED");
  }

  let pendingQuery = client
    .from("whatsapp_pending_history_messages")
    .select("id, provider_message_id, direction, body, occurred_at, display_name, attachments")
    .eq("authenticated_account_id", authenticatedAccountId)
    .eq("lid_jid", event.lid)
    .eq("status", "pending")
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (inboundActiveFrom) pendingQuery = pendingQuery.gte("occurred_at", inboundActiveFrom);
  const pending = await pendingQuery;
  if (pending.error) throw new Error("HISTORY_PENDING_MESSAGE_LOOKUP_FAILED");

  for (const row of pending.data ?? []) {
    const attachments = Array.isArray(row.attachments)
      ? row.attachments as unknown as InboundAttachment[]
      : [];
    const result = await persistResolvedPendingMessage({
      clinicId,
      authenticatedAccountId,
      participant,
      providerMessageId: row.provider_message_id,
      direction: row.direction === "outbound" ? "outbound" : "inbound",
      body: row.body || "[Empty message]",
      occurredAt: row.occurred_at,
      displayName: row.display_name,
      attachments,
      summary,
    });
    const conversation = await client.from("conversations").select("id")
      .eq("channel", "whatsapp")
      .eq("whatsapp_account_id", authenticatedAccountId)
      .eq("participant_address", participant)
      .maybeSingle();
    if (conversation.error || !conversation.data) throw new Error("HISTORY_CONVERSATION_LOOKUP_FAILED");
    const marked = await client.from("whatsapp_pending_history_messages").update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      conversation_id: conversation.data.id,
      body: null,
      attachments: [],
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (marked.error) throw new Error("HISTORY_PENDING_MESSAGE_FINALIZE_FAILED");
    if (result === "inserted") summary.historyReconciled += 1;
    else summary.historyDeduplicated += 1;
  }
}

/**
 * Whether the WhatsApp thread for one number is currently closed.
 *
 * A missing thread is not closed — it does not exist yet, and a first message
 * has nothing to forget.
 */
async function existingConversationMetadata(
  clinicId: string,
  participant: string,
  authenticatedAccountId?: string,
): Promise<{ status: string; displayName: string | null } | null> {
  let query = createClinicScopedAdminClient(clinicId)
    .from("conversations")
    .select("status, display_name")
    .eq("channel", "whatsapp")
    .eq("participant_address", participant);
  query = authenticatedAccountId
    ? query.eq("whatsapp_account_id", authenticatedAccountId)
    : query.is("whatsapp_account_id", null);
  const existing = await query.maybeSingle();
  if (existing.error || !existing.data) return null;
  return { status: existing.data.status, displayName: existing.data.display_name };
}

async function persistInboundMessage(
  clinicId: string,
  event: Extract<WebhookEvent, { kind: "inbound" }>,
  summary: { attachments: number },
  provider: MessagingProviderId,
  authenticatedAccountId?: string,
): Promise<"inserted" | "replay"> {
  const sender = senderE164(event.sender);
  const timestamp = receivedAt(event.receivedAt);
  const historical = event.historical === true;
  // P11N — was this thread closed before this message arrived?
  //
  // `persist_whatsapp_inbound` reopens a closed conversation, which is the
  // right behaviour and is not changed here. What was missing is that the
  // reopened thread carried the whole of its previous episode with it — the
  // collected fields, the pending question, the booking stage — so the
  // assistant resumed an intake the patient had finished days earlier. The
  // status has to be read *before* the RPC, because afterwards the row is
  // already open and the transition is unobservable. A read per inbound
  // message, best-effort, and never a reason to fail a webhook.
  const existing = await existingConversationMetadata(
    clinicId,
    sender,
    authenticatedAccountId,
  ).catch(() => null);
  const closedBefore = !historical && existing?.status === "closed";
  const persistInput = {
    clinicId,
    sender,
    body: event.body || "[Empty message]",
    providerMessageId: event.providerMessageId,
    receivedAt: timestamp,
    // The worker has already applied saved/verified/published name precedence;
    // a live resolved label may replace stale history metadata. Patient linkage
    // is presented separately and remains the highest UI identity.
    displayName: inboundDisplayName(existing?.displayName, event.displayName),
    historical,
  };
  const persisted = authenticatedAccountId
    ? await persistLinkedDeviceInbound({
        ...persistInput,
        authenticatedAccountId,
      })
    : await persistWhatsAppInbound(persistInput);
  if (persisted.error || !persisted.data?.[0]) {
    throw new Error(
      persisted.error?.code
        ? `INBOUND_PERSIST_FAILED:${persisted.error.code}`
        : "INBOUND_PERSIST_FAILED",
    );
  }
  const record = persisted.data[0];
  const conversationId = record.conversation_id;
  if (historical && record.inserted && record.inbound_message_id) {
    await createClinicScopedAdminClient(clinicId)
      .from("inbound_messages")
      .update({ ingestion_origin: "history_sync" })
      .eq("id", record.inbound_message_id)
      .eq("clinic_id", clinicId);
  }
  // M1: attachments are written on *both* branches. Writing them only when the
  // message row was freshly inserted meant a callback that committed the message
  // and then failed (a transient attachment-upsert error, a batch that threw
  // afterwards) could never write the files on retry: the retry saw a replay and
  // skipped them, leaving the bytes orphaned in the bucket with no row — visible
  // to nobody, and reachable by no future scrub. The upsert is idempotent on
  // (clinic, message, kind, digest), so re-running it on a replay is free.
  if (conversationId && record.inbound_message_id && event.attachments?.length) {
    summary.attachments += await persistInboundAttachments({
      clinicId,
      conversationId,
      inboundMessageId: record.inbound_message_id,
      attachments: event.attachments,
    });
  }
  if (!record.inserted) return "replay";

  // P8: a message imported from history is already answered, already read, and
  // frequently months old. It is persisted so the thread reads correctly and
  // then goes no further: notifying staff about a year of old messages, or
  // handing them to the patient agent, would turn an import into an outbound
  // flood.
  if (historical) return "inserted";

  // P3D (§7.5): staff awareness of new patient messages. Assigned threads
  // notify their owner; unassigned ones notify the inbox roles. Deduped per
  // conversation while unread, and never a reason to fail the webhook.
  if (conversationId) {
    const conversation = await createClinicScopedAdminClient(clinicId)
      .from("conversations")
      .select("assigned_to")
      .eq("id", conversationId)
      .maybeSingle();
    await emitClinicNotification({
      clinicId,
      type: "inbox_message",
      link: `/inbox?conversation=${conversationId}`,
      data: { conversationId },
      ...(conversation.data?.assigned_to
        ? { recipientIds: [conversation.data.assigned_to] }
        : { roles: ["admin", "receptionist"] }),
      dedupeUnread: true,
    });

    // P11N — a reopened thread starts from a clean conversational state.
    //
    // Belt and braces with the reset that "Close Thread" now performs: it also
    // covers every thread closed before that existed, and any state written
    // between the close and this message. The patient's file, the thread's
    // patient link and every stored message are untouched — only what the
    // assistant was in the middle of is forgotten.
    if (closedBefore) {
      await resetConversationAssistantState({
        clinicId,
        conversationId,
        reason: "reopened",
        // P11O — for a thread closed before the boundary column existed there
        // is no boundary to inherit, and one has to be drawn here. It is this
        // message's own arrival time, never `now`: the message is the first
        // turn of the new episode and must fall inside it. A thread closed
        // after P11O already carries its boundary and this value is ignored.
        boundaryAt: timestamp,
      }).catch(() => undefined);
    }

    // P5B (§6.2): hand the fresh inbound turn to the patient AI. This is the
    // only wiring point between the webhook and the agent. It is strictly
    // best-effort — a disabled mode, a missing entitlement, or any failure
    // leaves the staff inbox notification above as the guaranteed fallback and
    // never fails the webhook (a failed reply degrades to a human, §6.7).
    try {
      await runPatientInboundAiReply({
        clinicId,
        conversationId,
        providerMessageId: event.providerMessageId,
        messageText: event.body ?? "",
      });
    } catch (error) {
      // The provider the callback actually arrived on. This used to be hardcoded
      // to "dialog360", which silently mislabelled every linked-device failure.
      Sentry.captureException(error, {
        tags: { scope: "webhook-patient-ai", provider },
      });
    }
  }
  return "inserted";
}

/**
 * P7E: mirrors a message the clinic sent from their own phone into the existing
 * outbound pipeline, so the inbox thread reads as one conversation instead of
 * half of one.
 *
 * Only threads that already exist are mirrored: an outbound-only echo is not a
 * reason to open a conversation, and a patient who has never written to the
 * clinic must not appear in the inbox because of a message sent to them from a
 * phone. Usage counters are deliberately untouched — ClinicFlow did not send
 * this. Re-delivery of the same message, and the echo of a message ClinicFlow
 * itself just sent, both collapse on the unique provider-message-id index.
 */
async function persistOutboundEcho(
  clinicId: string,
  authenticatedAccountId: string,
  event: Extract<WebhookEvent, { kind: "outbound_echo" }>,
): Promise<boolean> {
  const recipient = senderE164(event.recipient);
  const client = createClinicScopedAdminClient(clinicId);
  const conversation = await client
    .from("conversations")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("whatsapp_account_id", authenticatedAccountId)
    .eq("participant_address", recipient)
    .maybeSingle();
  if (conversation.error) throw new Error("OUTBOUND_ECHO_LOOKUP_FAILED");
  // P8: for history this is normally already satisfied — the `history_chat`
  // event for the same participant is ordered ahead of its messages, so a thread
  // the clinic only ever sent into exists by the time its messages arrive. An
  // echo still never *creates* a conversation on its own.
  if (!conversation.data) return false;

  const historical = event.historical === true;
  const echoRow = {
      clinic_id: clinicId,
      // P15 (§5) — which kind of outbound row this is, recorded at insert time
      // because nothing downstream can reconstruct it afterwards. The Inbox
      // reads it to tell "a colleague just answered from their handset" (live,
      // and therefore human handling) from "we imported a year of their sent
      // messages" (history, and therefore nothing at all). Getting this wrong
      // in the permissive direction would relabel every imported thread as
      // actively handled the moment the import ran.
      ingestion_origin: (historical ? "history_sync" : "live") as string,
      channel: "whatsapp" as const,
      provider: "linked_device" as const,
      recipient,
      // Written at insert time so the unique (provider, provider_message_id)
      // index is what decides whether this message is already known.
      provider_message_id: event.providerMessageId,
      // P8/H1: when the clinic actually sent this, not when we heard about it.
      //
      // outbound_messages has no sent_at column; created_at *is* the message's
      // time everywhere downstream — the Inbox sorts the thread on it, the
      // summary RPC builds the preview from it, and the unread count is
      // "inbound messages newer than the latest delivered outbound created_at".
      // Letting it default to now() on an import therefore stacked every reply
      // the clinic had ever sent at the bottom of the thread dated today, made
      // every imported thread's preview the clinic's own last message, and
      // reported zero unread for threads that had genuinely never been answered.
      created_at: echoTimestamp(event.occurredAt),
      body_preview: buildBodyPreview(event.body || "[Empty message]"),
      // P8: the full text as well as the redacted preview. A message the clinic
      // typed on their own phone reads in the Inbox exactly as the patient sees
      // it, rather than being cut at 120 characters. Scoped to inbox threads by
      // the outbound_messages body/related_type check constraint.
      body: (event.body || "[Empty message]").slice(0, 8192),
      related_type: "manual" as const,
      related_id: conversation.data.id,
      status: "queued" as const,
  };
  const writeEcho = (
    row: typeof echoRow | Omit<typeof echoRow, "ingestion_origin">,
  ) => client.from("outbound_messages").insert(row).select("id").maybeSingle();
  let inserted = await writeEcho(echoRow);
  // Rolling-schema compatibility, the same shape the attachment writer uses: a
  // database without P15's provenance column still records the message, it just
  // cannot tell a live echo from an imported one — which is exactly the pre-P15
  // behaviour and not a reason to lose the message.
  if (inserted.error?.code === "42703" || inserted.error?.code === "PGRST204") {
    const { ingestion_origin: _origin, ...withoutOrigin } = echoRow;
    void _origin;
    inserted = await writeEcho(withoutOrigin);
  }
  if (inserted.error) {
    // A duplicate provider message id means this message is already recorded —
    // either ClinicFlow sent it, or this callback was delivered twice. That is
    // a replay, not a failure.
    if (inserted.error.code === "23505") return false;
    throw new Error("OUTBOUND_ECHO_INSERT_FAILED");
  }
  if (!inserted.data) return false;

  const finalized = await finalizeOutboundMessage({
    clinicId,
    outboundMessageId: inserted.data.id,
    status: "sent",
    providerMessageId: event.providerMessageId,
    error: null,
    costMicro: null,
    occurredAt: echoTimestamp(event.occurredAt),
  });
  if (finalized.error) throw new Error("OUTBOUND_ECHO_FINALIZE_FAILED");

  // P15 (§5) — a person at this clinic answered this patient from the clinic's
  // own handset, just now.
  //
  // Only for a live echo. A historical one is a message that was answered
  // months ago, and treating it as a fresh human reply would walk the whole
  // imported inbox into "Active conversation" the first time the history sync
  // ran. Only for a thread that already exists, because the lookup above never
  // creates one. And never a reason to fail the callback: the outbound row is
  // already committed and *is* the evidence the Inbox derives the status from
  // — this call only disarms the assistant's idle close so it does not talk
  // over the colleague who has just replied.
  if (!historical) {
    await markConversationHumanReply({
      clinicId,
      conversationId: conversation.data.id,
      occurredAt: echoTimestamp(event.occurredAt),
    }).catch(() => undefined);
  }
  return finalized.data === true;
}

async function persistStatus(
  provider: MessagingProviderId,
  event: Extract<WebhookEvent, { kind: "status" }>,
  expectedClinicId?: string,
): Promise<boolean> {
  const clientReference = event.clientReference &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.clientReference,
    )
    ? event.clientReference
    : null;
  const update = await advanceOutboundMessageStatus({
    provider,
    providerMessageId: event.providerMessageId,
    clientReference,
    expectedClinicId: expectedClinicId ?? null,
    status: event.status,
    error: event.error ? sanitizeProviderError(event.error) : null,
    occurredAt: event.occurredAt,
  });
  if (update.error) throw new Error("OUTBOUND_STATUS_UPDATE_FAILED");
  return update.data === true;
}

/**
 * Provider states a webhook may legally move a template into. Only a
 * submitted template accepts provider outcomes, and only from the states that
 * can still change (P3-M3). A late/stale event for a template the clinic has
 * since edited (back to draft) or replaced is ignored rather than allowed to
 * regress the stored state.
 */
const TEMPLATE_WEBHOOK_TRANSITIONS: Partial<
  Record<TemplateApprovalStatus, readonly TemplateApprovalStatus[]>
> = {
  approved: ["submitted", "rejected"],
  rejected: ["submitted", "approved"],
  submitted: ["submitted"],
};

async function persistTemplateStatus(
  clinicId: string,
  event: Extract<WebhookEvent, { kind: "template_status" }>,
  provider: MessagingProviderId,
): Promise<boolean> {
  const allowedFrom = TEMPLATE_WEBHOOK_TRANSITIONS[event.status];
  if (!allowedFrom) return false;
  const update = await applyMessageTemplateProviderStatus({
    provider,
    providerTemplateId: event.providerTemplateId,
    status: event.status,
    allowedFrom: [...allowedFrom],
  });
  if (update.error) throw new Error("TEMPLATE_STATUS_UPDATE_FAILED");
  const applied = update.data?.[0];
  if (!applied?.changed || applied.clinic_id !== clinicId) return false;
  if (provider === "meta") {
    await refreshConnectionStateAfterTemplateChange(clinicId).catch((error) => {
      Sentry.captureException(error, {
        tags: { scope: "webhook-template-state", provider: "meta" },
      });
    });
  }
  return true;
}

export async function processMessagingWebhookEvents(input: {
  provider: MessagingProviderId;
  clinicId?: string;
  senderIdentity?: string;
  events: readonly WebhookEvent[];
}): Promise<ProcessingSummary> {
  const summary: ProcessingSummary = {
    inbound: 0,
    echoes: 0,
    statuses: 0,
    templates: 0,
    states: 0,
    replays: 0,
    ignored: 0,
    historyChats: 0,
    attachments: 0,
    historyPending: 0,
    historyReconciled: 0,
    historyDeduplicated: 0,
    historyChatsReceived: 0,
    historyMessagesReceived: 0,
    historyUnsupported: 0,
  };
  let boundaryLoaded = false;
  let inboundActiveFrom: string | null = null;
  const linkedAccountId =
    input.provider === "linked_device" ? input.senderIdentity : undefined;
  const linkedBoundary = async (): Promise<string | null> => {
    if (boundaryLoaded) return inboundActiveFrom;
    boundaryLoaded = true;
    if (input.provider !== "linked_device" || !input.clinicId || !linkedAccountId) return null;
    const result = await createClinicScopedAdminClient(input.clinicId)
      .from("whatsapp_linked_device_sessions")
      .select("authenticated_account_id, inbound_active_from, created_at")
      .eq("clinic_id", input.clinicId)
      .maybeSingle();
    if (!result.error && result.data?.authenticated_account_id === linkedAccountId) {
      inboundActiveFrom = result.data?.inbound_active_from ?? result.data?.created_at ?? null;
    }
    return inboundActiveFrom;
  };
  const oldHistory = async (value: string | null | undefined): Promise<boolean> => {
    const boundary = await linkedBoundary();
    return isHistoryBeforeBoundary(value, boundary);
  };
  for (const event of input.events) {
    if (event.kind === "ignored") {
      summary.ignored += 1;
      continue;
    }
    if (
      event.kind === "history_identity" ||
      event.kind === "history_pending_chat" ||
      event.kind === "history_pending_message" ||
      event.kind === "history_metrics"
    ) {
      if (input.provider !== "linked_device" || !input.clinicId || !linkedAccountId) {
        summary.ignored += 1;
        continue;
      }
      if (event.kind === "history_identity") {
        await reconcileHistoryIdentity(
          input.clinicId,
          linkedAccountId,
          event,
          summary,
          await linkedBoundary(),
        );
      } else if (event.kind === "history_pending_chat") {
        if (await oldHistory(event.lastMessageAt)) {
          summary.ignored += 1;
          continue;
        }
        await storePendingHistoryChat(input.clinicId, linkedAccountId, event);
      } else if (event.kind === "history_pending_message") {
        if (await oldHistory(event.occurredAt)) {
          summary.ignored += 1;
          continue;
        }
        const result = await storePendingHistoryMessage(
          input.clinicId,
          linkedAccountId,
          event,
          summary,
        );
        if (result === "pending") summary.historyPending += 1;
        else if (result === "inserted") summary.historyReconciled += 1;
        else summary.historyDeduplicated += 1;
      } else {
        summary.historyChatsReceived += event.chatsReceived;
        summary.historyMessagesReceived += event.messagesReceived;
        summary.historyUnsupported += event.unsupportedMessages;
      }
      continue;
    }
    if (event.kind === "history_chat" || event.kind === "history_progress") {
      // Only a paired device observes the phone's own history. No third-party
      // transport may open threads or claim an import it did not perform.
      if (input.provider !== "linked_device" || !input.clinicId || !linkedAccountId) {
        summary.ignored += 1;
        continue;
      }
      if (event.kind === "history_progress") {
        // Progress is bookkeeping the worker already wrote to the session row;
        // acknowledging it here keeps the callback contract uniform.
        summary.ignored += 1;
        continue;
      }
      if (await oldHistory(event.lastMessageAt)) {
        summary.ignored += 1;
        continue;
      }
      const decision = await persistHistoryChat(input.clinicId, linkedAccountId, event);
      if (decision === "imported") summary.historyChats += 1;
      else summary.ignored += 1;
      continue;
    }
    if (event.kind === "inbound") {
      if (
        !input.clinicId ||
        (input.senderIdentity !== undefined && event.phoneNumberId !== input.senderIdentity)
      ) {
        summary.ignored += 1;
        continue;
      }
      if (event.historical === true && await oldHistory(event.receivedAt)) {
        summary.ignored += 1;
        continue;
      }
      // Historical messages and attachments are a linked-device capability. A
      // Cloud API webhook claiming either is refused rather than trusted.
      if (
        input.provider !== "linked_device" &&
        (event.historical === true || (event.attachments?.length ?? 0) > 0)
      ) {
        summary.ignored += 1;
        continue;
      }
      try {
        const result = await persistInboundMessage(
          input.clinicId,
          event,
          summary,
          input.provider,
          linkedAccountId,
        );
        if (result === "replay") summary.replays += 1;
        else summary.inbound += 1;
      } catch (error) {
        if (error instanceof Error && error.message === "WEBHOOK_REPLAY") {
          summary.replays += 1;
          continue;
        }
        throw error;
      }
      continue;
    }
    if (event.kind === "outbound_echo") {
      // Only a paired device can observe what was sent from the phone; no other
      // transport may write history it did not carry.
      if (input.provider !== "linked_device" || !input.clinicId || !linkedAccountId) {
        summary.ignored += 1;
        continue;
      }
      if (event.historical === true && await oldHistory(event.occurredAt)) {
        summary.ignored += 1;
        continue;
      }
      if (await persistOutboundEcho(input.clinicId, linkedAccountId, event)) summary.echoes += 1;
      else summary.ignored += 1;
      continue;
    }
    if (event.kind === "status") {
      if (await persistStatus(input.provider, event, input.clinicId)) summary.statuses += 1;
      else summary.ignored += 1;
      continue;
    }
    if (!input.clinicId) {
      summary.ignored += 1;
      continue;
    }
    if (event.kind === "channel_state") {
      // P6C: only Meta-direct channels carry a derived connection state. Route by
      // phone id when the event provides one; a WABA-only event (no phone id) is
      // left to the reconciliation poll — the hybrid design's safety net.
      if (
        input.provider !== "meta" ||
        (event.phoneNumberId !== null &&
          input.senderIdentity !== undefined &&
          event.phoneNumberId !== input.senderIdentity)
      ) {
        summary.ignored += 1;
        continue;
      }
      const applied = await applyChannelStateSignals({
        clinicId: input.clinicId,
        signals: event.signals,
        observedAt: event.observedAt,
      });
      if (applied.transitioned) summary.states += 1;
      else summary.ignored += 1;
      continue;
    }
    if (await persistTemplateStatus(input.clinicId, event, input.provider)) summary.templates += 1;
    else summary.ignored += 1;
  }
  return summary;
}
