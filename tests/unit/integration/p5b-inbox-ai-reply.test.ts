import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

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
type Client = SupabaseClient<Database>;

// The orchestrator uses the app's clinic-scoped admin client, which reads these.
const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const previousServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;

const suffix = `p5b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P5bInboxAi12345!";
const clinicA = randomUUID();
const clinicB = randomUUID();
const adminAId = randomUUID();
const adminBId = randomUUID();
const patientA = randomUUID();
const conversationA = randomUUID();
const conversationEsc = randomUUID();
const userIds = [adminAId, adminBId];
let adminA: Client;
let adminB: Client;
let anon: Client;

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p5b-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createAuthUser(id: string, label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({ id, email, password, email_confirm: true });
  if (created.error) throw created.error;
  return email;
}

async function cleanup() {
  await service.from("ai_suggested_replies").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("inbound_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("audit_logs").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("patients").delete().in("id", [patientA]);
  await service.from("ai_commercial_terms").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)));
}

beforeAll(async () => {
  await cleanup();
  const [adminAEmail, adminBEmail] = await Promise.all([
    createAuthUser(adminAId, "admin-a"),
    createAuthUser(adminBId, "admin-b"),
  ]);
  adminA = client();
  adminB = client();
  anon = client();
  const [signInA, signInB] = await Promise.all([
    adminA.auth.signInWithPassword({ email: adminAEmail, password }),
    adminB.auth.signInWithPassword({ email: adminBEmail, password }),
  ]);
  if (signInA.error) throw signInA.error;
  if (signInB.error) throw signInB.error;

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P5B Clinic A ${suffix}`, timezone: "Asia/Kuwait", country: "KW", ai_reply_mode: "suggest" },
    { id: clinicB, name: `P5B Clinic B ${suffix}`, timezone: "Asia/Kuwait", country: "KW", ai_reply_mode: "suggest" },
  ]);
  if (clinics.error) throw clinics.error;

  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  const subs = await service.from("subscriptions").insert([
    { clinic_id: clinicA, plan_id: plan.data.id, status: "trialing", trial_ends_at: "2035-01-01T00:00:00Z" },
    { clinic_id: clinicB, plan_id: plan.data.id, status: "trialing", trial_ends_at: "2035-01-01T00:00:00Z" },
  ]);
  if (subs.error) throw subs.error;

  const profiles = await service.from("profiles").insert([
    { id: adminAId, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: adminBId, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
  ]);
  if (profiles.error) throw profiles.error;

  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinicA, change_reason: "pilot", updated_by: adminAId, accepted_at: new Date().toISOString() },
    { clinic_id: clinicB, change_reason: "pilot", updated_by: adminBId, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;

  const patients = await service.from("patients").insert([
    {
      id: patientA,
      clinic_id: clinicA,
      full_name: "Patient A",
      date_of_birth: "1990-01-01",
      phone: "+96550009001",
      email: `${suffix}-a@example.com`,
      national_id: `${Date.now()}91`,
      file_number: `${suffix}-a`,
      created_by: adminAId,
    },
  ]);
  if (patients.error) throw patients.error;

  const conversations = await service.from("conversations").insert([
    { id: conversationA, clinic_id: clinicA, patient_id: patientA, channel: "whatsapp", participant_address: "+96550009001" },
    { id: conversationEsc, clinic_id: clinicA, patient_id: patientA, channel: "whatsapp", participant_address: "+96550009002" },
  ]);
  if (conversations.error) throw conversations.error;

  const inbound = await service.from("inbound_messages").insert([
    { clinic_id: clinicA, conversation_id: conversationA, channel: "whatsapp", sender: "+96550009001", body: "what are your opening hours?", provider_message_id: "wamid-a-1" },
    { clinic_id: clinicA, conversation_id: conversationEsc, channel: "whatsapp", sender: "+96550009002", body: "I have severe chest pain", provider_message_id: "wamid-esc-1" },
  ]);
  if (inbound.error) throw inbound.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all([adminA?.auth.signOut(), adminB?.auth.signOut(), anon?.auth.signOut()]);
  if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
  if (previousServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
}, 60_000);

describe("P5B suggest-mode orchestration against the live database", () => {
  it("records a pending suggestion for an entitled clinic and notifies staff", async () => {
    const { runPatientInboundAiReply } = await import("@/lib/ai/patient-reply");
    const outcome = await runPatientInboundAiReply(
      {
        clinicId: clinicA,
        conversationId: conversationA,
        providerMessageId: "wamid-a-1",
        messageText: "what are your opening hours?",
      },
      { runAgent: async () => ({ ok: true, text: "We are open 9am to 5pm, Sunday to Thursday." }) },
    );
    expect(outcome.status).toBe("suggested");

    const row = await service
      .from("ai_suggested_replies")
      .select("status, mode, escalate, inbound_message_id, body")
      .eq("conversation_id", conversationA)
      .eq("status", "pending")
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({ status: "pending", mode: "suggest", escalate: false });
    expect(row.data?.inbound_message_id).not.toBeNull();
  });

  it("escalates an emergency and stamps the conversation handoff reason", async () => {
    const { runPatientInboundAiReply } = await import("@/lib/ai/patient-reply");
    const outcome = await runPatientInboundAiReply(
      {
        clinicId: clinicA,
        conversationId: conversationEsc,
        providerMessageId: "wamid-esc-1",
        messageText: "I have severe chest pain",
      },
      { runAgent: async () => ({ ok: true, text: "should not be used" }) },
    );
    expect(outcome).toMatchObject({ status: "escalated", reason: "emergency" });

    const conversation = await service
      .from("conversations")
      .select("ai_escalated_at, ai_escalation_reason")
      .eq("id", conversationEsc)
      .single();
    expect(conversation.data?.ai_escalated_at).not.toBeNull();
    expect(conversation.data?.ai_escalation_reason).toBe("emergency");
  });
});

describe("P5B ai_suggested_replies tenant isolation and write posture", () => {
  it("lets the owning clinic's inbox read its suggestions but denies cross-tenant reads", async () => {
    const own = await adminA
      .from("ai_suggested_replies")
      .select("id, conversation_id")
      .eq("conversation_id", conversationA);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBeGreaterThanOrEqual(1);

    const crossed = await adminB
      .from("ai_suggested_replies")
      .select("id")
      .eq("conversation_id", conversationA);
    expect(crossed.data ?? []).toEqual([]);
  });

  it("rejects authenticated and anonymous inserts (service-role write only)", async () => {
    for (const db of [adminA, anon]) {
      const denied = await db.from("ai_suggested_replies").insert({
        clinic_id: clinicA,
        conversation_id: conversationA,
        mode: "suggest",
        body: "forged suggestion",
      });
      expect(denied.error).not.toBeNull();
    }
  });
});
