/**
 * P11S — the Inbox stays loaded across a whole assistant conversation episode,
 * and `get_inbox_conversation_summaries` keeps exactly the boundary its RLS
 * policies used to draw.
 *
 * ## What broke
 *
 * `/inbox` intermittently rendered "The inbox could not be loaded", and it did
 * so right after a patient message and an assistant reply. The RPC was
 * `security invoker`, so the three inbox RLS policies were re-evaluated per row
 * inside every per-conversation lateral — `auth_clinic_id()` and `auth_role()`
 * are SECURITY DEFINER and therefore never inlined or folded into an index
 * condition. On the production clinic that cost 6,194 ms under `authenticated`
 * against 24 ms as `service_role`, and Supabase caps `authenticated` at an 8 s
 * `statement_timeout`. Every turn added rows to the two tables the laterals
 * walk, so the Inbox got closer to the cliff with each message until one turn
 * went over it and PostgREST returned 57014.
 *
 * Two properties are pinned here, and the second is the one that makes the
 * first safe:
 *
 *   1. the Inbox loads through inbound → assistant reply → Done → reopened
 *      episode, with history intact across the boundary;
 *   2. SECURITY DEFINER did not widen anything — another clinic's admin and a
 *      doctor in this clinic still see nothing.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const anonKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let staffClient: ReturnType<typeof createClient<Database>>;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => staffClient,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

const suffix = `p11s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const staffId = randomUUID();
const patientId = randomUUID();
const conversationId = randomUUID();
const sender = `+2014${String(Date.now()).slice(-8)}`;
const email = `${suffix}@example.test`;
const password = "P11SInbox12345!";

async function cleanup() {
  await service.from("ai_suggested_replies").delete().eq("clinic_id", clinicId);
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
  let r: { error: unknown } = await service.from("clinics").insert({ id: clinicId, name: `P11S ${suffix}`, country: "EG" });
  if (r.error) throw r.error;
  r = await service.from("clinic_channels").insert({
    clinic_id: clinicId, channel: "whatsapp", provider: "linked_device",
    sender_identity: `p11s${Date.now()}`, status: "active",
  });
  if (r.error) throw r.error;
  const auth = await service.auth.admin.createUser({ id: staffId, email, password, email_confirm: true });
  if (auth.error) throw auth.error;
  r = await service.from("profiles").insert({
    id: staffId, clinic_id: clinicId, full_name: "P11S Admin", role: "admin", must_change_password: false,
  });
  if (r.error) throw r.error;
  r = await service.from("patients").insert({
    id: patientId, clinic_id: clinicId, full_name: "Ahmed Nabil", phone: sender,
    email: `${suffix}-p@example.test`, date_of_birth: "1990-01-01",
    national_id: `29002${String(Date.now()).slice(-9)}`, file_number: `P11S-${suffix}`, created_by: staffId,
  });
  if (r.error) throw r.error;
  r = await service.from("conversations").insert({
    id: conversationId, clinic_id: clinicId, channel: "whatsapp", participant_address: sender,
    patient_id: patientId, patient_link_status: "automatic", display_name: "Ahmed", status: "open",
    last_message_at: new Date().toISOString(),
  });
  if (r.error) throw r.error;

  staffClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const session = await staffClient.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;
});

afterAll(cleanup);

const user = { id: staffId, clinicId, role: "admin" } as never;

async function inbound(body: string, at: string) {
  const r = await service.from("inbound_messages").insert({
    clinic_id: clinicId, conversation_id: conversationId, channel: "whatsapp",
    sender, body, provider_message_id: `${suffix}-${at}`, received_at: at,
  });
  if (r.error) throw r.error;
  await service.from("conversations").update({ last_message_at: at, status: "open" }).eq("id", conversationId);
}

async function assistantReply(body: string, at: string) {
  const r = await service.from("outbound_messages").insert({
    clinic_id: clinicId, channel: "whatsapp", provider: "linked_device", recipient: sender,
    body, body_preview: body.slice(0, 120), related_type: "manual", related_id: conversationId,
    status: "sent", created_at: at,
  }).select("id").single();
  if (r.error) throw r.error;
  const s = await service.from("ai_suggested_replies").insert({
    clinic_id: clinicId, conversation_id: conversationId, body, status: "sent",
    escalate: false, outbound_message_id: r.data.id, mode: "auto",
  });
  if (s.error) throw s.error;
  await service.from("conversations").update({ last_message_at: at, ai_last_replied_at: at }).eq("id", conversationId);
}

describe("P11S — the Inbox survives the whole assistant conversation lifecycle", () => {
  it("stays loaded across inbound, assistant reply, Done and a reopened episode", async () => {
    const { loadInboxData } = await import("@/lib/messaging/inbox");

    const initial = await loadInboxData(user, conversationId);
    expect(initial.error).toBe(false);

    await inbound("السلام عليكم", "2026-09-01T09:00:00.000Z");
    const afterInbound = await loadInboxData(user, conversationId);
    expect(afterInbound.error).toBe(false);
    expect(afterInbound.messages.length).toBe(1);

    await assistantReply("أهلًا وسهلًا بك", "2026-09-01T09:00:30.000Z");
    const afterReply = await loadInboxData(user, conversationId);
    expect(afterReply.error).toBe(false);
    expect(afterReply.messages.length).toBe(2);

    const { closeAndResetConversation } = await import("@/lib/ai/conversation-reset");
    const closed = await closeAndResetConversation({
      clinicId, conversationId, reason: "assistant_close",
    });
    expect(closed.ok).toBe(true);
    const afterClose = await loadInboxData(user, conversationId);
    expect(afterClose.error).toBe(false);
    expect(afterClose.conversations[0]?.status).toBe("closed");

    await inbound("عايز أحجز موعد", "2026-09-01T10:00:00.000Z");
    const afterReopen = await loadInboxData(user, conversationId);
    expect(afterReopen.error).toBe(false);
    expect(afterReopen.messages.length).toBe(3);
  }, 120_000);
});

describe("P11S — the summaries RPC keeps its authorization boundary under SECURITY DEFINER", () => {
  const otherClinicId = randomUUID();
  const otherStaffId = randomUUID();
  const doctorId = randomUUID();
  const otherEmail = `${suffix}-other@example.test`;
  const doctorEmail = `${suffix}-doctor@example.test`;

  beforeAll(async () => {
    let r: { error: unknown } = await service
      .from("clinics")
      .insert({ id: otherClinicId, name: `P11S other ${suffix}`, country: "EG" });
    if (r.error) throw r.error;
    const otherAuth = await service.auth.admin.createUser({
      id: otherStaffId, email: otherEmail, password, email_confirm: true,
    });
    if (otherAuth.error) throw otherAuth.error;
    r = await service.from("profiles").insert({
      id: otherStaffId, clinic_id: otherClinicId, full_name: "Other Admin",
      role: "admin", must_change_password: false,
    });
    if (r.error) throw r.error;
    const doctorAuth = await service.auth.admin.createUser({
      id: doctorId, email: doctorEmail, password, email_confirm: true,
    });
    if (doctorAuth.error) throw doctorAuth.error;
    r = await service.from("profiles").insert({
      id: doctorId, clinic_id: clinicId, full_name: "P11S Doctor",
      role: "doctor", must_change_password: false,
    });
    if (r.error) throw r.error;
  });

  afterAll(async () => {
    await service.from("profiles").delete().eq("id", otherStaffId);
    await service.from("profiles").delete().eq("id", doctorId);
    await service.auth.admin.deleteUser(otherStaffId).catch(() => undefined);
    await service.auth.admin.deleteUser(doctorId).catch(() => undefined);
    await service.from("clinics").delete().eq("id", otherClinicId);
  });

  async function summariesAs(userEmail: string) {
    const client = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
    const session = await client.auth.signInWithPassword({ email: userEmail, password });
    if (session.error) throw session.error;
    const result = await client.rpc("get_inbox_conversation_summaries", { p_limit: 100 });
    if (result.error) throw result.error;
    return result.data ?? [];
  }

  it("returns this clinic's threads to its own admin", async () => {
    const rows = await summariesAs(email);
    expect(rows.map((row) => row.id)).toContain(conversationId);
  });

  it("returns nothing to an admin of a different clinic", async () => {
    const rows = await summariesAs(otherEmail);
    expect(rows.map((row) => row.id)).not.toContain(conversationId);
    expect(rows).toHaveLength(0);
  });

  it("returns nothing to a doctor in the same clinic — the Inbox is admin/receptionist only", async () => {
    const rows = await summariesAs(doctorEmail);
    expect(rows).toHaveLength(0);
  });
});
