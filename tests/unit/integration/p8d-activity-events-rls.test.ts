import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// Phase 8D — the unified activity trail is a database property: a spoof-proof,
// append-only, RLS-scoped log written only by the record_activity_event()
// trigger. These behaviours cannot be proven by a mocked client, so this runs
// against live Postgres.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "ActivityTrail12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const ALL_CLINICS = [clinicA, clinicB];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

function anonClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  userIds.push(created.data.user.id);
  const signedIn = anonClient();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

function patientRow(clinicId: string, createdBy: string, doctorId: string, index: number) {
  return {
    id: randomUUID(),
    clinic_id: clinicId,
    full_name: `Act Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655200${String(index).padStart(4, "0")}`,
    email: `${suffix}-p${index}-${clinicId.slice(0, 8)}@example.com`,
    national_id: `${Date.now()}${index}${clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${clinicId.slice(0, 4)}-${index}`,
    assigned_doctor_id: doctorId,
    created_by: createdBy,
  };
}

let admin: Client;
let adminId = "";
let assistant: Client;
let assistantId = "";
let doctorA1: Client;
let docA1Id = "";
let docA2Id = "";
let docBId = "";
const patientA1 = randomUUID();
const patientA2 = randomUUID();
const patientB = randomUUID();
const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function cleanup() {
  await service.from("activity_events").delete().in("clinic_id", ALL_CLINICS);
  await service.from("follow_ups").delete().in("clinic_id", ALL_CLINICS);
  await service.from("assistant_doctor_assignments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("appointments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

// Poll: the AFTER trigger commits synchronously with the mutation, but the read
// runs on a separate connection; a tiny retry keeps the assertion robust.
async function eventsFor(client: Client, entityId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await client
      .from("activity_events")
      .select("id, action, actor_id, actor_role, is_system, entity_type, doctor_id, patient_id, occurred_at, previous_state, new_state, metadata")
      .eq("entity_id", entityId)
      .order("occurred_at", { ascending: true });
    if (data && data.length > 0) return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

beforeAll(async () => {
  const [a, asst, d1, d2, adminB, docB] = await Promise.all([
    createUser("admin-a"),
    createUser("assistant"),
    createUser("doctor-a1"),
    createUser("doctor-a2"),
    createUser("admin-b"),
    createUser("doctor-b"),
  ]);
  admin = a.client;
  adminId = a.id;
  assistant = asst.client;
  assistantId = asst.id;
  doctorA1 = d1.client;
  docA1Id = d1.id;
  docA2Id = d2.id;
  docBId = docB.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Act Clinic A ${suffix}` },
    { id: clinicB, name: `Act Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: asst.id, clinic_id: clinicA, full_name: "Assistant", role: "assistant", is_active: true },
    { id: d1.id, clinic_id: clinicA, full_name: "Doctor A1", role: "doctor", is_active: true },
    { id: d2.id, clinic_id: clinicA, full_name: "Doctor A2", role: "doctor", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    { ...patientRow(clinicA, adminId, docA1Id, 1), id: patientA1 },
    { ...patientRow(clinicA, adminId, docA2Id, 2), id: patientA2 },
    { ...patientRow(clinicB, adminB.id, docBId, 3), id: patientB },
  ]);
  if (patients.error) throw patients.error;

  const assign = await service.from("assistant_doctor_assignments").insert({
    clinic_id: clinicA,
    assistant_id: assistantId,
    doctor_id: docA1Id,
    created_by: adminId,
  });
  if (assign.error) throw assign.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("write boundary — semantic events, real human actor", () => {
  it("stamps the acting human on a create → confirm → cancel lifecycle", async () => {
    const apptId = randomUUID();
    const insert = await admin.from("appointments").insert({
      id: apptId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: future(4),
      duration_minutes: 30,
      created_by: adminId,
      status: "pending",
    });
    expect(insert.error).toBeNull();

    await admin.from("appointments").update({ status: "confirmed" }).eq("id", apptId);
    await admin.from("appointments").update({ status: "cancelled" }).eq("id", apptId);

    const events = await eventsFor(service as unknown as Client, apptId);
    const actions = events.map((e) => e.action);
    expect(actions).toEqual([
      "appointment.created",
      "appointment.confirmed",
      "appointment.cancelled",
    ]);
    for (const e of events) {
      expect(e.actor_id).toBe(adminId);
      expect(e.actor_role).toBe("admin");
      expect(e.is_system).toBe(false);
      expect(e.entity_type).toBe("appointment");
      expect(e.doctor_id).toBe(docA1Id);
      expect(e.patient_id).toBe(patientA1);
    }

    await service.from("appointments").delete().eq("id", apptId);
  });

  it("records status undo as a reversal linked to the original action", async () => {
    const apptId = randomUUID();
    const insert = await admin.from("appointments").insert({
      id: apptId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: future(4.5),
      duration_minutes: 30,
      created_by: adminId,
      status: "pending",
    });
    expect(insert.error).toBeNull();

    const confirm = await admin
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", apptId);
    expect(confirm.error).toBeNull();

    const undo = await admin.rpc("undo_appointment_status", {
      p_appointment_id: apptId,
      p_target_status: "pending",
    });
    expect(undo.error).toBeNull();

    const events = await eventsFor(service as unknown as Client, apptId);
    expect(events.map((event) => event.action)).toEqual([
      "appointment.created",
      "appointment.confirmed",
      "appointment.confirmation_undone",
    ]);

    const confirmed = events.find(
      (event) => event.action === "appointment.confirmed",
    );
    const reversed = events.find(
      (event) => event.action === "appointment.confirmation_undone",
    );
    expect(reversed).toMatchObject({
      actor_id: adminId,
      actor_role: "admin",
      is_system: false,
      previous_state: expect.objectContaining({ status: "confirmed" }),
      new_state: expect.objectContaining({ status: "pending" }),
      metadata: expect.objectContaining({
        operation: "undo",
        original_action: "appointment.confirmed",
        original_event_id: confirmed?.id,
        target_status: "pending",
      }),
    });
    expect(events.some((event) => event.action === "appointment.deleted")).toBe(
      false,
    );

    await service.from("appointments").delete().eq("id", apptId);
  });

  it("records a system actor for service-role (non-human) writes", async () => {
    const apptId = randomUUID();
    await service.from("appointments").insert({
      id: apptId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: future(5),
      duration_minutes: 30,
      created_by: adminId,
      status: "pending",
    });

    const events = await eventsFor(service as unknown as Client, apptId);
    expect(events[0].action).toBe("appointment.created");
    expect(events[0].is_system).toBe(true);
    expect(events[0].actor_id).toBeNull();
    expect(events[0].actor_role).toBeNull();

    await service.from("appointments").delete().eq("id", apptId);
  });

  it("emits follow_up.recorded when a follow-up is logged", async () => {
    const fuId = randomUUID();
    const insert = await admin.from("follow_ups").insert({
      id: fuId,
      clinic_id: clinicA,
      appointment_id: null,
      patient_id: patientA1,
      outcome: "all_fine",
      recorded_by: adminId,
    });
    expect(insert.error).toBeNull();

    const events = await eventsFor(service as unknown as Client, fuId);
    expect(events.map((e) => e.action)).toContain("follow_up.recorded");
    const recorded = events.find((e) => e.action === "follow_up.recorded")!;
    expect(recorded.entity_type).toBe("follow_up");
    // Owning doctor derived from the patient's assigned doctor.
    expect(recorded.doctor_id).toBe(docA1Id);

    await service.from("follow_ups").delete().eq("id", fuId);
  });
});

describe("append-only immutability — no forged, edited, or deleted history", () => {
  let seedId = "";
  beforeAll(async () => {
    seedId = randomUUID();
    await service.from("appointments").insert({
      id: seedId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: future(6),
      duration_minutes: 30,
      created_by: adminId,
      status: "pending",
    });
  });
  afterAll(async () => {
    await service.from("appointments").delete().eq("id", seedId);
  });

  it("denies a client-forged event insert (actor spoof protection)", async () => {
    const forged = await admin.from("activity_events").insert({
      clinic_id: clinicA,
      actor_id: docA1Id, // pretend to be someone else
      action: "appointment.completed",
      entity_type: "appointment",
      entity_id: seedId,
    });
    expect(forged.error).not.toBeNull();
  });

  it("denies updating or deleting an existing event", async () => {
    const existing = await service
      .from("activity_events")
      .select("id")
      .eq("entity_id", seedId)
      .limit(1)
      .single();
    const eventId = existing.data!.id;

    const updated = await admin
      .from("activity_events")
      .update({ action: "appointment.deleted" })
      .eq("id", eventId);
    const deleted = await admin.from("activity_events").delete().eq("id", eventId);
    expect(updated.error).not.toBeNull();
    expect(deleted.error).not.toBeNull();

    // The row is untouched.
    const after = await service
      .from("activity_events")
      .select("action")
      .eq("id", eventId)
      .single();
    expect(after.data!.action).toBe("appointment.created");
  });
});

describe("read scope — mirrors entity visibility, never wider", () => {
  const apptA1 = randomUUID();
  const apptA2 = randomUUID();
  const apptB = randomUUID();

  beforeAll(async () => {
    await service.from("appointments").insert([
      {
        id: apptA1,
        clinic_id: clinicA,
        patient_id: patientA1,
        doctor_id: docA1Id,
        scheduled_at: future(7),
        duration_minutes: 30,
        created_by: adminId,
        status: "pending",
      },
      {
        id: apptA2,
        clinic_id: clinicA,
        patient_id: patientA2,
        doctor_id: docA2Id,
        scheduled_at: future(8),
        duration_minutes: 30,
        created_by: adminId,
        status: "pending",
      },
      {
        id: apptB,
        clinic_id: clinicB,
        patient_id: patientB,
        doctor_id: docBId,
        scheduled_at: future(9),
        duration_minutes: 30,
        created_by: adminId,
        status: "pending",
      },
    ]);
  });
  afterAll(async () => {
    await service.from("appointments").delete().in("id", [apptA1, apptA2, apptB]);
  });

  it("assistant sees supervised-doctor events only (A1), never A2 or clinic B", async () => {
    const a1 = await eventsFor(assistant, apptA1);
    expect(a1.length).toBeGreaterThan(0);

    const a2 = await assistant.from("activity_events").select("id").eq("entity_id", apptA2);
    expect(a2.data ?? []).toHaveLength(0);

    const b = await assistant.from("activity_events").select("id").eq("entity_id", apptB);
    expect(b.data ?? []).toHaveLength(0);
  });

  it("doctor sees their own events but not another doctor's", async () => {
    const own = await eventsFor(doctorA1, apptA1);
    expect(own.length).toBeGreaterThan(0);

    const other = await doctorA1.from("activity_events").select("id").eq("entity_id", apptA2);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("admin sees clinic-wide events but is isolated from another clinic", async () => {
    const inClinic = await eventsFor(admin, apptA2);
    expect(inClinic.length).toBeGreaterThan(0);

    const crossClinic = await admin.from("activity_events").select("id").eq("entity_id", apptB);
    expect(crossClinic.data ?? []).toHaveLength(0);
  });
});
