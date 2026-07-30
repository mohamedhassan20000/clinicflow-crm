import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

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
type CreatePendingWorkflowBooking =
  typeof import("@/lib/booking/pending-workflow").createPendingWorkflowBooking;

const suffix = `p5a-p411-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P5aP411Workflow12345!";
const clinicId = randomUUID();
const adminId = randomUUID();
const doctorId = randomUUID();
const patientIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const conversationIds = [randomUUID(), randomUUID()];
const runIds: string[] = [];
const userIds = [adminId, doctorId];
let admin: Client;
let adminUser: AuthedUser;
let createPendingWorkflowBooking: CreatePendingWorkflowBooking;

function futureClinicSlot(dayOffset: number, time = "12:00") {
  const futureDate = new Date(testStartedAt + dayOffset * DAY_MS);
  const clinicDate = formatInTimeZone(
    futureDate,
    clinicTimeZone,
    "yyyy-MM-dd",
  );
  return fromZonedTime(
    `${clinicDate}T${time}:00`,
    clinicTimeZone,
  ).toISOString();
}

const bookingSlots = {
  confirmed: futureClinicSlot(30),
  directForgery: futureClinicSlot(31),
  unconfirmed: futureClinicSlot(32),
  patientCap: futureClinicSlot(33),
  sharedSlotCap: futureClinicSlot(34),
};

function bookingPlan(stepId: string) {
  return {
    version: 1,
    step_count: 1,
    cost_units: 2,
    steps: [{
      id: stepId,
      tool: "create_pending_booking",
      depends_on: [],
      params: [],
    }],
  } as unknown as Json;
}

function sessionClient() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p5a-p411-${randomUUID()}`,
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

async function createConfirmedBookingRun(stepId: string) {
  const runId = randomUUID();
  runIds.push(runId);
  const inserted = await service.from("ai_workflow_runs").insert({
    id: runId,
    clinic_id: clinicId,
    user_id: adminId,
    mode: "execute",
    state: "running",
    plan: bookingPlan(stepId),
    step_states: [] as unknown as Json,
    step_count: 1,
    cost_units: 2,
    dry_run_snapshot_hash: "a".repeat(64),
    confirmed_by: adminId,
    confirmed_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  if (inserted.error) throw inserted.error;
  return runId;
}

async function createUnconfirmedBookingRun(stepId: string) {
  const runId = randomUUID();
  runIds.push(runId);
  const inserted = await service.from("ai_workflow_runs").insert({
    id: runId,
    clinic_id: clinicId,
    user_id: adminId,
    mode: "dry_run",
    state: "previewed",
    plan: bookingPlan(stepId),
    step_states: [] as unknown as Json,
    step_count: 1,
    cost_units: 2,
    dry_run_snapshot_hash: "b".repeat(64),
    completed_at: new Date().toISOString(),
  });
  if (inserted.error) throw inserted.error;
  return runId;
}

function workflowBooking(
  patientId: string,
  scheduledAt: string,
  workflowRunId: string,
  workflowStepId: string,
) {
  return createPendingWorkflowBooking({
    supabase: admin,
    user: adminUser,
    booking: {
      patient_id: patientId,
      doctor_id: doctorId,
      scheduled_at: scheduledAt,
      duration_minutes: 30,
    },
    workflowRunId,
    workflowStepId,
  });
}

async function cleanup() {
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("ai_workflow_runs").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await Promise.all(
    userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
}

beforeAll(async () => {
  await cleanup();

  // The production helper creates its tenant-scoped service writer from the
  // app environment. Point that boundary at this same local test database.
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
  ({ createPendingWorkflowBooking } = await import(
    "@/lib/booking/pending-workflow"
  ));

  const [adminEmail] = await Promise.all([
    createAuthUser(adminId, "admin"),
    createAuthUser(doctorId, "doctor"),
  ]);
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
    fullName: "P5A P4.11 Admin",
    avatarUrl: null,
    clinicId,
    departmentId: null,
    mustChangePassword: false,
  };

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `P5A P4.11 Clinic ${suffix}`,
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
    {
      id: adminId,
      clinic_id: clinicId,
      full_name: "P5A P4.11 Admin",
      role: "admin",
    },
    {
      id: doctorId,
      clinic_id: clinicId,
      full_name: "P5A P4.11 Doctor",
      role: "doctor",
    },
  ]);
  if (profiles.error) throw profiles.error;

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
      full_name: `P5A P4.11 Patient ${index + 1}`,
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

  const conversations = await service.from("conversations").insert([
    {
      id: conversationIds[0],
      clinic_id: clinicId,
      patient_id: patientIds[0],
      channel: "whatsapp",
      participant_address: "+96559990000",
    },
    {
      id: conversationIds[1],
      clinic_id: clinicId,
      patient_id: patientIds[2],
      channel: "whatsapp",
      participant_address: "+96559990002",
    },
  ]);
  if (conversations.error) throw conversations.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await admin?.auth.signOut();
}, 60_000);

describe("P5A regression: authenticated P4.11 confirmed workflow booking", () => {
  it("uses the real authenticated validation path and persists server-owned provenance", async () => {
    const stepId = "book_patient_one";
    const runId = await createConfirmedBookingRun(stepId);
    const created = await workflowBooking(
      patientIds[0]!,
      bookingSlots.confirmed,
      runId,
      stepId,
    );

    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(`Unexpected booking failure: ${created.reason}`);

    const row = await service
      .from("appointments")
      .select(
        "id, clinic_id, patient_id, status, created_by, ai_workflow_run_id, ai_workflow_step_id, ai_patient_conversation_id, expires_at",
      )
      .eq("id", created.appointmentId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      clinic_id: clinicId,
      patient_id: patientIds[0],
      status: "pending",
      created_by: adminId,
      ai_workflow_run_id: runId,
      ai_workflow_step_id: stepId,
      ai_patient_conversation_id: null,
    });
    expect(new Date(row.data!.expires_at!).getTime()).toBeGreaterThan(Date.now());

    const replay = await workflowBooking(
      patientIds[0]!,
      bookingSlots.confirmed,
      runId,
      stepId,
    );
    expect(replay).toMatchObject({
      ok: true,
      appointmentId: created.appointmentId,
    });

    const forgedStep = await admin
      .from("appointments")
      .update({ ai_workflow_step_id: "forged_step" })
      .eq("id", created.appointmentId);
    expect(forgedStep.error?.code).toBe("42501");
    expect(forgedStep.error?.message).toContain(
      "AI_BOOKING_METADATA_SERVER_ONLY",
    );
  });

  it("continues to reject direct authenticated AI-metadata forgery", async () => {
    const stepId = "forged_booking";
    const runId = await createConfirmedBookingRun(stepId);
    const forged = await admin.from("appointments").insert({
      clinic_id: clinicId,
      patient_id: patientIds[3]!,
      doctor_id: doctorId,
      scheduled_at: bookingSlots.directForgery,
      duration_minutes: 30,
      status: "pending",
      created_by: adminId,
      ai_workflow_run_id: runId,
      ai_workflow_step_id: stepId,
    });

    expect(forged.error?.code).toBe("42501");
    expect(forged.error?.message).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
  });

  it("refuses to elevate an unconfirmed workflow preview", async () => {
    const stepId = "unconfirmed_booking";
    const runId = await createUnconfirmedBookingRun(stepId);
    const result = await workflowBooking(
      patientIds[3]!,
      bookingSlots.unconfirmed,
      runId,
      stepId,
    );

    expect(result).toEqual({ ok: false, reason: "create_failed" });
    const row = await service
      .from("appointments")
      .select("id")
      .eq("ai_workflow_run_id", runId);
    expect(row.error).toBeNull();
    expect(row.data).toEqual([]);
  });

  it("counts a workflow booking toward the one-active-AI-pending patient cap", async () => {
    const secondStep = "patient_cap_workflow";
    const secondRun = await createConfirmedBookingRun(secondStep);
    const workflowAttempt = await workflowBooking(
      patientIds[0]!,
      bookingSlots.patientCap,
      secondRun,
      secondStep,
    );
    expect(workflowAttempt).toEqual({
      ok: false,
      reason: "patient_pending_cap",
    });

    const patientAttempt = await service.rpc("create_patient_preliminary_booking", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationIds[0]!,
      p_doctor_id: doctorId,
      p_scheduled_at: bookingSlots.patientCap,
      p_duration_minutes: 30,
    });

    expect(patientAttempt.error?.message).toContain("AI_PENDING_PATIENT_CAP");
  });

  it("shares the configured per-slot cap across workflow and patient origins", async () => {
    const scheduledAt = bookingSlots.sharedSlotCap;
    const firstStep = "slot_workflow_first";
    const firstRun = await createConfirmedBookingRun(firstStep);
    const first = await workflowBooking(
      patientIds[1]!,
      scheduledAt,
      firstRun,
      firstStep,
    );
    expect(first).toMatchObject({ ok: true });

    const second = await service.rpc("create_patient_preliminary_booking", {
      p_clinic_id: clinicId,
      p_conversation_id: conversationIds[1]!,
      p_doctor_id: doctorId,
      p_scheduled_at: scheduledAt,
      p_duration_minutes: 30,
    });
    expect(second.error).toBeNull();

    const thirdStep = "slot_workflow_third";
    const thirdRun = await createConfirmedBookingRun(thirdStep);
    const third = await workflowBooking(
      patientIds[3]!,
      scheduledAt,
      thirdRun,
      thirdStep,
    );
    expect(third).toEqual({ ok: false, reason: "slot_pending_cap" });

    const rows = await service
      .from("appointments")
      .select("ai_workflow_run_id, ai_patient_conversation_id")
      .eq("clinic_id", clinicId)
      .eq("doctor_id", doctorId)
      .eq("scheduled_at", scheduledAt)
      .eq("status", "pending");
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(2);
    expect(rows.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ai_workflow_run_id: firstRun }),
        expect.objectContaining({ ai_patient_conversation_id: conversationIds[1] }),
      ]),
    );
  });
});
