import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const clinicTimeZone = "Asia/Kuwait";
const DAY_MS = 86_400_000;
const testStartedAt = Date.now();

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
type CreatePendingActionBooking =
  typeof import("@/lib/booking/pending-workflow").createPendingActionBooking;

const suffix = `phase4-action-booking-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase4ActionBooking12345!";
const clinicId = randomUUID();
const adminId = randomUUID();
const doctorId = randomUUID();
const patientIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const patientConversationId = randomUUID();
const agentConversationId = randomUUID();
const userIds = [adminId, doctorId];
let admin: Client;
let adminUser: AuthedUser;
let createPendingActionBooking: CreatePendingActionBooking;

function futureClinicSlot(dayOffset: number, time = "12:00") {
  const futureDate = new Date(testStartedAt + dayOffset * DAY_MS);
  const clinicDate = formatInTimeZone(futureDate, clinicTimeZone, "yyyy-MM-dd");
  return fromZonedTime(`${clinicDate}T${time}:00`, clinicTimeZone).toISOString();
}

const bookingSlots = {
  confirmed: futureClinicSlot(30),
  directForgery: futureClinicSlot(31),
  wrongReceipt: futureClinicSlot(32),
  patientCap: futureClinicSlot(33),
  sharedSlotCap: futureClinicSlot(34),
};

function sessionClient() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `phase4-action-booking-${randomUUID()}`,
    },
  });
}

async function createAuthUser(id: string, label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    id,
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  return email;
}

async function createReceipt(actionId = "appointments.create_pending") {
  const receipt = await service.rpc("begin_ai_action_receipt", {
    p_clinic_id: clinicId,
    p_actor_id: adminId,
    p_conversation_id: agentConversationId,
    p_ai_request_id: null,
    p_action_id: actionId,
    p_risk_class: "normal",
    p_phase: "execute",
    p_input_digest: "a".repeat(64),
  });
  if (receipt.error || !receipt.data) {
    throw receipt.error ?? new Error("No action receipt returned");
  }
  return receipt.data;
}

function actionBooking(
  patientId: string,
  scheduledAt: string,
  actionReceiptId: string,
) {
  return createPendingActionBooking({
    supabase: admin,
    user: adminUser,
    booking: {
      patient_id: patientId,
      doctor_id: doctorId,
      scheduled_at: scheduledAt,
      duration_minutes: 30,
    },
    actionReceiptId,
  });
}

async function cleanup() {
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("ai_action_receipts").delete().eq("clinic_id", clinicId);
  await service.from("agent_conversations").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await Promise.all(
    userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
}

beforeAll(async () => {
  await cleanup();
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  ({ createPendingActionBooking } = await import(
    "@/lib/booking/pending-workflow"
  ));

  const adminEmail = await createAuthUser(adminId, "admin");
  await createAuthUser(doctorId, "doctor");
  admin = sessionClient();
  const signedIn = await admin.auth.signInWithPassword({
    email: adminEmail,
    password,
  });
  if (signedIn.error) throw signedIn.error;
  adminUser = {
    id: adminId,
    email: adminEmail,
    role: "admin",
    fullName: "Phase 4 Action Admin",
    avatarUrl: null,
    clinicId,
    departmentId: null,
    mustChangePassword: false,
  };

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Phase 4 Action Clinic ${suffix}`,
    timezone: clinicTimeZone,
    ai_pending_slot_cap: 2,
    ai_pending_booking_ttl_minutes: 1440,
  });
  if (clinic.error) throw clinic.error;
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  const subscription = await service.from("subscriptions").insert({
    clinic_id: clinicId,
    plan_id: plan.data.id,
    status: "trialing",
    trial_ends_at: new Date(testStartedAt + 365 * DAY_MS).toISOString(),
  });
  if (subscription.error) throw subscription.error;
  const profiles = await service.from("profiles").insert([
    { id: adminId, clinic_id: clinicId, full_name: "Phase 4 Action Admin", role: "admin" },
    { id: doctorId, clinic_id: clinicId, full_name: "Phase 4 Action Doctor", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;
  const terms = await service.from("ai_commercial_terms").insert({
    clinic_id: clinicId,
    change_reason: "pilot",
    updated_by: adminId,
    accepted_at: new Date().toISOString(),
  });
  if (terms.error) throw terms.error;
  const agentConversation = await service.from("agent_conversations").insert({
    id: agentConversationId,
    clinic_id: clinicId,
    user_id: adminId,
    persona: "doctor",
    locale: "en",
  });
  if (agentConversation.error) throw agentConversation.error;
  const [clinicHours, doctorSchedules] = await Promise.all([
    service.from("clinic_working_hours").insert(
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        clinic_id: clinicId,
        day_of_week: dayOfWeek,
        shift_start: "08:00",
        shift_end: "18:00",
      })),
    ),
    service.from("doctor_schedules").insert(
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        clinic_id: clinicId,
        doctor_id: doctorId,
        day_of_week: dayOfWeek,
        start_time: "08:00",
        end_time: "18:00",
        is_enabled: true,
      })),
    ),
  ]);
  if (clinicHours.error) throw clinicHours.error;
  if (doctorSchedules.error) throw doctorSchedules.error;
  const patients = await service.from("patients").insert(
    patientIds.map((id, index) => ({
      id,
      clinic_id: clinicId,
      full_name: `Phase 4 Action Patient ${index + 1}`,
      date_of_birth: `199${index}-01-01`,
      phone: `+96559990${String(index).padStart(3, "0")}`,
      email: `${suffix}-patient-${index}@example.com`,
      national_id: `${Date.now()}${index}`,
      file_number: `${suffix}-${index}`,
      created_by: adminId,
      assigned_doctor_id: doctorId,
    })),
  );
  if (patients.error) throw patients.error;
  const patientConversation = await service.from("conversations").insert({
    id: patientConversationId,
    clinic_id: clinicId,
    patient_id: patientIds[2],
    channel: "whatsapp",
    participant_address: "+96559990002",
  });
  if (patientConversation.error) throw patientConversation.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await admin?.auth.signOut();
}, 60_000);

describe("Phase 4 action-receipt pending booking and provenance RLS", () => {
  it("persists receipt provenance, replays idempotently, and blocks client tampering", async () => {
    const receiptId = await createReceipt();
    const created = await actionBooking(patientIds[0], bookingSlots.confirmed, receiptId);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(`Unexpected booking failure: ${created.reason}`);

    const row = await service.from("appointments")
      .select("id, ai_action_receipt_id, ai_workflow_run_id, ai_workflow_step_id, expires_at")
      .eq("id", created.appointmentId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      ai_action_receipt_id: receiptId,
      ai_workflow_run_id: null,
      ai_workflow_step_id: null,
    });
    expect(new Date(row.data!.expires_at!).getTime()).toBeGreaterThan(Date.now());

    await expect(actionBooking(patientIds[0], bookingSlots.confirmed, receiptId))
      .resolves.toMatchObject({ ok: true, appointmentId: created.appointmentId });

    const forgedReceipt = await admin.from("appointments")
      .update({ ai_action_receipt_id: randomUUID() })
      .eq("id", created.appointmentId);
    expect(forgedReceipt.error?.code).toBe("42501");
    expect(forgedReceipt.error?.message).toMatch(
      /AI_BOOKING_(?:ACTION_RECEIPT_MISMATCH|METADATA_SERVER_ONLY)/,
    );

    const forgedLegacyStep = await admin.from("appointments")
      .update({ ai_workflow_step_id: "forged_step" })
      .eq("id", created.appointmentId);
    expect(forgedLegacyStep.error?.code).toBe("42501");
    expect(forgedLegacyStep.error?.message).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
  });

  it("rejects a receipt for any action other than pending booking", async () => {
    const wrongReceipt = await createReceipt("assistant.reference_check");
    await expect(actionBooking(patientIds[3], bookingSlots.wrongReceipt, wrongReceipt))
      .resolves.toEqual({ ok: false, reason: "create_failed" });
  });

  it("rejects direct authenticated provenance forgery", async () => {
    const receiptId = await createReceipt();
    const forged = await admin.from("appointments").insert({
      clinic_id: clinicId,
      patient_id: patientIds[3],
      doctor_id: doctorId,
      scheduled_at: bookingSlots.directForgery,
      duration_minutes: 30,
      status: "pending",
      created_by: adminId,
      ai_action_receipt_id: receiptId,
    });
    expect(forged.error?.code).toBe("42501");
    expect(forged.error?.message).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
  });

  it("keeps the one-active-AI-pending patient cap on the action path", async () => {
    const secondReceipt = await createReceipt();
    await expect(actionBooking(patientIds[0], bookingSlots.patientCap, secondReceipt))
      .resolves.toEqual({ ok: false, reason: "patient_pending_cap" });
  });

  it("shares the per-slot cap across action and patient origins", async () => {
    const firstReceipt = await createReceipt();
    await expect(actionBooking(patientIds[1], bookingSlots.sharedSlotCap, firstReceipt))
      .resolves.toMatchObject({ ok: true });

    const patientCreated = await service.rpc("create_patient_preliminary_booking", {
      p_clinic_id: clinicId,
      p_conversation_id: patientConversationId,
      p_doctor_id: doctorId,
      p_scheduled_at: bookingSlots.sharedSlotCap,
      p_duration_minutes: 30,
    });
    expect(patientCreated.error).toBeNull();

    const thirdReceipt = await createReceipt();
    await expect(actionBooking(patientIds[3], bookingSlots.sharedSlotCap, thirdReceipt))
      .resolves.toEqual({ ok: false, reason: "slot_pending_cap" });
  });
});
