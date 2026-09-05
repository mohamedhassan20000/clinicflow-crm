import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Json } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p5a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P5aPatientTools12345!";
const periodStart = `${new Date().getUTCFullYear()}-${String(
  new Date().getUTCMonth() + 1,
).padStart(2, "0")}-01`;
const clinicA = randomUUID();
const clinicB = randomUUID();
const adminAId = randomUUID();
const doctorAId = randomUUID();
const adminBId = randomUUID();
const doctorBId = randomUUID();
const patientA1 = randomUUID();
const patientA2 = randomUUID();
const patientA3 = randomUUID();
const patientB = randomUUID();
const conversationA1 = randomUUID();
const conversationA2 = randomUUID();
const conversationA3 = randomUUID();
const conversationB = randomUUID();
const userIds = [adminAId, doctorAId, adminBId, doctorBId];
let adminA: Client;
let anon: Client;

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p5a-${Math.random().toString(36).slice(2)}`,
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

async function cleanup() {
  await service.from("audit_logs").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("appointments").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("doctor_schedules").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("patients")
    .delete()
    .in("id", [patientA1, patientA2, patientA3, patientB]);
  await service.from("ai_commercial_terms").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)));
}

function createBooking(
  conversationId: string,
  scheduledAt: string,
  clinicId = clinicA,
  doctorId = doctorAId,
) {
  return service.rpc("create_patient_preliminary_booking", {
    p_clinic_id: clinicId,
    p_conversation_id: conversationId,
    p_doctor_id: doctorId,
    p_scheduled_at: scheduledAt,
    p_duration_minutes: 30,
  });
}

beforeAll(async () => {
  await cleanup();
  const [adminAEmail] = await Promise.all([
    createAuthUser(adminAId, "admin-a"),
    createAuthUser(doctorAId, "doctor-a"),
    createAuthUser(adminBId, "admin-b"),
    createAuthUser(doctorBId, "doctor-b"),
  ]);
  adminA = client();
  const signIn = await adminA.auth.signInWithPassword({
    email: adminAEmail,
    password,
  });
  if (signIn.error) throw signIn.error;
  anon = client();

  const clinics = await service.from("clinics").insert([
    {
      id: clinicA,
      name: `P5A Clinic A ${suffix}`,
      timezone: "Asia/Kuwait",
      ai_pending_slot_cap: 2,
      ai_pending_booking_ttl_minutes: 1440,
    },
    {
      id: clinicB,
      name: `P5A Clinic B ${suffix}`,
      timezone: "Asia/Kuwait",
      ai_pending_slot_cap: 2,
      ai_pending_booking_ttl_minutes: 1440,
    },
  ]);
  if (clinics.error) throw clinics.error;

  const plan = await service
    .from("plans")
    .select("id")
    .eq("slug", "pro_ai")
    .single();
  if (plan.error) throw plan.error;
  const subscriptions = await service.from("subscriptions").insert([
    {
      clinic_id: clinicA,
      plan_id: plan.data.id,
      status: "trialing",
      trial_ends_at: "2035-01-01T00:00:00Z",
    },
    {
      clinic_id: clinicB,
      plan_id: plan.data.id,
      status: "trialing",
      trial_ends_at: "2035-01-01T00:00:00Z",
    },
  ]);
  if (subscriptions.error) throw subscriptions.error;

  const profiles = await service.from("profiles").insert([
    { id: adminAId, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: doctorAId, clinic_id: clinicA, full_name: "Doctor A", role: "doctor" },
    { id: adminBId, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
    { id: doctorBId, clinic_id: clinicB, full_name: "Doctor B", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;

  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinicA, change_reason: "pilot", updated_by: adminAId, accepted_at: new Date().toISOString() },
    { clinic_id: clinicB, change_reason: "pilot", updated_by: adminBId, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;

  const patients = await service.from("patients").insert([
    {
      id: patientA1,
      clinic_id: clinicA,
      full_name: "Patient A1",
      date_of_birth: "1990-01-01",
      phone: "+96550001001",
      email: `${suffix}-a1@example.com`,
      national_id: `${Date.now()}01`,
      file_number: `${suffix}-a1`,
      created_by: adminAId,
      assigned_doctor_id: doctorAId,
    },
    {
      id: patientA2,
      clinic_id: clinicA,
      full_name: "Patient A2",
      date_of_birth: "1991-02-02",
      phone: "+96550001002",
      email: `${suffix}-a2@example.com`,
      national_id: `${Date.now()}02`,
      file_number: `${suffix}-a2`,
      created_by: adminAId,
      assigned_doctor_id: doctorAId,
    },
    {
      id: patientA3,
      clinic_id: clinicA,
      full_name: "Patient A3",
      date_of_birth: "1992-03-03",
      phone: "+96550001003",
      email: `${suffix}-a3@example.com`,
      national_id: `${Date.now()}03`,
      file_number: `${suffix}-a3`,
      created_by: adminAId,
      assigned_doctor_id: doctorAId,
    },
    {
      id: patientB,
      clinic_id: clinicB,
      full_name: "Patient B",
      date_of_birth: "1980-04-04",
      phone: "+96550002001",
      email: `${suffix}-b@example.com`,
      national_id: `${Date.now()}04`,
      file_number: `${suffix}-b`,
      created_by: adminBId,
      assigned_doctor_id: doctorBId,
    },
  ]);
  if (patients.error) throw patients.error;

  const conversations = await service.from("conversations").insert([
    {
      id: conversationA1,
      clinic_id: clinicA,
      patient_id: patientA1,
      channel: "whatsapp",
      participant_address: "+96550001001",
    },
    {
      id: conversationA2,
      clinic_id: clinicA,
      patient_id: patientA2,
      channel: "whatsapp",
      participant_address: "+96550001002",
    },
    {
      id: conversationA3,
      clinic_id: clinicA,
      patient_id: patientA3,
      channel: "whatsapp",
      participant_address: "+96550001003",
    },
    {
      id: conversationB,
      clinic_id: clinicB,
      patient_id: patientB,
      channel: "whatsapp",
      participant_address: "+96550002001",
    },
  ]);
  if (conversations.error) throw conversations.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all([adminA?.auth.signOut(), anon?.auth.signOut()]);
}, 60_000);

describe("P5A service-only identity boundary and RLS", () => {
  it("denies anon/authenticated RPC execution and isolates clinic/conversation pairs", async () => {
    for (const db of [anon, adminA]) {
      const denied = await db.rpc("resolve_patient_ai_context", {
        p_clinic_id: clinicA,
        p_conversation_id: conversationA1,
      });
      expect(denied.error?.code).toBe("42501");
    }

    const own = await service.rpc("resolve_patient_ai_context", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA1,
    });
    expect(own.error).toBeNull();
    expect(own.data?.[0]).toMatchObject({
      clinic_id: clinicA,
      conversation_id: conversationA1,
      patient_id: patientA1,
    });

    const crossed = await service.rpc("resolve_patient_ai_context", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationB,
    });
    expect(crossed.error).toBeNull();
    expect(crossed.data).toEqual([]);

    const rls = await adminA
      .from("conversations")
      .select("id, identity_verified_at")
      .in("id", [conversationA1, conversationB]);
    expect(rls.data?.map((row) => row.id)).toEqual([conversationA1]);

    const forgedVerification = await adminA
      .from("conversations")
      .update({ identity_verified_at: new Date().toISOString() })
      .eq("id", conversationA1);
    expect([undefined, "42501"]).toContain(forgedVerification.error?.code);
    const identityState = await service
      .from("conversations")
      .select("identity_verified_at")
      .eq("id", conversationA1)
      .single();
    expect(identityState.data?.identity_verified_at).toBeNull();

    const created = await createBooking(
      conversationA1,
      "2030-08-01T09:00:00Z",
    );
    expect(created.error).toBeNull();
    const createdId = created.data![0].appointment_id;
    const dashboardVisible = await adminA
      .from("appointments")
      .select("id, status")
      .eq("id", createdId)
      .eq("status", "pending")
      .not("ai_patient_conversation_id", "is", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    expect(dashboardVisible.error).toBeNull();
    expect(dashboardVisible.data).toMatchObject({ id: createdId, status: "pending" });

    const notification = await adminA
      .from("notifications")
      .select("recipient_id, type, link, data")
      .eq("clinic_id", clinicA)
      .eq("type", "ai_booking_request")
      .contains("data", { recordId: createdId })
      .maybeSingle();
    expect(notification.error).toBeNull();
    expect(notification.data).toMatchObject({
      recipient_id: adminAId,
      type: "ai_booking_request",
      data: { source: "appointment", recordId: createdId },
    });
    expect(notification.data?.link).toContain(`/appointments?status=pending&ai=1&appointment=${createdId}`);
    const forgedExpiry = await adminA
      .from("appointments")
      .update({ expires_at: "2035-01-01T00:00:00Z" })
      .eq("id", createdId);
    expect(forgedExpiry.error?.code).toBe("42501");
    await service
      .from("appointments")
      .delete()
      .eq("id", createdId);
  });

  it("requires DOB verification for details, locks repeated failures, and returns only the bound patient's rows", async () => {
    const denied = await service.rpc("list_patient_ai_appointments", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
    });
    expect(denied.error?.code).toBe("42501");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await service.rpc("verify_patient_conversation_dob", {
        p_clinic_id: clinicA,
        p_conversation_id: conversationA3,
        p_date_of_birth: "2000-01-01",
      });
      expect(failed.error).toBeNull();
    }
    const locked = await service.rpc("verify_patient_conversation_dob", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_date_of_birth: "1992-03-03",
    });
    expect(locked.data?.[0]).toMatchObject({
      verified: false,
      attempts_remaining: 0,
    });

    await service
      .from("conversations")
      .update({
        identity_verification_failures: 0,
        identity_verification_locked_until: null,
      })
      .eq("id", conversationA3);
    const verified = await service.rpc("verify_patient_conversation_dob", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_date_of_birth: "1992-03-03",
    });
    expect(verified.data?.[0].verified).toBe(true);

    const ownAppointment = randomUUID();
    const otherAppointment = randomUUID();
    const inserted = await service.from("appointments").insert([
      {
        id: ownAppointment,
        clinic_id: clinicA,
        patient_id: patientA3,
        doctor_id: doctorAId,
        scheduled_at: "2030-08-10T09:00:00Z",
        status: "pending",
        created_by: adminAId,
      },
      {
        id: otherAppointment,
        clinic_id: clinicA,
        patient_id: patientA2,
        doctor_id: doctorAId,
        scheduled_at: "2030-08-10T10:00:00Z",
        status: "pending",
        created_by: adminAId,
      },
    ]);
    expect(inserted.error).toBeNull();

    const listed = await service.rpc("list_patient_ai_appointments", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
    });
    expect(listed.error).toBeNull();
    expect(listed.data?.map((row) => row.appointment_id)).toContain(ownAppointment);
    expect(listed.data?.map((row) => row.appointment_id)).not.toContain(otherAppointment);

    const crossCancel = await service.rpc("cancel_patient_ai_appointment", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: otherAppointment,
    });
    expect(crossCancel.data?.[0]).toEqual({
      cancelled: false,
      reason: "not_found",
    });
    const ownCancel = await service.rpc("cancel_patient_ai_appointment", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: ownAppointment,
    });
    expect(ownCancel.data?.[0]).toEqual({
      cancelled: true,
      reason: "cancelled",
    });
  });
});

describe("P5A atomic pending caps, staff displacement compatibility, and TTL", () => {
  it("atomically replaces only the verified patient's own pending request", async () => {
    await service
      .from("conversations")
      .update({ identity_verified_at: new Date().toISOString(), ai_paused_at: null })
      .eq("id", conversationA3);
    const schedules = await service.from("doctor_schedules").upsert(
      Array.from({ length: 7 }, (_, day) => ({
        clinic_id: clinicA,
        doctor_id: doctorAId,
        day_of_week: day,
        start_time: "08:00",
        end_time: "18:00",
        is_enabled: true,
      })),
      // P14 replaced `ds_unique (doctor_id, day_of_week)` with
      // `ds_unique_interval (doctor_id, day_of_week, start_time)` so a staff
      // member can hold more than one shift per weekday.
      { onConflict: "doctor_id,day_of_week,start_time" },
    );
    expect(schedules.error).toBeNull();

    const originalId = randomUUID();
    const otherPatientId = randomUUID();
    const inserted = await service.from("appointments").insert([
      {
        id: originalId,
        clinic_id: clinicA,
        patient_id: patientA3,
        doctor_id: doctorAId,
        scheduled_at: "2030-10-01T09:00:00Z",
        duration_minutes: 30,
        status: "pending",
        created_by: null,
        ai_patient_conversation_id: conversationA3,
      },
      {
        id: otherPatientId,
        clinic_id: clinicA,
        patient_id: patientA2,
        doctor_id: doctorAId,
        scheduled_at: "2030-10-01T10:00:00Z",
        duration_minutes: 30,
        status: "pending",
        created_by: adminAId,
      },
    ]);
    expect(inserted.error).toBeNull();

    const crossed = await service.rpc("prepare_patient_ai_reschedule", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: otherPatientId,
    });
    expect(crossed.error).toBeNull();
    expect(crossed.data).toEqual([]);

    const changed = await service.rpc("reschedule_patient_ai_appointment", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: originalId,
      p_scheduled_at: "2030-10-02T09:00:00Z",
    });
    expect(changed.error).toBeNull();
    expect(changed.data?.[0]).toMatchObject({
      rescheduled: true,
      reason: "rescheduled",
      scheduled_at: "2030-10-02T09:00:00+00:00",
    });
    const newId = changed.data?.[0].new_appointment_id;
    expect(newId).toBeTruthy();

    const chain = await service
      .from("appointments")
      .select("id, status, replaces_appointment_id, replaced_by_appointment_id")
      .in("id", [originalId, newId!]);
    expect(chain.error).toBeNull();
    expect(chain.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalId, status: "replaced", replaced_by_appointment_id: newId }),
      expect.objectContaining({ id: newId, status: "pending", replaces_appointment_id: originalId }),
    ]));
    expect(chain.data?.filter((row) => row.status === "pending")).toHaveLength(1);

    const repeated = await service.rpc("reschedule_patient_ai_appointment", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: originalId,
      p_scheduled_at: "2030-10-03T09:00:00Z",
    });
    expect(repeated.data?.[0]).toMatchObject({
      rescheduled: false,
      reason: "pending_required",
    });
    const release = await service.rpc("cancel_patient_ai_appointment", {
      p_clinic_id: clinicA,
      p_conversation_id: conversationA3,
      p_appointment_id: newId!,
    });
    expect(release.data?.[0]).toMatchObject({ cancelled: true });
  });

  it("serializes concurrent bookings so one patient can hold only one active AI pending", async () => {
    const slot = "2030-09-01T09:00:00Z";
    const results = await Promise.all([
      createBooking(conversationA1, slot),
      createBooking(conversationA1, "2030-09-01T10:00:00Z"),
    ]);
    expect(results.filter((result) => !result.error)).toHaveLength(1);
    expect(
      results.filter((result) => result.error?.message.includes("AI_PENDING_PATIENT_CAP")),
    ).toHaveLength(1);
    await service
      .from("appointments")
      .delete()
      .eq("ai_patient_conversation_id", conversationA1);
  });

  it("allows two same-slot pendings, rejects the third, then preserves normal confirm/displace handling", async () => {
    const slot = "2030-09-02T09:00:00Z";
    const first = await createBooking(conversationA1, slot);
    const second = await createBooking(conversationA2, slot);
    const third = await createBooking(conversationA3, slot);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(third.error?.message).toContain("AI_PENDING_SLOT_CAP");

    const firstId = first.data![0].appointment_id;
    const secondId = second.data![0].appointment_id;
    const confirm = await service
      .from("appointments")
      .update({ status: "confirmed", updated_by: adminAId })
      .eq("id", firstId);
    expect(confirm.error).toBeNull();
    const displace = await service
      .from("appointments")
      .update({
        deleted_at: new Date().toISOString(),
        displaced_at: new Date().toISOString(),
        displaced_by: adminAId,
      })
      .eq("id", secondId)
      .eq("status", "pending");
    expect(displace.error).toBeNull();

    const states = await service
      .from("appointments")
      .select("id, status, displaced_at")
      .in("id", [firstId, secondId])
      .order("id");
    expect(states.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, status: "confirmed" }),
        expect.objectContaining({ id: secondId, status: "pending" }),
      ]),
    );
  });

  it("expires due pending AI bookings terminally and writes a tenant audit row", async () => {
    const created = await createBooking(conversationA3, "2030-09-03T09:00:00Z");
    expect(created.error).toBeNull();
    const appointmentId = created.data![0].appointment_id;
    const due = await service
      .from("appointments")
      .update({ expires_at: "2026-01-01T00:00:00Z" })
      .eq("id", appointmentId);
    expect(due.error).toBeNull();

    const expired = await service.rpc("expire_ai_pending_bookings", {
      p_now: "2026-07-27T12:00:00Z",
      p_limit: 500,
    });
    expect(expired.error).toBeNull();
    expect(expired.data?.[0].expired_count).toBeGreaterThanOrEqual(1);

    const row = await service
      .from("appointments")
      .select("status, cancellation_reason")
      .eq("id", appointmentId)
      .single();
    expect(row.data).toEqual({
      status: "cancelled",
      cancellation_reason: "AI pending booking expired",
    });
    const audit = await service
      .from("audit_logs")
      .select("action, clinic_id, record_id")
      .eq("action", "AI_PENDING_BOOKING_EXPIRED")
      .eq("record_id", appointmentId)
      .single();
    expect(audit.data).toEqual({
      action: "AI_PENDING_BOOKING_EXPIRED",
      clinic_id: clinicA,
      record_id: appointmentId,
    });
  });
});

describe("P5A commercial usage attribution", () => {
  it("reserves and reconciles a patient turn against the shared immutable AI ledger", async () => {
    const requestId = randomUUID();
    const attemptId = randomUUID();
    const reserved = await service.rpc("reserve_ai_budget", {
      p_request_id: requestId,
      p_lease_token: randomUUID(),
      p_clinic_id: clinicA,
      p_actor_id: conversationA1,
      p_period_start: periodStart,
      p_surface: "patient_messaging",
      p_persona: "patient",
      p_task: "patient_booking",
      p_transport: "vercel_ai_gateway",
      p_expected_provider: "anthropic",
      p_expected_model: "anthropic/claude-haiku-4.5",
      p_model_alias: "patient-haiku-bootstrap-v1",
      p_fallback_model_aliases: [],
      p_policy_version: "p5a-patient-booking-policy-v1",
      p_certification_version: "p4-bootstrap-2026-07-18",
      p_privacy_policy_version: "patient-zdr-no-training-v1",
      p_reserved_cost_micros: 10_000,
      p_budget_limit_micros: 1,
      p_lease_seconds: 600,
      p_credential_mode: "managed",
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data?.[0].acquired).toBe(true);

    const reservation = reserved.data![0];
    const reconciled = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: reservation.reservation_id,
      p_lease_token: reservation.returned_lease_token,
      p_outcome: "success",
      p_attempts: [
        {
          attempt_id: attemptId,
          attempt_sequence: 0,
          fallback_parent_attempt_id: null,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          model_alias: "patient-haiku-bootstrap-v1",
          input_tokens: 20,
          output_tokens: 10,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          latency_ms: 25,
          status: "success",
          error_class: null,
          estimated_cost_micros: 70,
          final_cost_micros: 70,
        },
      ] as Json,
      p_actual_cost_micros: 70,
      p_managed_cost_micros: 70,
      p_error_class: null,
    });
    expect(reconciled.error).toBeNull();
    expect(reconciled.data).toBe(true);

    const usageEvent = await service
      .from("ai_usage_events")
      .select("actor_id, surface, persona, task, billing_disposition")
      .eq("request_id", requestId)
      .single();
    expect(usageEvent.error).toBeNull();
    expect(usageEvent.data).toEqual({
      actor_id: conversationA1,
      surface: "patient_messaging",
      persona: "patient",
      task: "patient_booking",
      billing_disposition: "managed_included",
    });

    const counter = await service
      .from("usage_counters")
      .select("used")
      .eq("clinic_id", clinicA)
      .eq("period_start", periodStart)
      .eq("metric", "ai_messages")
      .single();
    expect(counter.error).toBeNull();
    expect(counter.data?.used).toBe(1);
  });
});
