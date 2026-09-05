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

const suffix = `p8-intake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P8IntakeBooking123!";
const clinicId = randomUUID();
const departmentId = randomUUID();
const receptionistId = randomUUID();
const adminId = randomUUID();
const managerId = randomUUID();
const doctorId = randomUUID();
const authUserIds = [receptionistId, adminId, managerId, doctorId];
let receptionist: Client;
let admin: Client;
let manager: Client;

function browserClient(label: string) {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${label}`,
    },
  });
}

function futureSlot(hourUtc: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

const primarySlot = futureSlot(9); // 12:00 in Asia/Kuwait
const retrySlot = futureSlot(10);
const maintenanceRetrySlot = futureSlot(11);

async function createAuthUser(id: string, role: string) {
  const email = `${suffix}-${role}@example.com`;
  const created = await service.auth.admin.createUser({
    id,
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  return email;
}

async function createConversation(phone: string) {
  const result = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: phone,
      status: "open",
    })
    .select("id")
    .single();
  if (result.error) throw result.error;
  return result.data.id;
}

async function stageIntake(input: {
  conversationId: string;
  nationalId: string;
  name?: string;
}) {
  const result = await service.rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: clinicId,
    p_conversation_id: input.conversationId,
    p_full_name: input.name ?? "Reviewed Intake Patient",
    p_national_id: input.nationalId,
    p_date_of_birth: "1990-12-25",
    p_email: `${suffix}-${input.nationalId.toLowerCase()}@example.com`,
    p_department_id: departmentId,
    p_doctor_id: doctorId,
  });
  expect(result.error).toBeNull();
  expect(result.data?.[0]?.status).toBe("staged");
  return result.data![0]!.intake_id!;
}

async function cleanup() {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("inbound_message_attachments").delete().eq("clinic_id", clinicId);
  await service.from("inbound_messages").delete().eq("clinic_id", clinicId);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", authUserIds);
  await service.from("departments").delete().eq("id", departmentId);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await Promise.all(
    authUserIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
}

beforeAll(async () => {
  await cleanup();
  const [receptionistEmail, adminEmail, managerEmail] = await Promise.all([
    createAuthUser(receptionistId, "receptionist"),
    createAuthUser(adminId, "admin"),
    createAuthUser(managerId, "manager"),
    createAuthUser(doctorId, "doctor"),
  ]);

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `P8 Intake Clinic ${suffix}`,
    country: "KW",
    timezone: "Asia/Kuwait",
    ai_pending_booking_ttl_minutes: 60,
    ai_pending_slot_cap: 2,
  });
  if (clinic.error) throw clinic.error;

  // resolve_patient_ai_context gates on ai_assistant + ai.patient_suggest, so
  // the fixture clinic needs a real AI-bearing subscription.
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  const subscription = await service.from("subscriptions").insert({
    clinic_id: clinicId,
    plan_id: plan.data.id,
    status: "trialing",
    trial_ends_at: "2035-01-01T00:00:00Z",
  });
  if (subscription.error) throw subscription.error;
  const terms = await service.from("ai_commercial_terms").insert({
    clinic_id: clinicId,
    change_reason: "pilot",
    updated_by: adminId,
    accepted_at: new Date().toISOString(),
  });
  if (terms.error) throw terms.error;

  const department = await service.from("departments").insert({
    id: departmentId,
    clinic_id: clinicId,
    name: `Intake Department ${suffix}`,
  });
  if (department.error) throw department.error;
  const profiles = await service.from("profiles").insert([
    {
      id: receptionistId,
      clinic_id: clinicId,
      full_name: "Real Receptionist",
      role: "receptionist",
    },
    {
      id: adminId,
      clinic_id: clinicId,
      full_name: "Real Admin",
      role: "admin",
    },
    {
      id: managerId,
      clinic_id: clinicId,
      full_name: "Real Manager",
      role: "manager",
    },
    {
      id: doctorId,
      clinic_id: clinicId,
      department_id: departmentId,
      full_name: "Assigned Doctor",
      role: "doctor",
    },
  ]);
  if (profiles.error) throw profiles.error;
  const schedule = await service.from("doctor_schedules").insert({
    clinic_id: clinicId,
    doctor_id: doctorId,
    day_of_week: primarySlot.getUTCDay(),
    start_time: "08:00:00",
    end_time: "18:00:00",
    is_enabled: true,
  });
  if (schedule.error) throw schedule.error;

  receptionist = browserClient("receptionist");
  admin = browserClient("admin");
  manager = browserClient("manager");
  const [receptionistLogin, adminLogin, managerLogin] = await Promise.all([
    receptionist.auth.signInWithPassword({ email: receptionistEmail, password }),
    admin.auth.signInWithPassword({ email: adminEmail, password }),
    manager.auth.signInWithPassword({ email: managerEmail, password }),
  ]);
  if (receptionistLogin.error) throw receptionistLogin.error;
  if (adminLogin.error) throw adminLogin.error;
  if (managerLogin.error) throw managerLogin.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all([
    receptionist?.auth.signOut(),
    admin?.auth.signOut(),
    manager?.auth.signOut(),
  ]);
}, 60_000);

describe("P8 reviewed AI intake approval against the live database", () => {
  it("executes the real paused + closed receptionist happy path and is idempotent", async () => {
    const phone = `+96550${String(Date.now()).slice(-6)}`;
    const originalNationalId = "AbC123456";
    const conversationId = await createConversation(phone);
    const intakeId = await stageIntake({
      conversationId,
      nationalId: originalNationalId,
    });
    const request = await service.rpc("create_provisional_ai_appointment_request", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationId,
      p_doctor_id: doctorId,
      p_scheduled_at: primarySlot.toISOString(),
      p_duration_minutes: 30,
    });
    expect(request.error).toBeNull();

    const takeover = await service.rpc("set_conversation_ai_pause", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationId,
      p_paused: true,
      p_actor_id: receptionistId,
      p_reason: "reviewing provisional intake",
    });
    expect(takeover.error).toBeNull();
    const closed = await service
      .from("conversations")
      .update({ status: "closed" })
      .eq("id", conversationId)
      .select("ai_paused_at")
      .single();
    if (closed.error) throw closed.error;
    const pausedAt = closed.data.ai_paused_at;
    expect(pausedAt).not.toBeNull();

    const approval = await receptionist.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: receptionistId,
    });
    expect(approval.error?.message ?? "").not.toContain(
      "PATIENT_AI_IDENTITY_STATE_SERVER_ONLY",
    );
    expect(approval.error?.message ?? "").not.toContain(
      "AI_BOOKING_METADATA_SERVER_ONLY",
    );
    expect(approval.error?.message ?? "").not.toContain("HUMAN_TAKEOVER_ACTIVE");
    expect(approval.error?.message ?? "").not.toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
    expect(approval.error).toBeNull();
    expect(approval.data?.[0]?.already_processed).toBe(false);
    const patientId = approval.data![0]!.patient_id;
    const appointmentId = approval.data![0]!.appointment_id!;
    expect(patientId).toBeTruthy();
    expect(appointmentId).toBeTruthy();

    const [patient, appointment, conversation, intake, linkedRequest] = await Promise.all([
      service
        .from("patients")
        .select(
          "id, national_id, department_id, assigned_doctor_id, phone, created_by",
        )
        .eq("id", patientId)
        .single(),
      service
        .from("appointments")
        .select(
          "id, patient_id, department_id, doctor_id, status, created_by, ai_patient_conversation_id",
        )
        .eq("id", appointmentId)
        .single(),
      service
        .from("conversations")
        .select(
          "patient_id, patient_link_status, status, ai_paused_at, identity_verified_at",
        )
        .eq("id", conversationId)
        .single(),
      service
        .from("ai_patient_intakes")
        .select("review_status, reviewed_by, approved_patient_id, national_id")
        .eq("id", intakeId)
        .single(),
      service
        .from("ai_appointment_requests")
        .select("status, appointment_id")
        .eq("id", request.data![0]!.request_id)
        .single(),
    ]);
    for (const result of [patient, appointment, conversation, intake, linkedRequest]) {
      expect(result.error).toBeNull();
    }
    expect(patient.data).toMatchObject({
      id: patientId,
      national_id: originalNationalId,
      department_id: departmentId,
      assigned_doctor_id: doctorId,
      phone,
      created_by: receptionistId,
    });
    expect(appointment.data).toMatchObject({
      id: appointmentId,
      patient_id: patientId,
      department_id: departmentId,
      doctor_id: doctorId,
      status: "pending",
      created_by: null,
      ai_patient_conversation_id: conversationId,
    });
    expect(conversation.data).toMatchObject({
      patient_id: patientId,
      patient_link_status: "manual",
      status: "closed",
      ai_paused_at: pausedAt,
    });
    expect(conversation.data?.identity_verified_at).not.toBeNull();
    expect(intake.data).toMatchObject({
      review_status: "approved",
      reviewed_by: receptionistId,
      approved_patient_id: patientId,
      national_id: originalNationalId,
    });
    expect(linkedRequest.data).toEqual({
      status: "linked",
      appointment_id: appointmentId,
    });

    const repeated = await receptionist.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: receptionistId,
    });
    expect(repeated.error).toBeNull();
    expect(repeated.data?.[0]).toEqual({
      patient_id: patientId,
      appointment_id: appointmentId,
      already_processed: true,
    });
    const duplicates = await service
      .from("patients")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("phone", phone);
    expect(duplicates.error).toBeNull();
    expect(duplicates.data).toEqual([{ id: patientId }]);
  });

  it("accepts a real authenticated admin claim without creating an unreviewed patient", async () => {
    const phone = `+96551${String(Date.now()).slice(-6)}`;
    const conversationId = await createConversation(phone);
    const intakeId = await stageIntake({
      conversationId,
      nationalId: `ADM${String(Date.now()).slice(-7)}`,
      name: "Admin Reviewed Patient",
    });
    const before = await service
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("phone", phone);
    expect(before.count).toBe(0);

    const approved = await admin.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: adminId,
    });
    expect(approved.error).toBeNull();
    expect(approved.data?.[0]?.patient_id).toBeTruthy();
    expect(approved.data?.[0]?.appointment_id).toBeNull();
  });

  it("lets a real manager inspect and approve a staged intake", async () => {
    const phone = `+96554${String(Date.now()).slice(-6)}`;
    const conversationId = await createConversation(phone);
    const intakeId = await stageIntake({
      conversationId,
      nationalId: `MGR${String(Date.now()).slice(-7)}`,
      name: "Manager Reviewed Patient",
    });
    const visible = await manager
      .from("ai_patient_intakes")
      .select("id")
      .eq("id", intakeId)
      .maybeSingle();
    expect(visible.error).toBeNull();
    expect(visible.data?.id).toBe(intakeId);

    const approved = await manager.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: managerId,
    });
    expect(approved.error).toBeNull();
    expect(approved.data?.[0]?.patient_id).toBeTruthy();
  });

  it("rejects a provisional slot less than 24 hours away at the RPC boundary", async () => {
    const conversationId = await createConversation(
      `+96555${String(Date.now()).slice(-6)}`,
    );
    await stageIntake({
      conversationId,
      nationalId: `MIN${String(Date.now()).slice(-7)}`,
      name: "Minimum Notice Patient",
    });
    const tooSoon = new Date(Date.now() + 23 * 60 * 60 * 1000);
    const result = await service.rpc("create_provisional_ai_appointment_request", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationId,
      p_doctor_id: doctorId,
      p_scheduled_at: tooSoon.toISOString(),
      p_duration_minutes: 30,
    });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("AI_BOOKING_MINIMUM_NOTICE");
    const requests = await service
      .from("ai_appointment_requests")
      .select("id")
      .eq("conversation_id", conversationId);
    expect(requests.data).toEqual([]);
  });

  it("recovers a soft-deleted patient link as an unlinked staged intake", async () => {
    const phone = `+96556${String(Date.now()).slice(-6)}`;
    const deletedPatient = await service
      .from("patients")
      .insert({
        clinic_id: clinicId,
        full_name: "Deleted Test Patient",
        national_id: `DEL${String(Date.now()).slice(-7)}`,
        date_of_birth: "1985-06-15",
        phone,
        email: `${suffix}-deleted@example.com`,
        file_number: `CF-${Date.now()}`,
        created_by: adminId,
        is_deleted: true,
        deleted_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (deletedPatient.error) throw deletedPatient.error;
    const conversation = await service
      .from("conversations")
      .insert({
        clinic_id: clinicId,
        channel: "whatsapp",
        participant_address: phone,
        patient_id: deletedPatient.data.id,
        patient_link_status: "manual",
        status: "open",
        booking_identity_confirmed_at: new Date().toISOString(),
        identity_verified_at: new Date().toISOString(),
        identity_verification_failures: 2,
        identity_verification_locked_until: new Date(Date.now() + 60_000).toISOString(),
        ai_collected_data: {
          full_name: "Stale Patient",
          department_id: departmentId,
          doctor_id: doctorId,
          appointment_date: "2026-09-15",
          appointment_time: 600,
        },
        ai_pending_clarification: { field: "date_of_birth", kind: "ambiguous" },
        ai_booking_stage: {
          stage: "intake_collecting",
          offeredDoctorIds: [doctorId],
          offeredDays: ["2026-09-15"],
          offeredSlots: ["2026-09-15|10:00"],
          turns: 5,
        },
      })
      .select("id")
      .single();
    if (conversation.error) throw conversation.error;

    const resolved = await service.rpc("resolve_patient_ai_context", {
      p_clinic_id: clinicId,
      p_conversation_id: conversation.data.id,
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.[0]).toMatchObject({ patient_id: null, linked: false });

    const reset = await service
      .from("conversations")
      .select(
        "patient_id, patient_link_status, booking_identity_confirmed_at, identity_verified_at, identity_verification_failures, identity_verification_locked_until, ai_collected_data, ai_pending_clarification, ai_booking_stage, ai_context_reset_at",
      )
      .eq("id", conversation.data.id)
      .single();
    expect(reset.error).toBeNull();
    expect(reset.data).toMatchObject({
      patient_id: null,
      patient_link_status: "unlinked",
      booking_identity_confirmed_at: null,
      identity_verified_at: null,
      identity_verification_failures: 0,
      identity_verification_locked_until: null,
      ai_collected_data: {},
      ai_pending_clarification: null,
      ai_booking_stage: null,
    });
    expect(reset.data?.ai_context_reset_at).toBeTruthy();

    const boundary = reset.data?.ai_context_reset_at;
    const second = await service.rpc("resolve_patient_ai_context", {
      p_clinic_id: clinicId,
      p_conversation_id: conversation.data.id,
    });
    expect(second.error).toBeNull();
    const idempotent = await service
      .from("conversations")
      .select("ai_context_reset_at")
      .eq("id", conversation.data.id)
      .single();
    expect(idempotent.data?.ai_context_reset_at).toBe(boundary);

    const beforeIntake = await service
      .from("ai_patient_intakes")
      .select("id")
      .eq("conversation_id", conversation.data.id);
    const beforeAppointments = await service
      .from("ai_appointment_requests")
      .select("id")
      .eq("conversation_id", conversation.data.id);
    expect(beforeIntake.data).toEqual([]);
    expect(beforeAppointments.data).toEqual([]);

    const intakeId = await stageIntake({
      conversationId: conversation.data.id,
      nationalId: `NEW${String(Date.now()).slice(-7)}`,
      name: "Replacement Intake Patient",
    });
    expect(intakeId).toBeTruthy();
    const repaired = await service
      .from("conversations")
      .select("patient_id, patient_link_status")
      .eq("id", conversation.data.id)
      .single();
    expect(repaired.data).toEqual({ patient_id: null, patient_link_status: "unlinked" });
  });

  it("expires stale request rows before insert, supports rebooking, and aligns dashboard visibility", async () => {
    const phone = `+96552${String(Date.now()).slice(-6)}`;
    const conversationId = await createConversation(phone);
    const intakeId = await stageIntake({
      conversationId,
      nationalId: `EXP${String(Date.now()).slice(-7)}`,
      name: "Expiry Rebooking Patient",
    });
    const first = await service.rpc("create_provisional_ai_appointment_request", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationId,
      p_doctor_id: doctorId,
      p_scheduled_at: retrySlot.toISOString(),
      p_duration_minutes: 30,
    });
    expect(first.error).toBeNull();
    const forcedExpired = await service
      .from("ai_appointment_requests")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", first.data![0]!.request_id);
    expect(forcedExpired.error).toBeNull();

    const second = await service.rpc("create_provisional_ai_appointment_request", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationId,
      p_doctor_id: doctorId,
      p_scheduled_at: maintenanceRetrySlot.toISOString(),
      p_duration_minutes: 30,
    });
    expect(second.error?.message ?? "").not.toContain(
      "ai_appointment_requests_one_active_intake",
    );
    expect(second.error).toBeNull();
    const lifecycle = await service
      .from("ai_appointment_requests")
      .select("id, status")
      .eq("intake_id", intakeId)
      .order("created_at");
    expect(lifecycle.error).toBeNull();
    expect(lifecycle.data).toEqual([
      { id: first.data![0]!.request_id, status: "expired" },
      { id: second.data![0]!.request_id, status: "pending" },
    ]);

    const dashboardVisible = await receptionist
      .from("ai_appointment_requests")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString());
    expect(dashboardVisible.error).toBeNull();
    expect(dashboardVisible.data?.map((row) => row.id)).toContain(
      second.data![0]!.request_id,
    );
    expect(dashboardVisible.data?.map((row) => row.id)).not.toContain(
      first.data![0]!.request_id,
    );

    const expireSecond = await service
      .from("ai_appointment_requests")
      .update({ expires_at: new Date(Date.now() - 30_000).toISOString() })
      .eq("id", second.data![0]!.request_id);
    expect(expireSecond.error).toBeNull();
    const maintenance = await service.rpc("expire_ai_appointment_requests", {
      p_now: new Date().toISOString(),
      p_limit: 500,
    });
    expect(maintenance.error).toBeNull();
    expect(maintenance.data?.[0]?.expired_count).toBeGreaterThanOrEqual(1);
    const afterMaintenance = await service
      .from("ai_appointment_requests")
      .select("status")
      .eq("id", second.data![0]!.request_id)
      .single();
    expect(afterMaintenance.data?.status).toBe("expired");
  });

  it("keeps normal authenticated identity-state writes protected", async () => {
    const conversationId = await createConversation(
      `+96553${String(Date.now()).slice(-6)}`,
    );
    const direct = await receptionist
      .from("conversations")
      .update({ identity_verified_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (direct.error) {
      expect(direct.error.message).toMatch(
        /PATIENT_AI_IDENTITY_STATE_SERVER_ONLY|row-level security|permission denied/i,
      );
    }
    const row = await service
      .from("conversations")
      .select("identity_verified_at")
      .eq("id", conversationId)
      .single();
    expect(row.data?.identity_verified_at).toBeNull();
  });

  it("keeps the obsolete auto-registration RPC unreachable", async () => {
    const obsoleteRpc = service.rpc.bind(service) as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
    const result = await obsoleteRpc("register_patient_from_conversation", {
      p_clinic_id: clinicId,
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
