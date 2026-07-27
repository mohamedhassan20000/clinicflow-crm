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
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `replace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "ReplaceScope12345";
const clinicId = randomUUID();
const patientId = randomUUID();
const secondPatientId = randomUUID();
const concurrentPatientId = randomUUID();
const originalId = randomUUID();
const concurrentOriginalId = randomUUID();
const userIds: string[] = [];
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let admin: Client;
let adminId = "";
let doctorA: Client;
let doctorAId = "";
let doctorBId = "";
let assistant: Client;
let assistantId = "";
let firstReplacementId = "";
let activeReplacementId = "";

function client(): Client {
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
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("User creation failed");
  }
  userIds.push(created.data.user.id);
  const signedIn = client();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

function futureIso(days: number, hourOffset = 0) {
  return new Date(
    Date.now() + days * 86_400_000 + hourOffset * 3_600_000,
  ).toISOString();
}

async function cleanup() {
  await service.from("audit_logs").delete().eq("clinic_id", clinicId);
  await service
    .from("assistant_doctor_assignments")
    .delete()
    .eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  const [adminUser, doctorAUser, doctorBUser, assistantUser] =
    await Promise.all([
      createUser("admin"),
      createUser("doctor-a"),
      createUser("doctor-b"),
      createUser("assistant"),
    ]);
  admin = adminUser.client;
  adminId = adminUser.id;
  doctorA = doctorAUser.client;
  doctorAId = doctorAUser.id;
  doctorBId = doctorBUser.id;
  assistant = assistantUser.client;
  assistantId = assistantUser.id;

  await cleanup();
  const clinic = await service
    .from("clinics")
    .insert({ id: clinicId, name: `Replacement Clinic ${suffix}` });
  if (clinic.error) throw clinic.error;

  const profiles = await service.from("profiles").insert([
    {
      id: adminId,
      clinic_id: clinicId,
      full_name: "Replacement Admin",
      role: "admin",
      is_active: true,
    },
    {
      id: doctorAId,
      clinic_id: clinicId,
      full_name: "Replacement Doctor A",
      role: "doctor",
      is_active: true,
    },
    {
      id: doctorBId,
      clinic_id: clinicId,
      full_name: "Replacement Doctor B",
      role: "doctor",
      is_active: true,
    },
    {
      id: assistantId,
      clinic_id: clinicId,
      full_name: "Replacement Assistant",
      role: "assistant",
      is_active: true,
    },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    {
      id: patientId,
      clinic_id: clinicId,
      full_name: "Replacement Patient",
      date_of_birth: "1990-01-01",
      phone: `+965${Date.now().toString().slice(-8)}`,
      email: `${suffix}-patient-1@example.com`,
      national_id: `${Date.now()}-r1`,
      file_number: `${suffix}-p1`,
      assigned_doctor_id: doctorAId,
      created_by: adminId,
    },
    {
      id: secondPatientId,
      clinic_id: clinicId,
      full_name: "Replacement Slot Patient",
      date_of_birth: "1991-01-01",
      phone: `+966${Date.now().toString().slice(-8)}`,
      email: `${suffix}-patient-2@example.com`,
      national_id: `${Date.now()}-r2`,
      file_number: `${suffix}-p2`,
      assigned_doctor_id: doctorAId,
      created_by: adminId,
    },
    {
      id: concurrentPatientId,
      clinic_id: clinicId,
      full_name: "Concurrent Replacement Patient",
      date_of_birth: "1992-01-01",
      phone: `+967${Date.now().toString().slice(-8)}`,
      email: `${suffix}-patient-3@example.com`,
      national_id: `${Date.now()}-r3`,
      file_number: `${suffix}-p3`,
      assigned_doctor_id: doctorAId,
      created_by: adminId,
    },
  ]);
  if (patients.error) throw patients.error;

  const appointments = await service.from("appointments").insert([
    {
      id: originalId,
      clinic_id: clinicId,
      patient_id: patientId,
      doctor_id: doctorAId,
      scheduled_at: futureIso(10),
      duration_minutes: 30,
      status: "confirmed",
      created_by: adminId,
      notes: "Original preserved note",
    },
    {
      id: concurrentOriginalId,
      clinic_id: clinicId,
      patient_id: concurrentPatientId,
      doctor_id: doctorAId,
      scheduled_at: futureIso(20),
      duration_minutes: 30,
      status: "confirmed",
      created_by: adminId,
    },
  ]);
  if (appointments.error) throw appointments.error;

  const assignment = await service
    .from("assistant_doctor_assignments")
    .insert([
      {
        clinic_id: clinicId,
        assistant_id: assistantId,
        doctor_id: doctorAId,
        created_by: adminId,
      },
      {
        clinic_id: clinicId,
        assistant_id: assistantId,
        doctor_id: doctorBId,
        created_by: adminId,
      },
    ]);
  if (assignment.error) throw assignment.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(
    userIds.map((id) => service.auth.admin.deleteUser(id)),
  );
}, 60_000);

describe("Phase 6 replacement workflow (live Postgres)", () => {
  it("lets a doctor replace only their own appointment and preserves the original", async () => {
    const denied = await doctorA.rpc("replace_appointment", {
      p_original_id: concurrentOriginalId,
      p_scheduled_at: futureIso(21),
      p_doctor_id: doctorBId,
      p_duration_minutes: 30,
    });
    expect(denied.error?.code).toBe("42501");

    const replaced = await doctorA.rpc("replace_appointment", {
      p_original_id: originalId,
      p_scheduled_at: futureIso(5),
      p_doctor_id: doctorAId,
      p_duration_minutes: 30,
    });
    expect(replaced.error).toBeNull();
    firstReplacementId = replaced.data ?? "";
    expect(firstReplacementId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const { data: rows, error } = await service
      .from("appointments")
      .select(
        "id, status, notes, replaces_appointment_id, replaced_by_appointment_id, original_appointment_id",
      )
      .in("id", [originalId, firstReplacementId]);
    expect(error).toBeNull();
    const original = rows?.find((row) => row.id === originalId);
    const replacement = rows?.find(
      (row) => row.id === firstReplacementId,
    );
    expect(original).toMatchObject({
      status: "replaced",
      notes: "Original preserved note",
      replaced_by_appointment_id: firstReplacementId,
    });
    expect(replacement).toMatchObject({
      status: "confirmed",
      notes: "Original preserved note",
      replaces_appointment_id: originalId,
      original_appointment_id: originalId,
    });
  });

  it("builds an ordered A -> B -> C chain even when dates move backward", async () => {
    const replaced = await assistant.rpc("replace_appointment", {
      p_original_id: firstReplacementId,
      p_scheduled_at: futureIso(7),
      p_doctor_id: doctorBId,
      p_duration_minutes: 30,
    });
    expect(replaced.error).toBeNull();
    activeReplacementId = replaced.data ?? "";

    const chain = await admin.rpc("get_appointment_replacement_chain", {
      p_appointment_id: firstReplacementId,
    });
    expect(chain.error).toBeNull();
    expect(chain.data?.map((row) => row.id)).toEqual([
      originalId,
      firstReplacementId,
      activeReplacementId,
    ]);
    expect(chain.data?.map((row) => row.chain_position)).toEqual([1, 2, 3]);
    expect(chain.data?.map((row) => row.status)).toEqual([
      "replaced",
      "replaced",
      "confirmed",
    ]);
  });

  it("re-scopes assistants immediately after unassignment", async () => {
    const removed = await service
      .from("assistant_doctor_assignments")
      .delete()
      .eq("assistant_id", assistantId)
      .eq("doctor_id", doctorBId);
    expect(removed.error).toBeNull();

    const denied = await assistant.rpc("replace_appointment", {
      p_original_id: activeReplacementId,
      p_scheduled_at: futureIso(8),
      p_doctor_id: doctorAId,
      p_duration_minutes: 30,
    });
    expect(denied.error?.code).toBe("42501");
  });

  it("frees the original slot and writes audit history for both sides", async () => {
    const original = await service
      .from("appointments")
      .select("scheduled_at")
      .eq("id", originalId)
      .single();
    expect(original.error).toBeNull();

    const slotReuse = await service.from("appointments").insert({
      clinic_id: clinicId,
      patient_id: secondPatientId,
      doctor_id: doctorAId,
      scheduled_at: original.data?.scheduled_at ?? futureIso(10),
      duration_minutes: 30,
      status: "confirmed",
      created_by: adminId,
    });
    expect(slotReuse.error).toBeNull();

    const audit = await service
      .from("audit_logs")
      .select("action, record_id")
      .eq("clinic_id", clinicId)
      .in("record_id", [
        originalId,
        firstReplacementId,
        activeReplacementId,
      ]);
    expect(audit.error).toBeNull();
    expect(
      audit.data?.some(
        (row) => row.record_id === originalId && row.action === "UPDATE",
      ),
    ).toBe(true);
    expect(
      audit.data?.some(
        (row) =>
          row.record_id === firstReplacementId && row.action === "INSERT",
      ),
    ).toBe(true);
  });

  it("allows exactly one winner when two replacements race", async () => {
    const results = await Promise.all([
      admin.rpc("replace_appointment", {
        p_original_id: concurrentOriginalId,
        p_scheduled_at: futureIso(21),
        p_doctor_id: doctorAId,
        p_duration_minutes: 30,
      }),
      admin.rpc("replace_appointment", {
        p_original_id: concurrentOriginalId,
        p_scheduled_at: futureIso(22),
        p_doctor_id: doctorAId,
        p_duration_minutes: 30,
      }),
    ]);

    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(results.filter((result) => result.error !== null)).toHaveLength(1);
    const successors = await service
      .from("appointments")
      .select("id")
      .eq("replaces_appointment_id", concurrentOriginalId);
    expect(successors.error).toBeNull();
    expect(successors.data).toHaveLength(1);
  });

  it("keeps replacement KPIs separate from cancellation/no-show totals", async () => {
    const report = await admin.rpc("get_cancellation_report", {
      p_start: futureIso(0, -1),
      p_end: futureIso(30),
    });
    expect(report.error).toBeNull();
    const payload = report.data as {
      replacedCount: number;
      cancelledCount: number;
      totalAppointments: number;
      replacementRate: number;
    };
    expect(payload.replacedCount).toBeGreaterThanOrEqual(3);
    expect(payload.cancelledCount).toBe(0);
    expect(payload.totalAppointments).toBeGreaterThan(0);
    expect(payload.replacementRate).toBeGreaterThan(0);
  });
});
