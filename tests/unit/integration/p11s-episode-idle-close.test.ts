/**
 * P11S — the five-minute idle close, against a real database.
 *
 * The unit layer can prove when the timer is *armed*. Only a database can prove
 * the three properties that make arming it safe:
 *
 *   1. an expired timer on a finished episode ends it, and resets exactly the
 *      episode state — never a message, never the patient linkage;
 *   2. a patient who wrote after the timer was armed is never closed, even
 *      though the row still carries the deadline. This is the stale-timer
 *      hazard, and the guard is `ai_auto_close_armed_at` rather than a race the
 *      clearing write has to win;
 *   3. a second sweep in the same minute does nothing, because the first one
 *      cleared the deadline it acted on.
 *
 * A fourth is asserted here because it is the failure mode the requirement
 * warns about explicitly: an escalated or human-held thread is not closed by
 * this, whatever its timer says.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

const suffix = `p11s-idle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const staffId = randomUUID();
const patientId = randomUUID();
const sender = `+2015${String(Date.now()).slice(-8)}`;
let conversationId = "";

async function cleanup() {
  await service.from("ai_suggested_replies").delete().eq("clinic_id", clinicId);
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("outbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("id", staffId);
  await service.auth.admin.deleteUser(staffId).catch(() => undefined);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  await cleanup();
  let r: { error: unknown } = await service
    .from("clinics")
    .insert({ id: clinicId, name: `P11S idle ${suffix}`, country: "EG" });
  if (r.error) throw r.error;
  const auth = await service.auth.admin.createUser({
    id: staffId, email: `${suffix}@example.test`, password: "P11SIdle12345!", email_confirm: true,
  });
  if (auth.error) throw auth.error;
  r = await service.from("profiles").insert({
    id: staffId, clinic_id: clinicId, full_name: "P11S Admin", role: "admin",
    must_change_password: false,
  });
  if (r.error) throw r.error;
  r = await service.from("patients").insert({
    id: patientId, clinic_id: clinicId, full_name: "Ahmed Nabil", phone: sender,
    email: `${suffix}-p@example.test`, date_of_birth: "1990-01-01",
    national_id: `29003${String(Date.now()).slice(-9)}`, file_number: `P11SI-${suffix}`,
    created_by: staffId,
  });
  if (r.error) throw r.error;
});

afterAll(cleanup);

const OFFER_AT = "2026-09-01T10:00:00.000Z";
/** Five minutes and one second after the offer. */
const PAST_DEADLINE = new Date(Date.parse(OFFER_AT) + 5 * 60_000 + 1_000);

beforeEach(async () => {
  await service.from("ai_suggested_replies").delete().eq("clinic_id", clinicId);
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("outbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  conversationId = randomUUID();
  const conversation = await service.from("conversations").insert({
    id: conversationId, clinic_id: clinicId, channel: "whatsapp",
    participant_address: sender, patient_id: patientId, patient_link_status: "automatic",
    status: "open", identity_verified_at: OFFER_AT,
    ai_collected_data: { department_id: randomUUID() },
    last_message_at: OFFER_AT,
  });
  if (conversation.error) throw conversation.error;
  const inbound = await service.from("inbound_messages").insert({
    clinic_id: clinicId, conversation_id: conversationId, channel: "whatsapp",
    sender, body: "شكرا على المعلومة", provider_message_id: `${suffix}-${conversationId}-in`,
    received_at: "2026-09-01T09:59:00.000Z",
  });
  if (inbound.error) throw inbound.error;
});

async function arm() {
  const { armEpisodeIdleClose } = await import("@/lib/ai/conversation-auto-close");
  return armEpisodeIdleClose({
    clinicId, conversationId, now: new Date(OFFER_AT),
  });
}

async function sweep(at: Date) {
  const { sweepIdlePatientEpisodes } = await import("@/lib/ai/conversation-auto-close");
  return sweepIdlePatientEpisodes(at);
}

async function conversationRow() {
  const result = await service
    .from("conversations")
    .select("status, patient_id, identity_verified_at, ai_collected_data, ai_context_reset_at, ai_auto_close_after")
    .eq("id", conversationId)
    .single();
  if (result.error) throw result.error;
  return result.data;
}

describe("P11S — five-minute idle close", () => {
  it("ends a finished episode five minutes after the final offer goes unanswered", async () => {
    expect(await arm()).toBe(true);

    // Four minutes in, nothing happens: the deadline has not passed.
    const early = await sweep(new Date(Date.parse(OFFER_AT) + 4 * 60_000));
    expect(early).toBe(0);
    expect((await conversationRow()).status).toBe("open");

    expect(await sweep(PAST_DEADLINE)).toBe(1);
    const closed = await conversationRow();
    expect(closed.status).toBe("closed");
    // The episode is forgotten; the person is not.
    expect(closed.ai_collected_data).toEqual({});
    expect(closed.ai_context_reset_at).not.toBeNull();
    expect(closed.patient_id).toBe(patientId);
    expect(closed.identity_verified_at).not.toBeNull();
  });

  it("keeps every message — Done never deletes history", async () => {
    await arm();
    await sweep(PAST_DEADLINE);
    const messages = await service
      .from("inbound_messages")
      .select("id")
      .eq("conversation_id", conversationId);
    expect(messages.error).toBeNull();
    expect(messages.data).toHaveLength(1);
  });

  it("never closes a thread the patient wrote on after the timer was armed", async () => {
    await arm();
    const inbound = await service.from("inbound_messages").insert({
      clinic_id: clinicId, conversation_id: conversationId, channel: "whatsapp",
      sender, body: "لحظة، عندي سؤال تاني",
      provider_message_id: `${suffix}-${conversationId}-late`,
      // After arming, before the deadline — the exact window the stale timer
      // would have closed through.
      received_at: new Date(Date.parse(OFFER_AT) + 2 * 60_000).toISOString(),
    });
    if (inbound.error) throw inbound.error;

    // Deliberately does NOT clear the timer first: the guard must hold on the
    // data alone, so that a lost clearing write cannot end a live conversation.
    expect(await sweep(PAST_DEADLINE)).toBe(0);
    expect((await conversationRow()).status).toBe("open");
  });

  it("is idempotent — a second sweep in the same minute closes nothing", async () => {
    await arm();
    expect(await sweep(PAST_DEADLINE)).toBe(1);
    expect(await sweep(PAST_DEADLINE)).toBe(0);
  });

  it("closes nothing when no timer was ever armed, however long the thread is quiet", async () => {
    expect(await sweep(new Date(Date.parse(OFFER_AT) + 60 * 60_000))).toBe(0);
    expect((await conversationRow()).status).toBe("open");
  });

  it("leaves an escalated thread to the human it was handed to", async () => {
    await arm();
    const escalated = await service
      .from("conversations")
      .update({ ai_escalated_at: OFFER_AT, ai_escalation_reason: "human_requested" })
      .eq("id", conversationId);
    if (escalated.error) throw escalated.error;
    expect(await sweep(PAST_DEADLINE)).toBe(0);
    expect((await conversationRow()).status).toBe("open");
  });

  it("leaves a thread a staff member has taken over", async () => {
    await arm();
    const paused = await service
      .from("conversations")
      .update({ ai_paused_at: OFFER_AT, ai_paused_by: staffId })
      .eq("id", conversationId);
    if (paused.error) throw paused.error;
    expect(await sweep(PAST_DEADLINE)).toBe(0);
    expect((await conversationRow()).status).toBe("open");
  });

  it("disarms when the patient's next turn begins", async () => {
    const { clearEpisodeIdleClose } = await import("@/lib/ai/conversation-auto-close");
    await arm();
    await clearEpisodeIdleClose({ clinicId, conversationId });
    expect((await conversationRow()).ai_auto_close_after).toBeNull();
    expect(await sweep(PAST_DEADLINE)).toBe(0);
  });

  it("is disarmed by the episode reset, so it cannot fire against the next episode", async () => {
    const { resetConversationAssistantState } = await import("@/lib/ai/conversation-reset");
    await arm();
    await resetConversationAssistantState({
      clinicId, conversationId, reason: "manual_close",
    });
    expect((await conversationRow()).ai_auto_close_after).toBeNull();
    expect(await sweep(PAST_DEADLINE)).toBe(0);
  });
});
