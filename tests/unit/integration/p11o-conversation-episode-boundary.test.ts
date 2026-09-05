import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11O — the episode boundary against a real database.
 *
 * The unit suite proves the assembly logic with a stubbed client. What only a
 * database can prove is the half the stub cannot: that the column exists and
 * survives a round trip, that PostgREST's `gte` on a `timestamptz` partitions
 * the message rows the way the reply path assumes, that
 * `persist_whatsapp_inbound` reopening a closed thread does not disturb the
 * boundary, and — the property the whole change exists for — that the messages
 * excluded from model context are still every bit as readable as before.
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

vi.mock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

const suffix = `p11o-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const patientId = randomUUID();
const sender = `+2013${String(Date.now()).slice(-8)}`;
const staffId = randomUUID();
const phoneNumberId = `p11o${Date.now()}`;

let conversationId = "";

/** The previous episode, then the boundary, then the new one. */
const OLD_IN_1 = "2026-08-29T11:00:00.000Z";
const OLD_OUT_1 = "2026-08-29T11:10:00.000Z";
const OLD_IN_2 = "2026-08-29T11:20:00.000Z";
const NEW_IN = "2026-08-30T09:00:00.000Z";

async function cleanup() {
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("outbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("clinic_channels").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("id", staffId);
  await service.auth.admin.deleteUser(staffId).catch(() => undefined);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  await cleanup();

  const clinic = await service
    .from("clinics")
    .insert({ id: clinicId, name: `P11O Clinic ${suffix}`, country: "EG" });
  if (clinic.error) throw clinic.error;

  const channel = await service.from("clinic_channels").insert({
    clinic_id: clinicId,
    channel: "whatsapp",
    provider: "linked_device",
    sender_identity: phoneNumberId,
    status: "active",
  });
  if (channel.error) throw channel.error;

  const authUser = await service.auth.admin.createUser({
    id: staffId,
    email: `${suffix}-admin@example.test`,
    password: "P11OIntegration123!",
    email_confirm: true,
  });
  if (authUser.error) throw authUser.error;
  const profile = await service.from("profiles").insert({
    id: staffId,
    clinic_id: clinicId,
    full_name: "P11O Clinic Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;

  // The permanent record: a real patient this number belongs to.
  const patient = await service.from("patients").insert({
    id: patientId,
    clinic_id: clinicId,
    full_name: "Mohamed Hassan",
    phone: sender,
    email: `p11o-${suffix}@example.test`,
    date_of_birth: "1990-01-01",
    national_id: `29001${String(Date.now()).slice(-9)}`,
    file_number: `P11O-${suffix}`,
    created_by: staffId,
  });
  if (patient.error) throw patient.error;
});

afterAll(cleanup);

beforeEach(async () => {
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("outbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);

  conversationId = randomUUID();
  const conversation = await service.from("conversations").insert({
    id: conversationId,
    clinic_id: clinicId,
    channel: "whatsapp",
    participant_address: sender,
    patient_id: patientId,
    patient_link_status: "automatic",
    display_name: "Mohamed Hassan",
    status: "open",
    ai_collected_data: { full_name: "سارة عبد الرحمن", department_id: randomUUID() },
    ai_booking_stage: { stage: "intake_collecting", offeredDoctorIds: [] },
  });
  if (conversation.error) throw conversation.error;

  const inbound = await service.from("inbound_messages").insert([
    {
      clinic_id: clinicId,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender,
      body: "عايز أحجز",
      provider_message_id: `${suffix}-in1-${conversationId}`,
      received_at: OLD_IN_1,
    },
    {
      clinic_id: clinicId,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender,
      body: "سارة عبد الرحمن",
      provider_message_id: `${suffix}-in2-${conversationId}`,
      received_at: OLD_IN_2,
    },
  ]);
  if (inbound.error) throw inbound.error;

  const outbound = await service.from("outbound_messages").insert({
    clinic_id: clinicId,
    channel: "whatsapp",
    recipient: sender,
    provider: "linked_device",
    body: "تحب تحجز في أنهي قسم؟ عندنا الجلدية والأسنان.",
    body_preview: "تحب تحجز في أنهي قسم؟",
    related_type: "manual",
    related_id: conversationId,
    status: "sent",
    created_at: OLD_OUT_1,
  });
  if (outbound.error) throw outbound.error;
});

/** The rows the reply path would hand the model, using its own filters. */
async function modelVisibleMessages(boundary: string | null) {
  let inboundQuery = service
    .from("inbound_messages")
    .select("body, received_at")
    .eq("conversation_id", conversationId);
  let outboundQuery = service
    .from("outbound_messages")
    .select("body, created_at")
    .eq("related_type", "manual")
    .eq("related_id", conversationId);
  if (boundary) {
    inboundQuery = inboundQuery.gte("received_at", boundary);
    outboundQuery = outboundQuery.gte("created_at", boundary);
  }
  const [inbound, outbound] = await Promise.all([inboundQuery, outboundQuery]);
  if (inbound.error) throw inbound.error;
  if (outbound.error) throw outbound.error;
  return [
    ...(inbound.data ?? []).map((row) => row.body ?? ""),
    ...(outbound.data ?? []).map((row) => row.body ?? ""),
  ];
}

async function readConversation() {
  const result = await service
    .from("conversations")
    .select(
      "status, patient_id, patient_link_status, display_name, ai_context_reset_at, ai_collected_data, ai_booking_stage",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data!;
}

describe("P11O — closing a thread ends the episode in the database", () => {
  it("stamps a boundary that partitions the thread's messages", async () => {
    const { closeAndResetConversation } = await import("@/lib/ai/conversation-reset");
    await closeAndResetConversation({
      clinicId,
      conversationId,
      reason: "manual_close",
    });

    const row = await readConversation();
    expect(row.status).toBe("closed");
    expect(row.ai_context_reset_at).toBeTruthy();
    expect(row.ai_collected_data).toEqual({});
    expect(row.ai_booking_stage).toBeNull();

    // The new episode's first message, arriving after the close.
    const arrivedAt = new Date().toISOString();
    const fresh = await service.from("inbound_messages").insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender,
      body: "السلام عليكم",
      provider_message_id: `${suffix}-new-${conversationId}`,
      received_at: arrivedAt,
    });
    if (fresh.error) throw fresh.error;

    const visible = await modelVisibleMessages(row.ai_context_reset_at);
    expect(visible).toEqual(["السلام عليكم"]);
  });

  it("keeps every old message readable for staff", async () => {
    const { closeAndResetConversation } = await import("@/lib/ai/conversation-reset");
    await closeAndResetConversation({ clinicId, conversationId, reason: "manual_close" });

    // The unfiltered read — what the Inbox does — still returns the lot.
    const all = await modelVisibleMessages(null);
    expect(all).toHaveLength(3);
    expect(all).toContain("سارة عبد الرحمن");
    expect(all.join("\n")).toContain("الجلدية");
  });

  it("leaves the permanent patient link exactly as it was", async () => {
    const { closeAndResetConversation } = await import("@/lib/ai/conversation-reset");
    await closeAndResetConversation({ clinicId, conversationId, reason: "assistant_close" });

    const row = await readConversation();
    expect(row.patient_id).toBe(patientId);
    expect(row.patient_link_status).toBe("automatic");
    expect(row.display_name).toBe("Mohamed Hassan");

    const patient = await service
      .from("patients")
      .select("id, full_name")
      .eq("id", patientId)
      .maybeSingle();
    expect(patient.data?.full_name).toBe("Mohamed Hassan");
  });
});

describe("P11O — reopening does not disturb the boundary", () => {
  it("survives the inbound RPC flipping the thread back to open", async () => {
    const { closeAndResetConversation, resetConversationAssistantState } = await import(
      "@/lib/ai/conversation-reset"
    );
    await closeAndResetConversation({ clinicId, conversationId, reason: "manual_close" });
    const closed = await readConversation();
    const boundary = closed.ai_context_reset_at;

    // What `persist_whatsapp_inbound` does to a closed thread.
    const arrivedAt = new Date().toISOString();
    await service.from("inbound_messages").insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender,
      body: "السلام عليكم",
      provider_message_id: `${suffix}-reopen-${conversationId}`,
      received_at: arrivedAt,
    });
    await service
      .from("conversations")
      .update({ status: "open", status_updated_at: arrivedAt })
      .eq("id", conversationId);

    // And what the webhook then does, with the message's own arrival time.
    await resetConversationAssistantState({
      clinicId,
      conversationId,
      reason: "reopened",
      boundaryAt: arrivedAt,
    });

    const reopened = await readConversation();
    expect(reopened.status).toBe("open");
    // Unmoved: the close owns the boundary, the reopen only fills a missing one.
    expect(reopened.ai_context_reset_at).toBe(boundary);
    expect(await modelVisibleMessages(reopened.ai_context_reset_at)).toEqual(["السلام عليكم"]);
  });

  it("draws a boundary for a legacy thread closed before the column existed", async () => {
    const { resetConversationAssistantState } = await import("@/lib/ai/conversation-reset");
    // No boundary at all — exactly the state of every thread closed before this.
    expect((await readConversation()).ai_context_reset_at).toBeNull();

    const arrivedAt = NEW_IN;
    await service.from("inbound_messages").insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender,
      body: "السلام عليكم",
      provider_message_id: `${suffix}-legacy-${conversationId}`,
      received_at: arrivedAt,
    });
    await resetConversationAssistantState({
      clinicId,
      conversationId,
      reason: "reopened",
      boundaryAt: arrivedAt,
    });

    const row = await readConversation();
    expect(row.ai_context_reset_at).toBeTruthy();
    // `gte`, so the message that drew the boundary is inside its own episode.
    expect(await modelVisibleMessages(row.ai_context_reset_at)).toEqual(["السلام عليكم"]);
  });
});
