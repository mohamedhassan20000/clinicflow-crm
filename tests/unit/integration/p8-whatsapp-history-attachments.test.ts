import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import type { Database } from "@/types/database";

/**
 * P8 — the ingestion pipeline against a real database.
 *
 * These are the properties that only a database can prove: that a replayed
 * history import writes one row and not two, that a historical message does not
 * open a service window or wake the agent, that a foreign storage path is refused
 * at the boundary, and that none of it crosses a tenant line.
 *
 * The patient agent is stubbed rather than mocked away entirely, so the suite can
 * assert *whether* it was invoked — which is the whole difference between
 * importing a year of conversation and replying to a year of conversation.
 */

const stub = vi.hoisted(() => ({
  aiCalls: [] as Array<{ conversationId: string; messageText: string }>,
}));
vi.mock("@/lib/ai/patient-reply", () => ({
  runPatientInboundAiReply: async (input: { conversationId: string; messageText: string }) => {
    stub.aiCalls.push({ conversationId: input.conversationId, messageText: input.messageText });
    return { status: "disabled", mode: "off" };
  },
}));
const aiCalls = stub.aiCalls;

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `p8-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicA = randomUUID();
const clinicB = randomUUID();
const senderA = `+2010${String(Date.now()).slice(-8)}`;
const senderB = `+2011${String(Date.now()).slice(-8)}`;
/** A number no patient of either clinic holds: the H4 staging case. */
const senderStranger = `+2012${String(Date.now()).slice(-8)}`;
/** A separate unlinked contact used by the LID reconciliation lifecycle. */
const senderReconcile = `+2015${String(Date.now()).slice(-8)}`;
const phoneNumberA = `+2018${String(Date.now()).slice(-8)}`;
const phoneNumberB = `+2019${String(Date.now()).slice(-8)}`;
const staffA = randomUUID();
const patientA = randomUUID();
/** The victim's details in the C1 scenarios. Semi-public by construction. */
const NATIONAL_ID_A = `29001${String(Date.now()).slice(-9)}`;
const DOB_A = "1990-12-25";
const NAME_A = "فاطمة أحمد";

async function cleanup() {
  const clinics = [clinicA, clinicB];
  await service.from("whatsapp_pending_history_messages").delete().in("clinic_id", clinics);
  await service.from("whatsapp_pending_history_chats").delete().in("clinic_id", clinics);
  await service.from("whatsapp_lid_mappings").delete().in("clinic_id", clinics);
  await service.from("inbound_message_attachments").delete().in("clinic_id", clinics);
  await service.from("inbound_messages").delete().in("clinic_id", clinics);
  await service.from("outbound_messages").delete().in("clinic_id", clinics);
  await service.from("conversations").delete().in("clinic_id", clinics);
  await service.from("patients").delete().in("clinic_id", clinics);
  await service.from("ai_commercial_terms").delete().in("clinic_id", clinics);
  await service.from("subscriptions").delete().in("clinic_id", clinics);
  await service.from("whatsapp_history_delivery_batches").delete().in("clinic_id", clinics);
  await service.from("whatsapp_linked_device_sessions").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().eq("id", staffA);
  await service.from("clinic_channels").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);
  await service.auth.admin.deleteUser(staffA).catch(() => undefined);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P8 Clinic A ${suffix}`, country: "EG" },
    { id: clinicB, name: `P8 Clinic B ${suffix}`, country: "EG" },
  ]);
  if (clinics.error) throw clinics.error;

  const channels = await service.from("clinic_channels").insert([
    {
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "linked_device",
      sender_identity: phoneNumberA,
      status: "active",
    },
    {
      clinic_id: clinicB,
      channel: "whatsapp",
      provider: "linked_device",
      sender_identity: phoneNumberB,
      status: "active",
    },
  ]);
  if (channels.error) throw channels.error;

  const sessions = await service.from("whatsapp_linked_device_sessions").insert([
    {
      clinic_id: clinicA,
      status: "connected",
      desired_state: "online",
      phone_number: phoneNumberA,
      inbound_active_from: "1970-01-01T00:00:00.000Z",
    },
    {
      clinic_id: clinicB,
      status: "connected",
      desired_state: "online",
      phone_number: phoneNumberB,
      inbound_active_from: "1970-01-01T00:00:00.000Z",
    },
  ]);
  if (sessions.error) throw sessions.error;
  for (const [clinicId, accountId] of [
    [clinicA, phoneNumberA],
    [clinicB, phoneNumberB],
  ] as const) {
    const bound = await service.rpc("bind_whatsapp_linked_account", {
      p_clinic_id: clinicId,
      p_authenticated_account_id: accountId,
      p_proposed_boundary: "1970-01-01T00:00:00.000Z",
    });
    if (bound.error) throw bound.error;
  }

  const authUser = await service.auth.admin.createUser({
    id: staffA,
    email: `${suffix}-admin@example.com`,
    password: "P8Integration123!",
    email_confirm: true,
  });
  if (authUser.error) throw authUser.error;
  const profile = await service.from("profiles").insert({
    id: staffA,
    clinic_id: clinicA,
    full_name: "P8 Clinic Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;

  // The patient-AI authorization read is entitlement-gated, and one of the C1
  // cases asserts on it directly rather than on a stand-in. `pro_ai` on an
  // active subscription is what the real deployment has.
  const plan = await service
    .from("plans")
    .select("id")
    .eq("slug", "pro_ai")
    .eq("is_active", true)
    .maybeSingle();
  if (plan.data) {
    const subscription = await service.from("subscriptions").insert({
      clinic_id: clinicA,
      plan_id: plan.data.id,
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (subscription.error) throw subscription.error;
    // The entitlement also requires accepted AI commercial terms; a clinic that
    // never accepted them has no AI at all, which is the point of that gate.
    const terms = await service.from("ai_commercial_terms").insert({
      clinic_id: clinicA,
      change_reason: "pilot",
      updated_by: staffA,
      accepted_at: new Date().toISOString(),
    });
    if (terms.error) throw terms.error;
  }

  // H4: history is only imported for numbers the clinic has already told us
  // belong to one of their patients. Everything in the import suites below runs
  // against `senderA`, which is exactly that; `senderStranger` is not.
  const patient = await service.from("patients").insert({
    id: patientA,
    clinic_id: clinicA,
    full_name: NAME_A,
    national_id: NATIONAL_ID_A,
    date_of_birth: DOB_A,
    phone: senderA,
    email: `${suffix}-a@example.com`,
    file_number: "CF-0001",
    created_by: staffA,
  });
  if (patient.error) throw patient.error;
});

afterAll(cleanup);

beforeEach(() => {
  aiCalls.length = 0;
});

function historyChat(participant: string, displayName: string | null, at: string) {
  return {
    kind: "history_chat" as const,
    participant,
    displayName,
    lastMessageAt: at,
  };
}

function liveInbound(id: string, sender: string, body: string, at = new Date().toISOString()) {
  return {
    kind: "inbound" as const,
    phoneNumberId: phoneNumberA,
    sender,
    providerMessageId: id,
    body,
    receivedAt: at,
  };
}

function historicalInbound(id: string, sender: string, body: string, at: string) {
  return {
    kind: "inbound" as const,
    phoneNumberId: phoneNumberA,
    sender,
    providerMessageId: id,
    body,
    receivedAt: at,
    historical: true,
  };
}

async function ingest(events: unknown[], clinicId = clinicA, senderIdentity = phoneNumberA) {
  return processMessagingWebhookEvents({
    provider: "linked_device",
    clinicId,
    senderIdentity,
    events: events as never,
  });
}

async function conversationFor(clinicId: string, participant: string) {
  const result = await service
    .from("conversations")
    .select(
      "id, display_name, window_expires_at, status, patient_id, ai_paused_at, identity_verified_at",
    )
    .eq("clinic_id", clinicId)
    .eq("participant_address", participant)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

describe("P8 history import", () => {
  it("persists only immutable WhatsApp-asserted LID mappings", async () => {
    const lid = `${String(Date.now()).slice(-11)}1@lid`;
    const first = await service.rpc("upsert_whatsapp_lid_mappings", {
      p_clinic_id: clinicA,
      p_mappings: [{ lid, participant: senderReconcile }],
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(1);

    const replay = await service.rpc("upsert_whatsapp_lid_mappings", {
      p_clinic_id: clinicA,
      p_mappings: [{ lid, participant: senderReconcile }],
    });
    expect(replay.error).toBeNull();
    const conflict = await service.rpc("upsert_whatsapp_lid_mappings", {
      p_clinic_id: clinicA,
      p_mappings: [{ lid, participant: senderA }],
    });
    expect(conflict.error?.message).toContain("LID_MAPPING_CONFLICT");
  });

  it("records history outcome metrics once per durable batch", async () => {
    const session = await service
      .from("whatsapp_linked_device_sessions")
      .update({
      status: "connected",
      desired_state: "online",
      phone_number: phoneNumberA,
      history_status: "importing",
      history_final_batch_seen: true,
      history_chats_imported: 1,
      history_messages_imported: 4,
      // This legacy-positive fixture deliberately exercises events that are
      // inside the admitted window. Dedicated P11R tests below cover the
      // opposite, pre-boundary case.
      inbound_active_from: "1970-01-01T00:00:00.000Z",
      })
      .eq("clinic_id", clinicA);
    expect(session.error).toBeNull();
    const batchId = randomUUID();
    const batch = await service.from("whatsapp_history_delivery_batches").insert({
      id: batchId,
      clinic_id: clinicA,
      session_phone: phoneNumberA,
      batch_key: `${suffix}-metric-batch`,
      payload: [{ kind: "history_metrics" }],
      event_count: 1,
      status: "delivered",
    });
    expect(batch.error).toBeNull();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recorded = await service.rpc("record_whatsapp_history_metrics", {
        p_clinic_id: clinicA,
        p_batch_id: batchId,
        p_chats_received: 3,
        p_messages_received: 9,
        p_deduplicated: 2,
        p_unsupported: 1,
      });
      expect(recorded.error).toBeNull();
      expect(recorded.data?.[0]).toMatchObject({ history_status: "complete", messages_pending: 0 });
    }
    const stored = await service.from("whatsapp_linked_device_sessions")
      .select("history_chats_received, history_messages_received, history_messages_deduplicated, history_messages_pending, history_messages_unsupported")
      .eq("clinic_id", clinicA)
      .single();
    expect(stored.data).toEqual({
      history_chats_received: 3,
      history_messages_received: 9,
      history_messages_deduplicated: 2,
      history_messages_pending: 0,
      history_messages_unsupported: 1,
    });
  });

  it("ignores pre-boundary history without opening an inbox conversation", async () => {
    const oldParticipant = `+2016${String(Date.now()).slice(-8)}`;
    const summary = await ingest([
      historyChat(oldParticipant, "Old address-book contact", "1969-12-31T23:59:00.000Z"),
      historicalInbound(
        `${suffix}-before-boundary`,
        oldParticipant,
        "must remain outside the inbox",
        "1969-12-31T23:59:00.000Z",
      ),
    ]);

    expect(summary.historyChats).toBe(0);
    expect(summary.inbound).toBe(0);
    expect(summary.ignored).toBe(2);
    expect(await conversationFor(clinicA, oldParticipant)).toBeNull();
  });

  it("durably stages an unresolved LID message, then reconciles and deduplicates it", async () => {
    const lid = `${String(Date.now()).slice(-12)}@lid`;
    const providerMessageId = `${suffix}-lid-pending`;
    const occurredAt = "2026-05-01T08:15:00.000Z";
    const pending = {
      kind: "history_pending_message" as const,
      lid,
      providerMessageId,
      direction: "inbound" as const,
      body: "message waiting for an asserted identity",
      occurredAt,
      displayName: "Fatima",
      attachments: [],
    };

    const stagedSummary = await ingest([pending]);
    expect(stagedSummary.historyPending).toBe(1);
    const staged = await service
      .from("whatsapp_pending_history_messages")
      .select("status, body")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId)
      .single();
    expect(staged.error).toBeNull();
    expect(staged.data).toMatchObject({ status: "pending", body: pending.body });
    const beforeMapping = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId);
    expect(beforeMapping.data).toHaveLength(0);

    const reconciled = await ingest([
      { kind: "history_identity", lid, participant: senderReconcile },
    ]);
    expect(reconciled.historyReconciled).toBe(1);
    const imported = await service
      .from("inbound_messages")
      .select("body, received_at, patient_id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId)
      .single();
    expect(imported.data?.body).toBe(pending.body);
    expect(new Date(imported.data!.received_at).toISOString()).toBe(occurredAt);
    expect(imported.data?.patient_id).toBeNull();
    const resolved = await service
      .from("whatsapp_pending_history_messages")
      .select("status, body, attachments, conversation_id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId)
      .single();
    expect(resolved.data).toMatchObject({ status: "resolved", body: null, attachments: [] });
    expect(resolved.data?.conversation_id).toBeTruthy();

    const staff = createClient<Database>(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const login = await staff.auth.signInWithPassword({
      email: `${suffix}-admin@example.com`,
      password: "P8Integration123!",
    });
    expect(login.error).toBeNull();
    const summaries = await staff.rpc("get_inbox_conversation_summaries", {
      p_requested_conversation_id: resolved.data!.conversation_id!,
      p_limit: 1,
      p_search: senderReconcile,
    });
    expect(summaries.error).toBeNull();
    expect(summaries.data?.find((row) => row.id === resolved.data!.conversation_id)?.preview)
      .toBe(pending.body);
    await staff.auth.signOut();

    const replay = await ingest([pending]);
    expect(replay.historyDeduplicated).toBe(1);
    const rows = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId);
    expect(rows.data).toHaveLength(1);
    const stillResolved = await service
      .from("whatsapp_pending_history_messages")
      .select("status")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", providerMessageId)
      .single();
    expect(stillResolved.data?.status).toBe("resolved");
    expect(aiCalls).toHaveLength(0);
  });

  it("opens a conversation from a history chat and keeps the WhatsApp name", async () => {
    const summary = await ingest([
      historyChat(senderA, "Fatima Ahmed", "2026-06-01T10:00:00.000Z"),
    ]);
    expect(summary.historyChats).toBe(1);

    const conversation = await conversationFor(clinicA, senderA);
    expect(conversation?.display_name).toBe("Fatima Ahmed");
    // A history import is not a patient writing in: no 24-hour service window is
    // opened, because WhatsApp never granted one.
    expect(conversation?.window_expires_at).toBeNull();
  });

  it("imports messages in both directions without notifying or answering", async () => {
    await ingest([
      historyChat(senderA, "Fatima Ahmed", "2026-06-01T10:00:00.000Z"),
      historicalInbound(`${suffix}-h1`, senderA, "عندكم موعد بكرا؟", "2026-06-01T10:00:00.000Z"),
      {
        kind: "outbound_echo",
        recipient: senderA,
        providerMessageId: `${suffix}-h2`,
        body: "أهلاً بحضرتك، متاح من ١٠ لـ ٢",
        occurredAt: "2026-06-01T10:05:00.000Z",
        historical: true,
      },
    ]);

    const conversation = await conversationFor(clinicA, senderA);
    const inbound = await service
      .from("inbound_messages")
      .select("id, body")
      .eq("conversation_id", conversation!.id);
    const outbound = await service
      .from("outbound_messages")
      .select("id, body, body_preview")
      .eq("related_id", conversation!.id);

    expect(inbound.data).toHaveLength(1);
    expect(outbound.data).toHaveLength(1);
    // The mirrored message keeps its full text, not only the redacted preview.
    expect(outbound.data?.[0]?.body).toBe("أهلاً بحضرتك، متاح من ١٠ لـ ٢");
    // Importing history must not hand a year of old messages to the agent.
    expect(aiCalls).toHaveLength(0);
  });

  it("is idempotent: replaying the whole import writes nothing new", async () => {
    const events = [
      historyChat(senderA, "Fatima Ahmed", "2026-06-01T10:00:00.000Z"),
      historicalInbound(`${suffix}-h1`, senderA, "عندكم موعد بكرا؟", "2026-06-01T10:00:00.000Z"),
      {
        kind: "outbound_echo",
        recipient: senderA,
        providerMessageId: `${suffix}-h2`,
        body: "أهلاً بحضرتك، متاح من ١٠ لـ ٢",
        occurredAt: "2026-06-01T10:05:00.000Z",
        historical: true,
      },
    ];
    const summary = await ingest(events);
    // The chat upsert is idempotent by design and still reports success; the
    // messages collapse onto their unique provider ids.
    expect(summary.replays).toBe(1);
    expect(summary.inbound).toBe(0);
    expect(summary.echoes).toBe(0);

    const conversations = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", senderA);
    expect(conversations.data).toHaveLength(1);

    const conversation = await conversationFor(clinicA, senderA);
    const inbound = await service
      .from("inbound_messages")
      .select("id")
      .eq("conversation_id", conversation!.id);
    const outbound = await service
      .from("outbound_messages")
      .select("id")
      .eq("related_id", conversation!.id);
    expect(inbound.data).toHaveLength(1);
    expect(outbound.data).toHaveLength(1);
  });

  it("does not let history and live traffic duplicate the same message", async () => {
    const providerId = `${suffix}-both`;
    await ingest([
      historyChat(senderA, "Fatima Ahmed", "2026-06-02T10:00:00.000Z"),
      historicalInbound(providerId, senderA, "نفس الرسالة", "2026-06-02T10:00:00.000Z"),
    ]);
    const live = await ingest([
      {
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender: senderA,
        providerMessageId: providerId,
        body: "نفس الرسالة",
        receivedAt: "2026-06-02T10:00:00.000Z",
      },
    ]);
    expect(live.replays).toBe(1);
    expect(live.inbound).toBe(0);
  });

  it("does not reopen a thread staff have closed, or extend the window", async () => {
    const conversation = await conversationFor(clinicA, senderA);
    await service
      .from("conversations")
      .update({ status: "closed", status_updated_at: new Date().toISOString() })
      .eq("id", conversation!.id);

    await ingest([
      historicalInbound(`${suffix}-h3`, senderA, "رسالة قديمة", "2026-05-01T10:00:00.000Z"),
    ]);
    const after = await conversationFor(clinicA, senderA);
    expect(after?.status).toBe("closed");
    expect(after?.window_expires_at).toBeNull();

    await service
      .from("conversations")
      .update({ status: "open", status_updated_at: new Date().toISOString() })
      .eq("id", conversation!.id);
  });

  it("still opens a window and wakes the agent for a live message", async () => {
    const summary = await ingest([
      {
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender: senderA,
        providerMessageId: `${suffix}-live`,
        body: "انا في الطريق",
        receivedAt: new Date().toISOString(),
        displayName: "Fatima A.",
      },
    ]);
    expect(summary.inbound).toBe(1);
    const conversation = await conversationFor(clinicA, senderA);
    expect(conversation?.window_expires_at).not.toBeNull();
    expect(aiCalls).toHaveLength(1);
    // A live name outranks whatever history reported.
    expect(conversation?.display_name).toBe("Fatima A.");
  });

  it("refuses history and attachments from a transport that cannot observe them", async () => {
    const summary = await processMessagingWebhookEvents({
      provider: "meta",
      clinicId: clinicA,
      senderIdentity: phoneNumberA,
      events: [
        historyChat(senderA, "Impostor", "2026-06-01T10:00:00.000Z"),
        historicalInbound(`${suffix}-meta`, senderA, "claimed history", "2026-06-01T10:00:00.000Z"),
      ] as never,
    });
    expect(summary.historyChats).toBe(0);
    expect(summary.inbound).toBe(0);
    expect(summary.ignored).toBe(2);
  });
});

describe("P8 attachments", () => {
  const digest = "b".repeat(64);

  async function ingestAttachment(overrides: Record<string, unknown> = {}, id = `${suffix}-att`) {
    return ingest([
      {
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender: senderA,
        providerMessageId: id,
        body: "صورة الأشعة",
        receivedAt: new Date().toISOString(),
        attachments: [
          {
            mediaKind: "image",
            voiceNote: false,
            durationSeconds: null,
            mimeType: "image/jpeg",
            originalFilename: "x-ray.jpg",
            byteSize: 51_200,
            sha256: digest,
            storagePath: `${clinicA}/2026-08/${randomUUID()}.jpg`,
            status: "stored",
            failureReason: null,
            ...overrides,
          },
        ],
      },
    ]);
  }

  it("stores an attachment against the right conversation and message", async () => {
    const summary = await ingestAttachment({}, `${suffix}-att-1`);
    expect(summary.attachments).toBe(1);

    const conversation = await conversationFor(clinicA, senderA);
    const rows = await service
      .from("inbound_message_attachments")
      .select("clinic_id, conversation_id, inbound_message_id, status, mime_type, storage_path")
      .eq("clinic_id", clinicA)
      .eq("conversation_id", conversation!.id);
    expect(rows.data?.length).toBeGreaterThan(0);
    const row = rows.data!.at(-1)!;
    expect(row.status).toBe("stored");
    expect(row.mime_type).toBe("image/jpeg");
    expect(row.inbound_message_id).not.toBeNull();
    expect(row.storage_path?.startsWith(`${clinicA}/`)).toBe(true);
  });

  it("persists PTT voice metadata on the stored audio attachment", async () => {
    const id = `${suffix}-att-voice`;
    const storagePath = `${clinicA}/2026-08/${randomUUID()}.ogg`;
    const summary = await ingestAttachment({
      mediaKind: "audio",
      voiceNote: true,
      durationSeconds: 14,
      mimeType: "audio/ogg; codecs=opus",
      originalFilename: null,
      sha256: "e".repeat(64),
      storagePath,
    }, id);
    expect(summary.attachments).toBe(1);

    const message = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", id)
      .single();
    const row = await service
      .from("inbound_message_attachments")
      .select("media_kind, voice_note, duration_seconds, mime_type, storage_path")
      .eq("inbound_message_id", message.data!.id)
      .single();
    expect(row.data).toEqual({
      media_kind: "audio",
      voice_note: true,
      duration_seconds: 14,
      mime_type: "audio/ogg; codecs=opus",
      storage_path: storagePath,
    });
  });

  it("refuses a storage path belonging to another clinic without losing the message", async () => {
    await ingestAttachment(
      { storagePath: `${clinicB}/2026-08/${randomUUID()}.jpg`, sha256: "c".repeat(64) },
      `${suffix}-att-foreign`,
    );

    const message = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", `${suffix}-att-foreign`)
      .maybeSingle();
    // The message itself survives, which is the point.
    expect(message.data).not.toBeNull();

    const rows = await service
      .from("inbound_message_attachments")
      .select("status, storage_path, failure_reason")
      .eq("inbound_message_id", message.data!.id);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]?.status).toBe("failed");
    expect(rows.data?.[0]?.storage_path).toBeNull();
    expect(rows.data?.[0]?.failure_reason).toBe("foreign_storage_path");
  });

  it("records a refused file so staff know something arrived", async () => {
    await ingestAttachment(
      {
        mediaKind: "unsupported",
        mimeType: "video/mp4",
        status: "rejected",
        storagePath: null,
        sha256: null,
        failureReason: "kind_not_stored",
      },
      `${suffix}-att-rejected`,
    );
    const message = await service
      .from("inbound_messages")
      .select("id, body")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", `${suffix}-att-rejected`)
      .maybeSingle();
    expect(message.data?.body).toBe("صورة الأشعة");
    const rows = await service
      .from("inbound_message_attachments")
      .select("status, failure_reason")
      .eq("inbound_message_id", message.data!.id);
    expect(rows.data?.[0]).toMatchObject({ status: "rejected", failure_reason: "kind_not_stored" });
  });

  it("writes the files on a replay when the first delivery only got the message in", async () => {
    // M1: attachments used to be written on exactly one code path — the delivery
    // that first inserted the message row. A callback that committed the message
    // and then failed could never write its files: the retry saw a replay and
    // skipped them, leaving the bytes orphaned in the bucket with no row, and so
    // invisible to staff, to the AI, and to any future scrub.
    const id = `${suffix}-att-late`;
    // First delivery: the message lands, with no attachment reported.
    await ingest([liveInbound(id, senderA, "صورة الأشعة")]);
    const message = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", id)
      .single();
    const before = await service
      .from("inbound_message_attachments")
      .select("id")
      .eq("inbound_message_id", message.data!.id);
    expect(before.data).toHaveLength(0);

    // The worker retries the same batch, this time carrying the file.
    const summary = await ingestAttachment({ sha256: "d".repeat(64) }, id);
    expect(summary.replays).toBe(1);
    expect(summary.attachments).toBe(1);

    const after = await service
      .from("inbound_message_attachments")
      .select("id, status")
      .eq("inbound_message_id", message.data!.id);
    expect(after.data).toHaveLength(1);
    expect(after.data?.[0]?.status).toBe("stored");
  });

  it("does not duplicate a refused file across re-deliveries", async () => {
    // L1: a rejected attachment has no digest. Under the default NULLS DISTINCT
    // two such rows collide with nothing, so a re-delivered callback wrote the
    // same "we cannot store this voice note" row again. Reachable only once M1
    // made the replay branch write attachments at all.
    const id = `${suffix}-att-refused-twice`;
    const refused = {
      mediaKind: "unsupported",
      mimeType: "audio/ogg",
      status: "rejected",
      storagePath: null,
      sha256: null,
      failureReason: "kind_not_stored",
    };
    await ingestAttachment(refused, id);
    await ingestAttachment(refused, id);
    const message = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", id)
      .single();
    const rows = await service
      .from("inbound_message_attachments")
      .select("id")
      .eq("inbound_message_id", message.data!.id);
    expect(rows.data).toHaveLength(1);
  });

  it("does not duplicate attachments when the callback is replayed", async () => {
    const before = await service
      .from("inbound_message_attachments")
      .select("id")
      .eq("clinic_id", clinicA);
    await ingestAttachment({}, `${suffix}-att-1`);
    const after = await service
      .from("inbound_message_attachments")
      .select("id")
      .eq("clinic_id", clinicA);
    expect(after.data?.length).toBe(before.data?.length);
  });
});

describe("P8 tenant isolation", () => {
  it("keeps two clinics' conversations with the same number apart", async () => {
    await ingest(
      [{ ...liveInbound(`${suffix}-iso-a`, senderB, "hello"), displayName: "Shared Number" }],
      clinicA,
    );
    await ingest(
      [
        {
          ...liveInbound(`${suffix}-iso-b`, senderB, "hello"),
          phoneNumberId: phoneNumberB,
          displayName: "Different Name",
        },
      ],
      clinicB,
      phoneNumberB,
    );

    const inA = await conversationFor(clinicA, senderB);
    const inB = await conversationFor(clinicB, senderB);
    expect(inA?.id).not.toBe(inB?.id);
    expect(inA?.display_name).toBe("Shared Number");
    expect(inB?.display_name).toBe("Different Name");
  });

  it("ignores an inbound event addressed to another pairing's identity", async () => {
    const summary = await ingest(
      [
        {
          kind: "inbound",
          phoneNumberId: phoneNumberB,
          sender: senderA,
          providerMessageId: `${suffix}-misrouted`,
          body: "should not land",
          receivedAt: new Date().toISOString(),
        },
      ],
      clinicA,
      phoneNumberA,
    );
    expect(summary.inbound).toBe(0);
    expect(summary.ignored).toBe(1);
  });
});

describe("P8 human takeover and registration boundaries", () => {
  it("flips the takeover flag once, whichever staff member gets there first", async () => {
    const conversation = await conversationFor(clinicA, senderA);
    const first = await service.rpc("set_conversation_ai_pause", {
      p_clinic_id: clinicA,
      p_conversation_id: conversation!.id,
      p_paused: true,
      p_actor_id: staffA,
      p_reason: "answering by hand",
    });
    expect(first.error).toBeNull();
    expect(first.data?.[0]?.changed).toBe(true);
    expect(first.data?.[0]?.paused).toBe(true);

    // A second click is a no-op, not a second transition.
    const second = await service.rpc("set_conversation_ai_pause", {
      p_clinic_id: clinicA,
      p_conversation_id: conversation!.id,
      p_paused: true,
      p_actor_id: staffA,
      p_reason: undefined,
    });
    expect(second.data?.[0]?.changed).toBe(false);

    const resumed = await service.rpc("set_conversation_ai_pause", {
      p_clinic_id: clinicA,
      p_conversation_id: conversation!.id,
      p_paused: false,
      p_actor_id: staffA,
      p_reason: undefined,
    });
    expect(resumed.data?.[0]?.changed).toBe(true);
    expect(resumed.data?.[0]?.paused).toBe(false);
    const after = await conversationFor(clinicA, senderA);
    expect(after?.ai_paused_at).toBeNull();
  });

  it("refuses to pause a conversation belonging to another clinic", async () => {
    const conversation = await conversationFor(clinicA, senderA);
    const result = await service.rpc("set_conversation_ai_pause", {
      p_clinic_id: clinicB,
      p_conversation_id: conversation!.id,
      p_paused: true,
      p_actor_id: staffA,
      p_reason: undefined,
    });
    expect(result.error?.message).toContain("CONVERSATION_NOT_FOUND");
  });

  it("keeps the superseded auto-registration RPC unreachable", async () => {
    const obsoleteRpc = service.rpc.bind(service) as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
    const result = await obsoleteRpc("register_patient_from_conversation", {
      p_clinic_id: clinicA,
      p_conversation_id: randomUUID(),
      p_full_name: "Must Not Register",
      p_national_id: "ABC12345",
      p_date_of_birth: "1990-12-25",
      p_email: `${suffix}-obsolete@example.com`,
    });
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("PGRST202");
  });
});
/**
 * P8 review · H1 — an imported reply keeps the time the clinic actually sent it.
 *
 * `outbound_messages` has no `sent_at`; `created_at` *is* the message's time
 * everywhere downstream — the thread sorts on it, the inbox preview is built
 * from it, and the unread count is "inbound newer than the latest delivered
 * outbound `created_at`". Letting it default to `now()` on an import stacked
 * every reply the clinic had ever sent at the bottom of the thread dated today.
 */
describe("P8 H1 — imported outbound timestamps", () => {
  it("keeps the original send time on a historical echo", async () => {
    const at = "2026-03-04T09:15:00.000Z";
    await ingest([
      {
        kind: "outbound_echo",
        recipient: senderA,
        providerMessageId: `${suffix}-h1-old`,
        body: "رد قديم من العيادة",
        occurredAt: at,
        historical: true,
      },
    ]);
    const row = await service
      .from("outbound_messages")
      .select("created_at, body")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", `${suffix}-h1-old`)
      .single();
    expect(new Date(row.data!.created_at).toISOString()).toBe(at);
  });

  it("orders an imported thread by what actually happened", async () => {
    await ingest([
      historicalInbound(`${suffix}-h1-in`, senderA, "سؤال من المريضة", "2026-03-04T09:00:00.000Z"),
    ]);
    const conversation = await conversationFor(clinicA, senderA);
    const inbound = await service
      .from("inbound_messages")
      .select("received_at")
      .eq("provider_message_id", `${suffix}-h1-in`)
      .single();
    const outbound = await service
      .from("outbound_messages")
      .select("created_at")
      .eq("provider_message_id", `${suffix}-h1-old`)
      .single();
    // The clinic's reply sits *after* the patient's question, months ago —
    // not at the bottom of the thread stamped today.
    expect(new Date(outbound.data!.created_at).valueOf()).toBeGreaterThan(
      new Date(inbound.data!.received_at).valueOf(),
    );
    expect(new Date(outbound.data!.created_at).valueOf()).toBeLessThan(Date.now());
    expect(conversation).not.toBeNull();
  });

  it("clamps a timestamp from the future rather than trusting the phone's clock", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await ingest([
      {
        kind: "outbound_echo",
        recipient: senderA,
        providerMessageId: `${suffix}-h1-future`,
        body: "من المستقبل",
        occurredAt: future,
        historical: true,
      },
    ]);
    const row = await service
      .from("outbound_messages")
      .select("created_at")
      .eq("provider_message_id", `${suffix}-h1-future`)
      .single();
    // A message stamped in the future would pin the thread to the top of the
    // Inbox for as long as the skew lasted.
    expect(new Date(row.data!.created_at).valueOf()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

/**
 * P8B §2 — a linked account's conversations are the clinic's conversations.
 *
 * This suite replaces P8/H4, which is the behaviour it is *deliberately*
 * reversing rather than relaxing. H4 admitted a history chat only when its
 * number matched a patient and staged everything else as metadata with the
 * bodies dropped. The product rule is now that linking the clinic's own
 * WhatsApp account makes ClinicFlow that account's workspace, so every
 * one-to-one chat is imported.
 *
 * The invariant that replaces it — and that these tests exist to hold — is
 * *separation*, not exclusion: a WhatsApp conversation is communication
 * history, never a medical record and never identity verification. An unlinked
 * chat's messages and attachments carry no patient at all, and no patient is
 * ever created because a chat exists.
 */
describe("P8B §2 — history import admits every one-to-one chat", () => {
  it("imports a chat whose number belongs to a patient, already linked", async () => {
    const summary = await ingest([
      historyChat(senderA, "Fatima Ahmed", "2026-06-01T10:00:00.000Z"),
    ]);
    expect(summary.historyChats).toBe(1);
    const conversation = await conversationFor(clinicA, senderA);
    expect(conversation).not.toBeNull();
    expect(conversation?.patient_id).not.toBeNull();
  });

  it("imports a chat with no patient behind it, as an unlinked conversation", async () => {
    const summary = await ingest([
      historyChat(senderStranger, "خالتي منى", "2026-06-01T10:00:00.000Z"),
    ]);
    expect(summary.historyChats).toBe(1);

    const conversation = await service
      .from("conversations")
      .select("id, patient_id, patient_link_status, display_name, window_expires_at")
      .eq("clinic_id", clinicA)
      .eq("participant_address", senderStranger)
      .single();
    expect(conversation.data).not.toBeNull();
    // Visible, and visibly not a patient.
    expect(conversation.data?.patient_id).toBeNull();
    expect(conversation.data?.patient_link_status).toBe("unlinked");
    // The WhatsApp name is preserved, so the thread reads as a person.
    expect(conversation.data?.display_name).toBe("خالتي منى");
    // An import is not a live message: no 24-hour window is manufactured.
    expect(conversation.data?.window_expires_at).toBeNull();
  });

  it("stores the message bodies of an unlinked chat, stamped with no patient", async () => {
    const summary = await ingest([
      historicalInbound(
        `${suffix}-unlinked-1`,
        senderStranger,
        "متنساش تجيب العيش في طريق رجوعك",
        "2026-06-01T10:05:00.000Z",
      ),
    ]);
    expect(summary.inbound).toBe(1);

    const message = await service
      .from("inbound_messages")
      .select("id, body, patient_id, conversation_id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", `${suffix}-unlinked-1`)
      .single();
    expect(message.data?.body).toBe("متنساش تجيب العيش في طريق رجوعك");
    // The separation invariant, in one assertion: the message is in the Inbox
    // and in nobody's chart.
    expect(message.data?.patient_id).toBeNull();
  });

  it("creates no patient record for an imported chat", async () => {
    const before = await service
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA);
    await ingest([
      historyChat(`${senderStranger}5`, "المحاسب", "2026-06-01T10:00:00.000Z"),
      historicalInbound(`${suffix}-unlinked-2`, `${senderStranger}5`, "الفواتير", "2026-06-01T10:06:00.000Z"),
    ]);
    const after = await service
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA);
    expect(after.count).toBe(before.count);
  });

  it("stamps no patient on an unlinked chat's attachments", async () => {
    await ingest([
      {
        ...historicalInbound(
          `${suffix}-unlinked-att`,
          senderStranger,
          "صورة",
          "2026-06-01T10:07:00.000Z",
        ),
        attachments: [
          {
            mediaKind: "image",
            voiceNote: false,
            durationSeconds: null,
            mimeType: "image/jpeg",
            originalFilename: "photo.jpg",
            byteSize: 1024,
            sha256: "b".repeat(64),
            storagePath: `${clinicA}/2026-06/${suffix}-unlinked.jpg`,
            status: "stored",
            failureReason: null,
          },
        ],
      },
    ]);
    const attachment = await service
      .from("inbound_message_attachments")
      .select("patient_id")
      .eq("clinic_id", clinicA)
      .eq("storage_path", `${clinicA}/2026-06/${suffix}-unlinked.jpg`)
      .maybeSingle();
    expect(attachment.data?.patient_id ?? null).toBeNull();
  });

  it("still opens a thread for a live message from an unknown number", async () => {
    const summary = await ingest([
      liveInbound(`${suffix}-live-stranger`, `${senderStranger}7`, "هل العيادة فاتحة؟"),
    ]);
    expect(summary.inbound).toBe(1);
    expect(await conversationFor(clinicA, `${senderStranger}7`)).not.toBeNull();
  });

  it("is replay-safe: a re-delivered import writes nothing twice", async () => {
    const events = [
      historyChat(`${senderStranger}6`, "Supplier", "2026-06-01T10:00:00.000Z"),
      historicalInbound(`${suffix}-replay-1`, `${senderStranger}6`, "طلبية", "2026-06-01T10:08:00.000Z"),
    ];
    const first = await ingest(events);
    expect(first.inbound).toBe(1);
    const second = await ingest(events);
    expect(second.inbound).toBe(0);
    expect(second.replays).toBe(1);

    const conversations = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", `${senderStranger}6`);
    expect(conversations.data).toHaveLength(1);
    const messages = await service
      .from("inbound_messages")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("provider_message_id", `${suffix}-replay-1`);
    expect(messages.data).toHaveLength(1);
  });

  it("keeps one clinic's imported chats out of another's Inbox", async () => {
    await ingest([historyChat(`${senderStranger}4`, "Tenant probe", "2026-06-01T10:00:00.000Z")]);
    const leaked = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicB)
      .eq("participant_address", `${senderStranger}4`);
    expect(leaked.data).toHaveLength(0);
  });
});

describe("P8B §§3–7 — conversation and outbound-media database boundaries", () => {
  it("opens a thread idempotently without creating a patient", async () => {
    const participant = `+2015${String(Date.now()).slice(-8)}`;
    const before = await service
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA);

    const first = await service.rpc("open_whatsapp_conversation", {
      p_clinic_id: clinicA,
      p_participant: participant,
      p_display_name: "New WhatsApp contact",
      p_actor_id: staffA,
    });
    const second = await service.rpc("open_whatsapp_conversation", {
      p_clinic_id: clinicA,
      p_participant: participant,
      p_display_name: "New WhatsApp contact",
      p_actor_id: staffA,
    });
    const after = await service
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA);

    expect(first.error).toBeNull();
    expect(first.data?.[0]).toMatchObject({ created: true, patient_id: null });
    expect(second.data?.[0]).toMatchObject({
      created: false,
      conversation_id: first.data?.[0]?.conversation_id,
      patient_id: null,
    });
    expect(after.count).toBe(before.count);
  });

  it("refuses an actor from another clinic", async () => {
    const result = await service.rpc("open_whatsapp_conversation", {
      p_clinic_id: clinicB,
      p_participant: `+2016${String(Date.now()).slice(-8)}`,
      p_actor_id: staffA,
    });
    expect(result.error?.message).toContain("ACTOR_NOT_IN_CLINIC");
  });

  it("keeps contact writes service-only and contact reads tenant-scoped", async () => {
    const participant = `+2017${String(Date.now()).slice(-8)}`;
    const upserted = await service.rpc("upsert_whatsapp_contacts", {
      p_clinic_id: clinicA,
      p_contacts: [{ participantAddress: participant, displayName: "Address book contact" }],
    });
    expect(upserted.error).toBeNull();
    expect(upserted.data).toBe(1);
    const scoped = await service
      .from("whatsapp_contacts")
      .select("authenticated_account_id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", participant)
      .single();
    expect(scoped.error).toBeNull();
    expect(scoped.data?.authenticated_account_id).toBe(phoneNumberA);

    const staff = createClient<Database>(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const login = await staff.auth.signInWithPassword({
      email: `${suffix}-admin@example.com`,
      password: "P8Integration123!",
    });
    expect(login.error).toBeNull();
    const visible = await staff
      .from("whatsapp_contacts")
      .select("clinic_id, participant_address")
      .eq("participant_address", participant);
    expect(visible.data).toEqual([{ clinic_id: clinicA, participant_address: participant }]);
    const forbidden = await staff.from("whatsapp_contacts").insert({
      clinic_id: clinicA,
      participant_address: `+2018${String(Date.now()).slice(-8)}`,
    });
    expect(forbidden.error).not.toBeNull();
    await staff.auth.signOut();
  });

  it("allows exactly one same-tenant claim and rejects a cross-tenant claim", async () => {
    const participant = `+2019${String(Date.now()).slice(-8)}`;
    const opened = await service.rpc("open_whatsapp_conversation", {
      p_clinic_id: clinicA,
      p_participant: participant,
      p_actor_id: staffA,
    });
    const conversationId = opened.data?.[0]?.conversation_id;
    expect(conversationId).toBeTruthy();
    const mediaId = randomUUID();
    const path = `${clinicA}/2026-08/${mediaId}.png`;
    const inserted = await service.from("outbound_message_media").insert({
      id: mediaId,
      clinic_id: clinicA,
      conversation_id: conversationId!,
      created_by: staffA,
      source: "upload",
      media_kind: "image",
      mime_type: "image/png",
      file_name: "scan.png",
      byte_size: 128,
      sha256: "a".repeat(64),
      bucket: "whatsapp-outbound",
      storage_path: path,
    });
    expect(inserted.error).toBeNull();

    const foreign = await service.rpc("claim_outbound_media", {
      p_clinic_id: clinicB,
      p_media_id: mediaId,
      p_conversation_id: conversationId!,
    });
    expect(foreign.error).toBeNull();
    expect(foreign.data).toEqual([]);

    const claimed = await service.rpc("claim_outbound_media", {
      p_clinic_id: clinicA,
      p_media_id: mediaId,
      p_conversation_id: conversationId!,
    });
    expect(claimed.error).toBeNull();
    expect(claimed.data?.[0]).toMatchObject({
      media_id: mediaId,
      source: "upload",
      source_record_id: null,
      bucket: "whatsapp-outbound",
      storage_path: path,
    });

    const replay = await service.rpc("claim_outbound_media", {
      p_clinic_id: clinicA,
      p_media_id: mediaId,
      p_conversation_id: conversationId!,
    });
    expect(replay.data).toEqual([]);
  });

  it("gives authenticated staff no direct write path into the outbound bucket", async () => {
    const staff = createClient<Database>(url, publishableKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        storageKey: `${suffix}-bucket-auth`,
      },
    });
    const login = await staff.auth.signInWithPassword({
      email: `${suffix}-admin@example.com`,
      password: "P8Integration123!",
    });
    expect(login.error).toBeNull();
    const path = `${clinicA}/forbidden.txt`;
    /**
     * The body is raw bytes rather than a `Blob` on purpose. Under the jsdom test
     * environment `Blob` is jsdom's, which implements `arrayBuffer()` but not
     * `stream()`; storage-js wraps such a body in multipart form data, and Node 22's
     * fetch then produces a request body that never yields — the upload hangs instead
     * of being refused. Bytes take the same path the only real writer to this bucket
     * takes (`uploadOutboundMedia` sends a Buffer), so this still exercises the real
     * storage endpoint and the real policy.
     */
    const upload = await staff.storage
      .from("whatsapp-outbound")
      .upload(path, Buffer.from("not allowed"), { contentType: "text/plain" });
    expect(upload.error).not.toBeNull();
    expect(upload.data).toBeNull();
    /** Refused by policy, not by a transport hiccup, and nothing landed in the bucket. */
    expect((upload.error as { statusCode?: string } | null)?.statusCode).toBe("403");
    const listed = await service.storage.from("whatsapp-outbound").list(clinicA);
    expect(listed.error).toBeNull();
    expect(listed.data?.map((entry) => entry.name)).not.toContain("forbidden.txt");
    await staff.auth.signOut();
  });
});
