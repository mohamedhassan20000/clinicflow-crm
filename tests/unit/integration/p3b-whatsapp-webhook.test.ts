import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findClinicChannelForWebhook } from "@/lib/supabase/admin";
import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";
import type { Database } from "@/types/database";

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
const suffix = `p3b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicA = randomUUID();
const clinicB = randomUUID();
const phoneNumberA = `10${Date.now()}`;
const phoneNumberB = `20${Date.now()}`;
const sender = "+96551111111";
const providerMessageId = `${suffix}-same-provider-message`;
const outboundProviderId = `${suffix}-outbound`;
const outboundProviderIdB = `${suffix}-outbound-b`;
const templateProviderId = `${suffix}-template`;
const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const previousServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const staffUserId = randomUUID();
const linkedPatientId = randomUUID();

async function cleanup() {
  await service.from("inbound_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("outbound_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("patients").delete().eq("id", linkedPatientId);
  await service.from("profiles").delete().eq("id", staffUserId);
  await service.from("message_templates").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinic_channels").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await service.auth.admin.deleteUser(staffUserId);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P3B Clinic A ${suffix}` },
    { id: clinicB, name: `P3B Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const channels = await service.from("clinic_channels").insert([
    { clinic_id: clinicA, channel: "whatsapp", provider: "dialog360", sender_identity: phoneNumberA, status: "active" },
    { clinic_id: clinicB, channel: "whatsapp", provider: "dialog360", sender_identity: phoneNumberB, status: "active" },
  ]);
  if (channels.error) throw channels.error;
  const authUser = await service.auth.admin.createUser({
    id: staffUserId,
    email: `${suffix}-staff@example.com`,
    password: "P3bIntegration123!",
    email_confirm: true,
  });
  if (authUser.error) throw authUser.error;
  const profile = await service.from("profiles").insert({
    id: staffUserId,
    clinic_id: clinicA,
    full_name: "P3B Inbox Owner",
    role: "receptionist",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;
  const patient = await service.from("patients").insert({
    id: linkedPatientId,
    clinic_id: clinicA,
    full_name: "Manually Linked Patient",
    national_id: `${Date.now()}P3B`,
    date_of_birth: "1990-01-01",
    phone: "+96552222222",
    email: `${suffix}-patient@example.com`,
    file_number: `${suffix}-P`,
    created_by: staffUserId,
  });
  if (patient.error) throw patient.error;
  const template = await service.from("message_templates").insert({
    clinic_id: clinicA,
    channel: "whatsapp",
    name: `${suffix}_reminder`,
    language: "en",
    body: "Appointment reminder",
    provider_template_id: templateProviderId,
    approval_status: "submitted",
  });
  if (template.error) throw template.error;
  const outbound = await service.from("outbound_messages").insert([
    {
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      provider_message_id: outboundProviderId,
      status: "sent",
    },
    {
      clinic_id: clinicB,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      provider_message_id: outboundProviderIdB,
      status: "sent",
    },
  ]);
  if (outbound.error) throw outbound.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  if (previousSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
  if (previousServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
}, 60_000);

describe("P3B WhatsApp webhook persistence", () => {
  it("routes identical inbound identities to the owning clinic and ignores replay", async () => {
    for (const [phoneNumberId, expectedClinic] of [[phoneNumberA, clinicA], [phoneNumberB, clinicB]] as const) {
      const owner = await findClinicChannelForWebhook("dialog360", phoneNumberId);
      expect(owner.error).toBeNull();
      expect(owner.data?.clinic_id).toBe(expectedClinic);
      const summary = await processMessagingWebhookEvents({
        provider: "dialog360",
        clinicId: owner.data!.clinic_id,
        events: [{
          kind: "inbound",
          phoneNumberId,
          sender,
          providerMessageId,
          body: "Please confirm my appointment",
          receivedAt: "2026-07-17T09:00:00.000Z",
        }],
      });
      expect(summary.inbound).toBe(1);
    }

    const replay = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender,
        providerMessageId,
        body: "Please confirm my appointment",
        receivedAt: "2026-07-17T09:00:00.000Z",
      }],
    });
    expect(replay).toMatchObject({ inbound: 0, replays: 1 });

    for (const clinicId of [clinicA, clinicB]) {
      const rows = await service.from("inbound_messages").select("clinic_id, sender, provider_message_id").eq("clinic_id", clinicId);
      expect(rows.error).toBeNull();
      expect(rows.data).toEqual([{ clinic_id: clinicId, sender, provider_message_id: providerMessageId }]);
    }
  });

  it("serializes concurrent first-contact events into one sender thread", async () => {
    const concurrentSender = "+96553333333";
    const event = (suffixPart: string) => processMessagingWebhookEvents({
      provider: "dialog360" as const,
      clinicId: clinicA,
      events: [{
        kind: "inbound" as const,
        phoneNumberId: phoneNumberA,
        sender: concurrentSender,
        providerMessageId: `${providerMessageId}-${suffixPart}`,
        body: `Concurrent ${suffixPart}`,
        receivedAt: `2026-07-17T09:0${suffixPart}:00.000Z`,
      }],
    });

    const results = await Promise.all([event("1"), event("2")]);
    expect(results.map((result) => result.inbound)).toEqual([1, 1]);

    const [conversations, messages] = await Promise.all([
      service
        .from("conversations")
        .select("id")
        .eq("clinic_id", clinicA)
        .eq("participant_address", concurrentSender),
      service
        .from("inbound_messages")
        .select("id")
        .eq("clinic_id", clinicA)
        .eq("sender", concurrentSender),
    ]);
    expect(conversations.data).toHaveLength(1);
    expect(messages.data).toHaveLength(2);
  });

  it("syncs delivery and template approval status without allowing regression", async () => {
    await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [
        { kind: "status", providerMessageId: outboundProviderId, status: "delivered", error: null, occurredAt: "2026-07-17T09:05:00.000Z" },
        { kind: "template_status", providerTemplateId: templateProviderId, name: "reminder", language: "en", status: "approved" },
      ],
    });
    await processMessagingWebhookEvents({
      provider: "dialog360",
      events: [{ kind: "status", providerMessageId: outboundProviderId, status: "sent", error: null, occurredAt: "2026-07-17T09:04:00.000Z" }],
    });
    const crossClinic = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{ kind: "status", providerMessageId: outboundProviderIdB, status: "delivered", error: null, occurredAt: "2026-07-17T09:06:00.000Z" }],
    });
    expect(crossClinic).toMatchObject({ statuses: 0, ignored: 1 });

    const [outbound, otherClinicOutbound, template] = await Promise.all([
      service.from("outbound_messages").select("status").eq("provider_message_id", outboundProviderId).single(),
      service.from("outbound_messages").select("status").eq("provider_message_id", outboundProviderIdB).single(),
      service.from("message_templates").select("approval_status").eq("provider_template_id", templateProviderId).single(),
    ]);
    expect(outbound.error).toBeNull();
    expect(outbound.data?.status).toBe("delivered");
    expect(otherClinicOutbound.error).toBeNull();
    expect(otherClinicOutbound.data?.status).toBe("sent");
    expect(template.error).toBeNull();
    expect(template.data?.approval_status).toBe("approved");
  });

  it("repairs a lost immediate provider correlation from the callback reference", async () => {
    const outboundId = randomUUID();
    const providerId = `${suffix}-recovered-outbound`;
    const inserted = await service.from("outbound_messages").insert({
      id: outboundId,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      status: "queued",
    });
    expect(inserted.error).toBeNull();

    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "status",
        providerMessageId: providerId,
        clientReference: outboundId,
        status: "delivered",
        error: null,
        occurredAt: "2026-07-17T09:07:00.000Z",
      }],
    });
    expect(summary.statuses).toBe(1);

    const lateAcceptance = await service.rpc("finalize_outbound_message", {
      p_clinic_id: clinicA,
      p_outbound_message_id: outboundId,
      p_status: "sent",
      p_provider_message_id: providerId,
      p_error: null,
      p_cost_micro: null,
      p_occurred_at: "2026-07-17T09:06:00.000Z",
    });
    expect(lateAcceptance.data).toBe(true);

    const persisted = await service
      .from("outbound_messages")
      .select("provider_message_id, status")
      .eq("id", outboundId)
      .single();
    expect(persisted.data).toEqual({
      provider_message_id: providerId,
      status: "delivered",
    });
  });

  it("keeps a provider callback authoritative when it arrives before local failure finalization", async () => {
    const outboundId = randomUUID();
    const providerId = `${suffix}-callback-before-local-failure`;
    const inserted = await service.from("outbound_messages").insert({
      id: outboundId,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      status: "queued",
    });
    expect(inserted.error).toBeNull();

    const callback = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "status",
        providerMessageId: providerId,
        clientReference: outboundId,
        status: "sent",
        error: null,
        occurredAt: "2026-07-17T09:11:00.000Z",
      }],
    });
    expect(callback.statuses).toBe(1);

    const localFailure = await service.rpc("finalize_outbound_message", {
      p_clinic_id: clinicA,
      p_outbound_message_id: outboundId,
      p_status: "failed",
      p_provider_message_id: null,
      p_error: "transport timeout",
      p_cost_micro: null,
      p_occurred_at: "2026-07-17T09:11:01.000Z",
    });
    expect(localFailure.data).toBe(true);

    const persisted = await service
      .from("outbound_messages")
      .select("provider_message_id, status, error")
      .eq("id", outboundId)
      .single();
    expect(persisted.data).toEqual({
      provider_message_id: providerId,
      status: "sent",
      error: null,
    });
  });

  it("recovers a locally failed send when the authenticated callback arrives later", async () => {
    const outboundId = randomUUID();
    const providerId = `${suffix}-local-failure-before-callback`;
    const inserted = await service.from("outbound_messages").insert({
      id: outboundId,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      status: "queued",
    });
    expect(inserted.error).toBeNull();

    const localFailure = await service.rpc("finalize_outbound_message", {
      p_clinic_id: clinicA,
      p_outbound_message_id: outboundId,
      p_status: "failed",
      p_provider_message_id: null,
      p_error: "network unavailable",
      p_cost_micro: null,
      p_occurred_at: "2026-07-17T09:12:00.000Z",
    });
    expect(localFailure.data).toBe(true);

    const callback = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "status",
        providerMessageId: providerId,
        clientReference: outboundId,
        status: "sent",
        error: null,
        occurredAt: "2026-07-17T09:12:01.000Z",
      }],
    });
    expect(callback.statuses).toBe(1);

    const persisted = await service
      .from("outbound_messages")
      .select("provider_message_id, status, error")
      .eq("id", outboundId)
      .single();
    expect(persisted.data).toEqual({
      provider_message_id: providerId,
      status: "sent",
      error: null,
    });
  });

  it("advances a repaired local failure through delivered and read callbacks", async () => {
    const outboundId = randomUUID();
    const providerId = `${suffix}-repaired-through-read`;
    const inserted = await service.from("outbound_messages").insert({
      id: outboundId,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      status: "queued",
    });
    expect(inserted.error).toBeNull();

    const localFailure = await service.rpc("finalize_outbound_message", {
      p_clinic_id: clinicA,
      p_outbound_message_id: outboundId,
      p_status: "failed",
      p_provider_message_id: null,
      p_error: "request timed out",
      p_cost_micro: null,
      p_occurred_at: "2026-07-17T09:13:00.000Z",
    });
    expect(localFailure.data).toBe(true);

    for (const [status, occurredAt, clientReference] of [
      ["sent", "2026-07-17T09:13:01.000Z", outboundId],
      ["delivered", "2026-07-17T09:13:02.000Z", undefined],
      ["read", "2026-07-17T09:13:03.000Z", undefined],
    ] as const) {
      const callback = await processMessagingWebhookEvents({
        provider: "dialog360",
        clinicId: clinicA,
        events: [{
          kind: "status",
          providerMessageId: providerId,
          clientReference,
          status,
          error: null,
          occurredAt,
        }],
      });
      expect(callback.statuses).toBe(1);
    }

    const persisted = await service
      .from("outbound_messages")
      .select("provider_message_id, status, error")
      .eq("id", outboundId)
      .single();
    expect(persisted.data).toEqual({
      provider_message_id: providerId,
      status: "read",
      error: null,
    });
  });

  it("keeps delivery status monotonic under concurrent callbacks", async () => {
    const providerId = `${suffix}-concurrent-status`;
    const inserted = await service.from("outbound_messages").insert({
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      recipient: sender,
      related_type: "manual",
      provider_message_id: providerId,
      status: "queued",
    });
    expect(inserted.error).toBeNull();

    await Promise.all([
      ["sent", "2026-07-17T09:08:00.000Z"],
      ["delivered", "2026-07-17T09:09:00.000Z"],
      ["read", "2026-07-17T09:10:00.000Z"],
    ].map(([status, occurredAt]) => processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "status",
        providerMessageId: providerId,
        status: status as "sent" | "delivered" | "read",
        error: null,
        occurredAt,
      }],
    })));

    const persisted = await service
      .from("outbound_messages")
      .select("status")
      .eq("provider_message_id", providerId)
      .single();
    expect(persisted.data?.status).toBe("read");
  });

  it("keeps conversation activity monotonic for delayed inbound events", async () => {
    const delayedSender = "+96554444444";
    await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender: delayedSender,
        providerMessageId: `${providerMessageId}-newer`,
        body: "Newer event",
        receivedAt: "2026-07-17T11:00:00.000Z",
      }],
    });
    const conversation = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", delayedSender)
      .single();
    expect(conversation.error).toBeNull();
    const closed = await service
      .from("conversations")
      .update({
        status: "closed",
        status_updated_at: "2026-07-17T12:00:00.000Z",
      })
      .eq("id", conversation.data!.id);
    expect(closed.error).toBeNull();

    await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender: delayedSender,
        providerMessageId: `${providerMessageId}-older`,
        body: "Delayed older event",
        receivedAt: "2026-07-17T10:00:00.000Z",
      }],
    });

    const persisted = await service
      .from("conversations")
      .select("status, last_message_at, window_expires_at")
      .eq("id", conversation.data!.id)
      .single();
    expect(persisted.data).toEqual({
      status: "closed",
      last_message_at: "2026-07-17T11:00:00+00:00",
      window_expires_at: "2026-07-18T11:00:00+00:00",
    });
  });

  it("preserves staff-reviewed patient ownership and assignment when a new inbound reopens the thread", async () => {
    const existing = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", sender)
      .single();
    expect(existing.error).toBeNull();
    const linked = await service.rpc("set_conversation_patient", {
      p_clinic_id: clinicA,
      p_conversation_id: existing.data!.id,
      p_patient_id: linkedPatientId,
    });
    expect(linked.data).toBe(true);
    const prepared = await service
      .from("conversations")
      .update({
        assigned_to: staffUserId,
        status: "closed",
        status_updated_at: "2026-07-17T09:30:00.000Z",
      })
      .eq("id", existing.data!.id);
    expect(prepared.error).toBeNull();

    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender,
        providerMessageId: `${providerMessageId}-after-triage`,
        body: "A new message after triage",
        receivedAt: "2026-07-17T10:00:00.000Z",
      }],
    });
    expect(summary.inbound).toBe(1);

    const [conversation, message, count] = await Promise.all([
      service
        .from("conversations")
        .select("patient_id, assigned_to, status")
        .eq("id", existing.data!.id)
        .single(),
      service
        .from("inbound_messages")
        .select("patient_id")
        .eq("provider_message_id", `${providerMessageId}-after-triage`)
        .single(),
      service
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicA)
        .eq("participant_address", sender),
    ]);
    expect(conversation.data).toEqual({
      patient_id: linkedPatientId,
      assigned_to: staffUserId,
      status: "open",
    });
    expect(message.data?.patient_id).toBe(linkedPatientId);
    expect(count.count).toBe(1);
  });

  it("preserves an explicit unlink even when the sender later matches a patient phone", async () => {
    const existing = await service
      .from("conversations")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("participant_address", sender)
      .single();
    const phoneUpdate = await service
      .from("patients")
      .update({ phone: sender })
      .eq("id", linkedPatientId);
    expect(phoneUpdate.error).toBeNull();
    const unlinked = await service.rpc("set_conversation_patient", {
      p_clinic_id: clinicA,
      p_conversation_id: existing.data!.id,
      p_patient_id: null,
    });
    expect(unlinked.data).toBe(true);

    await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId: clinicA,
      events: [{
        kind: "inbound",
        phoneNumberId: phoneNumberA,
        sender,
        providerMessageId: `${providerMessageId}-after-unlink`,
        body: "Keep me unlinked",
        receivedAt: "2026-07-17T13:00:00.000Z",
      }],
    });

    const [conversation, message] = await Promise.all([
      service
        .from("conversations")
        .select("patient_id, patient_link_status")
        .eq("id", existing.data!.id)
        .single(),
      service
        .from("inbound_messages")
        .select("patient_id")
        .eq("provider_message_id", `${providerMessageId}-after-unlink`)
        .single(),
    ]);
    expect(conversation.data).toEqual({
      patient_id: null,
      patient_link_status: "unlinked",
    });
    expect(message.data?.patient_id).toBeNull();
  });
});
