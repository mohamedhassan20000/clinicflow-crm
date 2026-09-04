import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// P3A two-clinic denial suite: every messaging_layer table is clinic-scoped,
// clinic_channels (which holds encrypted credentials) is unreadable even by
// its own clinic's members, and no authenticated session can write anywhere.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p3a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P3aTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const channelA = randomUUID();
const channelB = randomUUID();
const conversationA = randomUUID();
const conversationB = randomUUID();
const templateA = randomUUID();
const templateB = randomUUID();
const outboundA = randomUUID();
const outboundB = randomUUID();
const inboundA = randomUUID();
const inboundB = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
let adminA: Client;
let adminB: Client;
let receptionistA: Client;
let managerA: Client;
let doctorA: Client;
let anon: Client;

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p3a-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? `create ${label}`);
  userIds.push(data.user.id);
  const signedIn = client();
  const login = await signedIn.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client: signedIn };
}

async function cleanup() {
  await service.from("inbound_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("outbound_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("message_templates").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinic_channels").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  const [a, b, receptionist, manager, doctor] = await Promise.all([
    createUser("admin-a"),
    createUser("admin-b"),
    createUser("receptionist-a"),
    createUser("manager-a"),
    createUser("doctor-a"),
  ]);
  adminA = a.client;
  adminB = b.client;
  receptionistA = receptionist.client;
  managerA = manager.client;
  doctorA = doctor.client;
  anon = client();

  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P3A Clinic A ${suffix}` },
    { id: clinicB, name: `P3A Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: b.id, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
    { id: receptionist.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist" },
    { id: manager.id, clinic_id: clinicA, full_name: "Manager A", role: "manager" },
    { id: doctor.id, clinic_id: clinicA, full_name: "Doctor A", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;

  const channels = await service.from("clinic_channels").insert([
    {
      id: channelA,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      credentials_encrypted: `\\x01${"ab".repeat(40)}`,
      sender_identity: "CLINIC-A",
      status: "active",
    },
    {
      id: channelB,
      clinic_id: clinicB,
      channel: "email",
      provider: "resend",
      sender_identity: "care@clinic-b.example",
      status: "active",
    },
  ]);
  if (channels.error) throw channels.error;

  const conversations = await service.from("conversations").insert([
    { id: conversationA, clinic_id: clinicA, channel: "whatsapp" },
    { id: conversationB, clinic_id: clinicB, channel: "email" },
  ]);
  if (conversations.error) throw conversations.error;

  const templates = await service.from("message_templates").insert([
    {
      id: templateA,
      clinic_id: clinicA,
      channel: "whatsapp",
      name: "reminder",
      language: "ar",
      body: "تذكير بالموعد",
    },
    {
      id: templateB,
      clinic_id: clinicB,
      channel: "email",
      name: "reminder",
      language: "en",
      body: "Appointment reminder",
    },
  ]);
  if (templates.error) throw templates.error;

  const outbound = await service.from("outbound_messages").insert([
    {
      id: outboundA,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: "+96550000001",
      // A manual outbound row is only visible through the conversation it
      // belongs to, so `related_id` has to be the real one — the WhatsApp
      // account-scope policy resolves the conversation from it.
      related_type: "manual",
      related_id: conversationA,
      template_id: templateA,
    },
    {
      id: outboundB,
      clinic_id: clinicB,
      channel: "email",
      provider: "resend",
      recipient: "patient-b@example.com",
      related_type: "manual",
      related_id: conversationB,
    },
  ]);
  if (outbound.error) throw outbound.error;

  const inbound = await service.from("inbound_messages").insert([
    {
      id: inboundA,
      clinic_id: clinicA,
      channel: "whatsapp",
      sender: "+96550000001",
      conversation_id: conversationA,
      body: "أريد تأكيد موعدي",
      provider_message_id: `${suffix}-in-a`,
    },
    {
      id: inboundB,
      clinic_id: clinicB,
      channel: "email",
      sender: "patient-b@example.com",
      conversation_id: conversationB,
      body: "Please confirm my appointment",
      provider_message_id: `${suffix}-in-b`,
    },
  ]);
  if (inbound.error) throw inbound.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(
    userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
  await Promise.all([
    adminA?.auth.signOut(),
    adminB?.auth.signOut(),
  ]);
}, 60_000);

describe("P3A messaging RLS", () => {
  it("lets inbox staff read their own content rows and nobody else's", async () => {
    for (const table of [
      "conversations",
      "message_templates",
      "outbound_messages",
      "inbound_messages",
    ] as const) {
      const own = await adminA.from(table).select("id, clinic_id");
      expect(own.error, `${table} own read`).toBeNull();
      expect(own.data?.length, `${table} own rows`).toBeGreaterThan(0);
      expect(
        own.data?.every((row) => row.clinic_id === clinicA),
        `${table} scoped to clinic A`,
      ).toBe(true);

      const cross = await adminB
        .from(table)
        .select("id")
        .eq("clinic_id", clinicA);
      expect(cross.error, `${table} cross read error`).toBeNull();
      expect(cross.data, `${table} cross read rows`).toEqual([]);
    }
  });

  it("denies message content and realtime source rows to Manager and Doctor roles", async () => {
    for (const roleClient of [managerA, doctorA]) {
      for (const table of [
        "conversations",
        "message_templates",
        "outbound_messages",
        "inbound_messages",
      ] as const) {
        const denied = await roleClient.from(table).select("id");
        expect(denied.error, `${table} denied read error`).toBeNull();
        expect(denied.data, `${table} denied rows`).toEqual([]);
      }
    }

    for (const table of [
      "conversations",
      "message_templates",
      "outbound_messages",
      "inbound_messages",
    ] as const) {
      const allowed = await receptionistA.from(table).select("id");
      expect(allowed.error, `${table} receptionist read`).toBeNull();
      expect(allowed.data?.length, `${table} receptionist rows`).toBeGreaterThan(0);
    }
  });

  it("hides clinic_channels (credential store) from every authenticated session", async () => {
    const ownAttempt = await adminA.from("clinic_channels").select("id");
    expect(ownAttempt.error).toBeNull();
    expect(ownAttempt.data).toEqual([]);

    const crossAttempt = await adminB.from("clinic_channels").select("id, credentials_encrypted");
    expect(crossAttempt.error).toBeNull();
    expect(crossAttempt.data).toEqual([]);
  });

  it("denies anonymous access to every messaging table", async () => {
    for (const table of [
      "clinic_channels",
      "conversations",
      "message_templates",
      "outbound_messages",
      "inbound_messages",
    ] as const) {
      const result = await anon.from(table).select("id");
      expect(result.data ?? [], `${table} anon rows`).toEqual([]);
    }
  });

  it("denies authenticated writes on every messaging table", async () => {
    const insertAttempts = await Promise.all([
      adminA.from("clinic_channels").insert({
        clinic_id: clinicA,
        channel: "email",
        provider: "resend",
        sender_identity: "attacker@clinic-a.example",
      }),
      adminA.from("conversations").insert({ clinic_id: clinicA, channel: "whatsapp" }),
      adminA.from("message_templates").insert({
        clinic_id: clinicA,
        channel: "whatsapp",
        name: "attacker",
        language: "en",
        body: "x",
      }),
      adminA.from("outbound_messages").insert({
        clinic_id: clinicA,
        channel: "whatsapp",
        provider: "dialog360",
        recipient: "+96550000009",
        related_type: "manual",
      }),
      adminA.from("inbound_messages").insert({
        clinic_id: clinicA,
        channel: "whatsapp",
        sender: "+96550000009",
        conversation_id: conversationA,
        body: "forged",
      }),
    ]);
    for (const attempt of insertAttempts) {
      expect(attempt.error).not.toBeNull();
    }

    const update = await adminA
      .from("outbound_messages")
      .update({ status: "delivered" })
      .eq("id", outboundA)
      .select("id");
    expect(update.data ?? []).toEqual([]);

    const del = await adminA
      .from("conversations")
      .delete()
      .eq("id", conversationA)
      .select("id");
    expect(del.data ?? []).toEqual([]);
  });

  it("enforces cross-clinic integrity on composite foreign keys", async () => {
    // A conversation belonging to clinic B cannot anchor an inbound message
    // recorded for clinic A, even via the service role.
    const mismatch = await service.from("inbound_messages").insert({
      clinic_id: clinicA,
      channel: "email",
      sender: "attacker@example.com",
      conversation_id: conversationB,
      body: "cross-tenant",
    });
    expect(mismatch.error).not.toBeNull();

    const templateMismatch = await service.from("outbound_messages").insert({
      clinic_id: clinicA,
      channel: "email",
      provider: "resend",
      recipient: "x@example.com",
      related_type: "manual",
      template_id: templateB,
    });
    expect(templateMismatch.error).not.toBeNull();
  });

  it("rejects duplicate provider message ids per clinic (webhook replay)", async () => {
    const replay = await service.from("inbound_messages").insert({
      clinic_id: clinicA,
      channel: "whatsapp",
      sender: "+96550000001",
      conversation_id: conversationA,
      body: "replayed",
      provider_message_id: `${suffix}-in-a`,
    });
    expect(replay.error).not.toBeNull();
  });

  it("seeded messaging limits into the plan catalog", async () => {
    const plans = await service
      .from("plans")
      .select("slug, limits")
      .in("slug", ["basic", "pro", "pro_ai"]);
    expect(plans.error).toBeNull();
    for (const plan of plans.data ?? []) {
      const limits = plan.limits as Record<string, number>;
      expect(limits.emails_month, `${plan.slug} emails_month`).toBeGreaterThan(0);
      expect(limits.wa_messages_month, `${plan.slug} wa`).toBeGreaterThanOrEqual(0);
    }
  });
});
