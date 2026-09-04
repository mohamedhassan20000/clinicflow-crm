import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

/**
 * Phase 6 — real-policy verification for the two things Phase 6 adds at the
 * database boundary: the retention purge RPC and the fact that document reads
 * stay clinic- and role-scoped when the assistant reaches them.
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `phase6-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase6DocumentsRetention12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const conversationA = randomUUID();
const conversationB = randomUUID();
/** P6-04 — expired transcript, so its title and active context must be scrubbed. */
const conversationStale = randomUUID();
/** P6-04 — in-window transcript, so both must survive untouched. */
const conversationFresh = randomUUID();
const userIds: string[] = [];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("No user returned");
  }
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

let adminA: Awaited<ReturnType<typeof createUser>>;
let receptionistA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;

const RETENTION = {
  messages: 180,
  receipts: 400,
  confirmations: 30,
};
const NOW = new Date("2026-08-14T12:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const freshMessageId = randomUUID();
const staleMessageId = randomUUID();
const freshReceiptId = randomUUID();
const staleReceiptId = randomUUID();
const claimableConfirmationId = randomUUID();
const spentConfirmationId = randomUUID();
const documentAId = randomUUID();
const documentBId = randomUUID();
const staleConversationMessageId = randomUUID();
const freshConversationMessageId = randomUUID();
const scrubbedConversationReceiptId = randomUUID();
const scrubbedConversationConfirmationId = randomUUID();
const STALE_TITLE = "What is Mohamed Seif's blood type?";
const FRESH_TITLE = "Book a follow-up for tomorrow";
const STALE_CONTEXT = {
  patient: {
    entity_type: "patient",
    entity_id: randomUUID(),
    display_label: "Mohamed Seif",
    set_at: "2025-01-01T00:00:00.000Z",
    set_by: "resolution",
  },
};

beforeAll(async () => {
  [adminA, receptionistA, adminB] = await Promise.all([
    createUser("admin-a"),
    createUser("receptionist-a"),
    createUser("admin-b"),
  ]);

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Phase 6 A ${suffix}` },
    { id: clinicB, name: `Phase 6 B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: adminA.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    {
      id: receptionistA.id,
      clinic_id: clinicA,
      full_name: "Receptionist A",
      role: "receptionist",
    },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
  ]);
  if (profiles.error) throw profiles.error;

  const conversations = await service.from("agent_conversations").insert([
    // Every row carries an explicit created_at: a bulk insert where only some
    // rows name a column sends NULL for the rest.
    {
      id: conversationA,
      clinic_id: clinicA,
      user_id: adminA.id,
      persona: "doctor",
      locale: "en",
      title: null,
      active_context: {},
      created_at: NOW.toISOString(),
    },
    {
      id: conversationB,
      clinic_id: clinicB,
      user_id: adminB.id,
      persona: "doctor",
      locale: "en",
      title: null,
      active_context: {},
      created_at: NOW.toISOString(),
    },
    // P6-04 — a conversation whose transcript is past the window. Its `title` is
    // a verbatim copy of the user's first message and `active_context` carries
    // the patient id that re-identifies it; both survived the purge before.
    {
      id: conversationStale,
      clinic_id: clinicA,
      user_id: adminA.id,
      persona: "doctor",
      locale: "en",
      title: STALE_TITLE,
      active_context: STALE_CONTEXT,
      created_at: daysAgo(RETENTION.messages + 30),
    },
    // Equally old, but one of its messages is still in-window, so the whole row
    // must survive untouched: the transcript has not expired yet.
    {
      id: conversationFresh,
      clinic_id: clinicA,
      user_id: adminA.id,
      persona: "doctor",
      locale: "en",
      title: FRESH_TITLE,
      active_context: STALE_CONTEXT,
      created_at: daysAgo(RETENTION.messages + 30),
    },
  ]);
  if (conversations.error) throw conversations.error;

  const scrubMessages = await service.from("agent_messages").insert([
    {
      id: staleConversationMessageId,
      conversation_id: conversationStale,
      clinic_id: clinicA,
      role: "user",
      content: STALE_TITLE,
      created_at: daysAgo(RETENTION.messages + 30),
    },
    {
      id: freshConversationMessageId,
      conversation_id: conversationFresh,
      clinic_id: clinicA,
      role: "user",
      content: FRESH_TITLE,
      created_at: daysAgo(5),
    },
  ]);
  if (scrubMessages.error) throw scrubMessages.error;

  // Accountability records on the conversation that will be scrubbed. They are
  // the reason the row is never deleted, so they must come through untouched.
  const scrubReceipt = await service.from("ai_action_receipts").insert({
    id: scrubbedConversationReceiptId,
    clinic_id: clinicA,
    actor_id: adminA.id,
    conversation_id: conversationStale,
    action_id: "documents.issue",
    risk_class: "sensitive",
    phase: "execute",
    authorization_outcome: "allowed",
    input_digest: "1".repeat(64),
    outcome: "success",
    created_at: daysAgo(1),
  });
  if (scrubReceipt.error) throw scrubReceipt.error;

  const scrubConfirmation = await service.from("ai_action_confirmations").insert({
    id: scrubbedConversationConfirmationId,
    token_hash: "2".repeat(64),
    clinic_id: clinicA,
    actor_id: adminA.id,
    conversation_id: conversationStale,
    action_id: "documents.issue",
    input_digest: "3".repeat(64),
    created_at: daysAgo(1),
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
  });
  if (scrubConfirmation.error) throw scrubConfirmation.error;
}, 60_000);

afterAll(async () => {
  await service.from("documents").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("ai_action_receipts").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("ai_action_confirmations")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("agent_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("agent_conversations")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("Phase 6 retention purge at the database boundary", () => {
  it("is unreachable for an authenticated clinic admin", async () => {
    const attempt = await adminA.client.rpc("purge_ai_retention_data", {
      p_message_retention_days: RETENTION.messages,
      p_receipt_retention_days: RETENTION.receipts,
      p_confirmation_retention_days: RETENTION.confirmations,
    });
    expect(attempt.error).not.toBeNull();
  });

  it("refuses a nonsensical window rather than deleting everything", async () => {
    const zeroWindow = await service.rpc("purge_ai_retention_data", {
      p_message_retention_days: 0,
      p_receipt_retention_days: RETENTION.receipts,
      p_confirmation_retention_days: RETENTION.confirmations,
    });
    expect(zeroWindow.error).not.toBeNull();

    const invertedWindows = await service.rpc("purge_ai_retention_data", {
      p_message_retention_days: 400,
      p_receipt_retention_days: 30,
      p_confirmation_retention_days: RETENTION.confirmations,
    });
    expect(invertedWindows.error).not.toBeNull();
  });

  it("deletes expired assistant data on schedule and keeps everything in-window", async () => {
    const messages = await service.from("agent_messages").insert([
      {
        id: freshMessageId,
        conversation_id: conversationA,
        clinic_id: clinicA,
        role: "user",
        content: "recent turn",
        created_at: daysAgo(10),
      },
      {
        id: staleMessageId,
        conversation_id: conversationA,
        clinic_id: clinicA,
        role: "assistant",
        content: "clinical narrative well past the retention window",
        created_at: daysAgo(RETENTION.messages + 30),
      },
    ]);
    if (messages.error) throw messages.error;

    const receipts = await service.from("ai_action_receipts").insert([
      {
        id: freshReceiptId,
        clinic_id: clinicA,
        actor_id: adminA.id,
        conversation_id: conversationA,
        action_id: "documents.issue",
        risk_class: "sensitive",
        phase: "execute",
        authorization_outcome: "allowed",
        input_digest: "a".repeat(64),
        outcome: "success",
        created_at: daysAgo(RETENTION.messages + 30),
      },
      {
        id: staleReceiptId,
        clinic_id: clinicA,
        actor_id: adminA.id,
        conversation_id: conversationA,
        action_id: "documents.issue",
        risk_class: "sensitive",
        phase: "execute",
        authorization_outcome: "allowed",
        input_digest: "b".repeat(64),
        outcome: "success",
        created_at: daysAgo(RETENTION.receipts + 30),
      },
    ]);
    if (receipts.error) throw receipts.error;

    const confirmations = await service.from("ai_action_confirmations").insert([
      {
        id: claimableConfirmationId,
        token_hash: "c".repeat(64),
        clinic_id: clinicA,
        actor_id: adminA.id,
        conversation_id: conversationA,
        action_id: "documents.issue",
        input_digest: "d".repeat(64),
        // Old but still claimable: never purged regardless of age.
        created_at: daysAgo(RETENTION.confirmations + 30),
        expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      },
      {
        id: spentConfirmationId,
        token_hash: "e".repeat(64),
        clinic_id: clinicA,
        actor_id: adminA.id,
        conversation_id: conversationA,
        action_id: "documents.issue",
        input_digest: "f".repeat(64),
        created_at: daysAgo(RETENTION.confirmations + 30),
        expires_at: daysAgo(RETENTION.confirmations + 29),
        consumed_at: daysAgo(RETENTION.confirmations + 29),
      },
    ]);
    if (confirmations.error) throw confirmations.error;

    const purge = await service.rpc("purge_ai_retention_data", {
      p_message_retention_days: RETENTION.messages,
      p_receipt_retention_days: RETENTION.receipts,
      p_confirmation_retention_days: RETENTION.confirmations,
      p_now: NOW.toISOString(),
    });
    expect(purge.error).toBeNull();

    const [remainingMessages, remainingReceipts, remainingConfirmations, conversation] =
      await Promise.all([
        service.from("agent_messages").select("id").in("id", [freshMessageId, staleMessageId]),
        service
          .from("ai_action_receipts")
          .select("id")
          .in("id", [freshReceiptId, staleReceiptId]),
        service
          .from("ai_action_confirmations")
          .select("id")
          .in("id", [claimableConfirmationId, spentConfirmationId]),
        service.from("agent_conversations").select("id").eq("id", conversationA),
      ]);

    expect(remainingMessages.data?.map((row) => row.id)).toEqual([freshMessageId]);
    expect(remainingReceipts.data?.map((row) => row.id)).toEqual([freshReceiptId]);
    expect(remainingConfirmations.data?.map((row) => row.id)).toEqual([
      claimableConfirmationId,
    ]);
    // The conversation itself survives: its children cascade from it, so
    // deleting it would destroy accountability records ahead of their window.
    expect(conversation.data?.map((row) => row.id)).toEqual([conversationA]);
  });

  it("scrubs an expired conversation's own free text without deleting the row (P6-04)", async () => {
    const [scrubbed, kept] = await Promise.all([
      service
        .from("agent_conversations")
        .select("id, title, active_context")
        .eq("id", conversationStale)
        .maybeSingle(),
      service
        .from("agent_conversations")
        .select("id, title, active_context")
        .eq("id", conversationFresh)
        .maybeSingle(),
    ]);

    // The row still exists — receipts and confirmations cascade from it — but
    // the user's verbatim first message and the ids that re-identify it are gone.
    expect(scrubbed.data?.id).toBe(conversationStale);
    expect(scrubbed.data?.title).toBeNull();
    expect(scrubbed.data?.active_context).toEqual({});

    // The conversation whose transcript has not expired keeps both.
    expect(kept.data?.title).toBe(FRESH_TITLE);
    expect(kept.data?.active_context).toMatchObject({
      patient: { entity_type: "patient" },
    });
  });

  it("leaves the scrubbed conversation's receipts and confirmations intact (P6-04)", async () => {
    const [receipt, confirmation] = await Promise.all([
      service
        .from("ai_action_receipts")
        .select("id, conversation_id, input_digest")
        .eq("id", scrubbedConversationReceiptId)
        .maybeSingle(),
      service
        .from("ai_action_confirmations")
        .select("id, conversation_id")
        .eq("id", scrubbedConversationConfirmationId)
        .maybeSingle(),
    ]);
    expect(receipt.data).toMatchObject({
      conversation_id: conversationStale,
      input_digest: "1".repeat(64),
    });
    expect(confirmation.data).toMatchObject({ conversation_id: conversationStale });
  });

  it("is idempotent — a second run on the same data changes nothing more", async () => {
    const again = await service.rpc("purge_ai_retention_data", {
      p_message_retention_days: RETENTION.messages,
      p_receipt_retention_days: RETENTION.receipts,
      p_confirmation_retention_days: RETENTION.confirmations,
      p_now: NOW.toISOString(),
    });
    expect(again.error).toBeNull();
    expect(again.data?.[0]).toMatchObject({
      deleted_messages: 0,
      deleted_receipts: 0,
      deleted_confirmations: 0,
      // An already-scrubbed conversation no longer matches the predicate.
      scrubbed_conversations: 0,
    });
  });

  it("never scrubs a conversation that still has an in-window message", async () => {
    const kept = await service
      .from("agent_conversations")
      .select("title")
      .eq("id", conversationFresh)
      .maybeSingle();
    expect(kept.data?.title).toBe(FRESH_TITLE);
  });
});

describe("Phase 6 document reads stay RLS-scoped", () => {
  it("never returns another clinic's issued document to an admin", async () => {
    const documents = await service.from("documents").insert([
      {
        id: documentAId,
        clinic_id: clinicA,
        doc_type: "GENERIC_DOCUMENT",
        document_number: `DOC-A-${suffix.slice(-6)}`,
        idempotency_key: `phase6-a-${suffix}`,
        status: "issued",
        locale: "en",
        params: {},
        snapshot: {},
        issued_at: NOW.toISOString(),
        issued_by: adminA.id,
        pdf_storage_path: `documents/${clinicA}/GENERIC_DOCUMENT/${documentAId}.pdf`,
        page_count: 1,
        numbering_prefix_snapshot: "DOC",
        sequence_value: 1,
        verification_token: randomUUID().replaceAll("-", ""),
      },
      {
        id: documentBId,
        clinic_id: clinicB,
        doc_type: "GENERIC_DOCUMENT",
        document_number: `DOC-B-${suffix.slice(-6)}`,
        idempotency_key: `phase6-b-${suffix}`,
        status: "issued",
        locale: "en",
        params: {},
        snapshot: {},
        issued_at: NOW.toISOString(),
        issued_by: adminB.id,
        pdf_storage_path: `documents/${clinicB}/GENERIC_DOCUMENT/${documentBId}.pdf`,
        page_count: 1,
        numbering_prefix_snapshot: "DOC",
        sequence_value: 1,
        verification_token: randomUUID().replaceAll("-", ""),
      },
    ]);
    if (documents.error) throw documents.error;

    const [ownClinic, crossTenantById] = await Promise.all([
      adminA.client.from("documents").select("id").in("id", [documentAId, documentBId]),
      // A cross-tenant id is not "denied": it simply is not there, so the
      // assistant cannot distinguish "not yours" from "does not exist".
      adminA.client.from("documents").select("id").eq("id", documentBId),
    ]);
    expect(ownClinic.error).toBeNull();
    expect(ownClinic.data?.map((row) => row.id)).toEqual([documentAId]);
    expect(crossTenantById.data).toEqual([]);
  });

  it("keeps a receptionist out of the assistant's action receipt ledger", async () => {
    const receipts = await receptionistA.client
      .from("ai_action_receipts")
      .select("id");
    expect(receipts.error).toBeNull();
    expect(receipts.data).toEqual([]);
  });
});
