import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clinicId = randomUUID();
const userId = randomUUID();
const conversationId = randomUUID();
const emailConversationId = randomUUID();
const password = "P3cSummary12345!";
const email = `p3c-summary-${Date.now()}@example.com`;
let receptionist: ReturnType<typeof createClient<Database>>;

async function cleanup() {
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("outbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("id", userId);
  await service.from("clinics").delete().eq("id", clinicId);
  await service.auth.admin.deleteUser(userId);
}

beforeAll(async () => {
  await cleanup();
  const auth = await service.auth.admin.createUser({
    id: userId,
    email,
    password,
    email_confirm: true,
  });
  if (auth.error) throw auth.error;
  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: "P3C Summary Clinic",
  });
  if (clinic.error) throw clinic.error;
  const profile = await service.from("profiles").insert({
    id: userId,
    clinic_id: clinicId,
    full_name: "P3C Receptionist",
    role: "receptionist",
  });
  if (profile.error) throw profile.error;
  const conversations = await service.from("conversations").insert([
    {
      id: conversationId,
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: "+96555555555",
      last_message_at: "2026-07-17T10:40:00.000Z",
      window_expires_at: "2026-07-18T10:40:00.000Z",
    },
    {
      id: emailConversationId,
      clinic_id: clinicId,
      channel: "email",
      participant_address: "patient@example.com",
      last_message_at: "2026-07-17T11:00:00.000Z",
    },
  ]);
  if (conversations.error) throw conversations.error;

  const start = new Date("2026-07-17T10:00:00.000Z").valueOf();
  const inbound = Array.from({ length: 2_001 }, (_, index) => ({
    clinic_id: clinicId,
    channel: "whatsapp" as const,
    sender: "+96555555555",
    conversation_id: conversationId,
    body: `Inbound ${index}`,
    provider_message_id: `p3c-summary-${index}`,
    received_at: new Date(start + index * 1_000).toISOString(),
  }));
  const inboundInsert = await service.from("inbound_messages").insert(inbound);
  if (inboundInsert.error) throw inboundInsert.error;

  const outbound = await service.from("outbound_messages").insert([
    {
      clinic_id: clinicId,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: "+96555555555",
      body_preview: "Successful reply",
      related_type: "manual",
      related_id: conversationId,
      status: "sent",
      created_at: new Date(start + 1_997 * 1_000 + 500).toISOString(),
    },
    {
      clinic_id: clinicId,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: "+96555555555",
      body_preview: "Failed later reply",
      related_type: "manual",
      related_id: conversationId,
      status: "failed",
      created_at: new Date(start + 2_001 * 1_000).toISOString(),
    },
  ]);
  if (outbound.error) throw outbound.error;

  receptionist = createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const login = await receptionist.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
}, 60_000);

afterAll(async () => {
  await receptionist?.auth.signOut();
  await cleanup();
}, 60_000);

describe("P3C inbox summary correctness", () => {
  it("derives the newest preview and unread count beyond the former global 2,000-row cap", async () => {
    const summary = await receptionist.rpc("get_inbox_conversation_summaries", {
      p_requested_conversation_id: conversationId,
      p_limit: 100,
    });
    expect(summary.error).toBeNull();
    expect(summary.data).toEqual([
      expect.objectContaining({
        id: conversationId,
        preview: "Failed later reply",
        last_inbound_at: "2026-07-17T10:33:20+00:00",
        unread_count: 3,
      }),
    ]);

    const [inbound, outbound] = await Promise.all([
      receptionist
        .from("inbound_messages")
        .select("id", { count: "exact" })
        .eq("conversation_id", conversationId),
      receptionist
        .from("outbound_messages")
        .select("id", { count: "exact" })
        .eq("related_type", "manual")
        .eq("related_id", conversationId),
    ]);
    expect(inbound.count).toBe(2_001);
    expect(outbound.count).toBe(2);
  });

  it("excludes non-WhatsApp conversations from recent and explicitly requested summaries", async () => {
    const summary = await receptionist.rpc("get_inbox_conversation_summaries", {
      p_requested_conversation_id: emailConversationId,
      p_limit: 1,
    });
    expect(summary.error).toBeNull();
    expect(summary.data?.map((conversation) => conversation.id)).toEqual([conversationId]);
    expect(summary.data?.every((conversation) => conversation.channel === "whatsapp")).toBe(true);
  });
});
