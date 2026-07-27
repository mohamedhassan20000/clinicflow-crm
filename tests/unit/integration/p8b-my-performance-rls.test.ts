import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// Phase 8B — "My Performance" data scope, proven against live Postgres because
// the guarantee is a database property: a doctor sees ONLY their own sessions
// (the appointments they are the treating doctor for — never another doctor's,
// not even for a patient assigned to them); the RPC hard-denies every other
// role; and it never crosses clinics. The RPC is SECURITY INVOKER with an
// explicit `doctor_id = auth.uid()` predicate, so only a real session proves it.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `myperf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "MyPerfScope12345";
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

// A fixed UTC day inside the range, so activeDays / averagePatientsPerDay are
// deterministic (both completed sessions land on the same calendar day).
const DAY = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

const RANGE = {
  p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
};

type Perf = {
  appointmentCount: number;
  completedCount: number;
  cancelledCount: number;
  cancellationRate: number;
  noShowCount: number;
  noShowRate: number;
  replacedCount: number;
  uniquePatients: number;
  activeDays: number;
  averagePatientsPerDay: number;
  followupsEligible: number;
  followupsCompleted: number;
  followupCompletionRate: number;
  overdueFollowups: number;
  previousCompletedCount: number;
  completedTrendPct: number | null;
};

let doctorA1: Client;
let doctorA2: Client;
let adminA: Client;
let receptionistA: Client;
let assistant: Client;
let adminAId = "";
let docA1Id = "";
let docA2Id = "";
let assistantId = "";
let docBId = "";

const patientA1 = randomUUID();
const patientA1b = randomUUID();
const patientA2 = randomUUID();
const patientB = randomUUID();

function patientRow(clinicId: string, createdBy: string, doctorId: string, id: string, index: number) {
  return {
    id,
    clinic_id: clinicId,
    full_name: `MyPerf Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655300${String(index).padStart(4, "0")}`,
    email: `${suffix}-p${index}-${clinicId.slice(0, 8)}@example.com`,
    national_id: `${Date.now()}${index}${clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${clinicId.slice(0, 4)}-${index}`,
    assigned_doctor_id: doctorId,
    created_by: createdBy,
  };
}

function appt(args: {
  clinicId: string;
  patientId: string;
  doctorId: string;
  createdBy: string;
  status: "completed" | "cancelled" | "no_show";
  scheduledAt: string;
}) {
  return {
    id: randomUUID(),
    clinic_id: args.clinicId,
    patient_id: args.patientId,
    doctor_id: args.doctorId,
    scheduled_at: args.scheduledAt,
    duration_minutes: 30,
    created_by: args.createdBy,
    status: args.status,
  };
}

async function cleanup() {
  await service.from("follow_ups").delete().in("clinic_id", ALL_CLINICS);
  await service.from("assistant_doctor_assignments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("appointments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [admin, d1, d2, recep, asst, adminB, docB] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a1"),
    createUser("doctor-a2"),
    createUser("receptionist-a"),
    createUser("assistant"),
    createUser("admin-b"),
    createUser("doctor-b"),
  ]);
  adminA = admin.client;
  adminAId = admin.id;
  doctorA1 = d1.client;
  doctorA2 = d2.client;
  docA1Id = d1.id;
  docA2Id = d2.id;
  receptionistA = recep.client;
  assistant = asst.client;
  assistantId = asst.id;
  docBId = docB.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `MyPerf Clinic A ${suffix}` },
    { id: clinicB, name: `MyPerf Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: admin.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: d1.id, clinic_id: clinicA, full_name: "Doctor A1", role: "doctor", is_active: true },
    { id: d2.id, clinic_id: clinicA, full_name: "Doctor A2", role: "doctor", is_active: true },
    { id: recep.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist", is_active: true },
    { id: asst.id, clinic_id: clinicA, full_name: "Assistant", role: "assistant", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    patientRow(clinicA, adminAId, docA1Id, patientA1, 1),
    patientRow(clinicA, adminAId, docA1Id, patientA1b, 2),
    patientRow(clinicA, adminAId, docA2Id, patientA2, 3),
    patientRow(clinicB, adminB.id, docBId, patientB, 4),
  ]);
  if (patients.error) throw patients.error;

  const c1 = appt({ clinicId: clinicA, patientId: patientA1, doctorId: docA1Id, createdBy: adminAId, status: "completed", scheduledAt: at("09:00") });
  const c2 = appt({ clinicId: clinicA, patientId: patientA1b, doctorId: docA1Id, createdBy: adminAId, status: "completed", scheduledAt: at("10:00") });
  const appts = await service.from("appointments").insert([
    // Doctor A1's OWN sessions: 2 completed, 1 cancelled, 1 no-show.
    c1,
    c2,
    appt({ clinicId: clinicA, patientId: patientA1, doctorId: docA1Id, createdBy: adminAId, status: "cancelled", scheduledAt: at("11:00") }),
    appt({ clinicId: clinicA, patientId: patientA1, doctorId: docA1Id, createdBy: adminAId, status: "no_show", scheduledAt: at("12:00") }),
    // Doctor A2's own completed session — must never enter A1's report.
    appt({ clinicId: clinicA, patientId: patientA2, doctorId: docA2Id, createdBy: adminAId, status: "completed", scheduledAt: at("09:30") }),
    // Doctor A2 treating a patient ASSIGNED to A1. A1's broader RLS admits this
    // row, but "my performance" filters on doctor_id, so it must NOT count.
    appt({ clinicId: clinicA, patientId: patientA1, doctorId: docA2Id, createdBy: adminAId, status: "completed", scheduledAt: at("13:00") }),
    // Clinic B — never in any clinic A scope.
    appt({ clinicId: clinicB, patientId: patientB, doctorId: docBId, createdBy: adminB.id, status: "completed", scheduledAt: at("09:00") }),
  ]);
  if (appts.error) throw appts.error;

  // One follow-up recorded against A1's first completed appointment. The second
  // completed appointment has none → 1 completed / 1 overdue.
  const fu = await service.from("follow_ups").insert({
    clinic_id: clinicA,
    appointment_id: c1.id,
    patient_id: patientA1,
    outcome: "all_fine",
    recorded_by: adminAId,
  });
  if (fu.error) throw fu.error;

  // Assign the assistant to A1 (to prove assistants are still denied the RPC).
  const assign = await service.from("assistant_doctor_assignments").insert({
    clinic_id: clinicA,
    assistant_id: assistantId,
    doctor_id: docA1Id,
    created_by: adminAId,
  });
  if (assign.error) throw assign.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("My Performance — a doctor sees only their own sessions", () => {
  it("computes lifecycle KPIs from the doctor's own appointments only", async () => {
    const { data, error } = await doctorA1.rpc("get_my_performance_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as Perf;
    // 2 completed + 1 cancelled + 1 no-show = 4 own non-replaced sessions.
    // The A2-treated appointment for A1's patient is excluded.
    expect(r.appointmentCount).toBe(4);
    expect(r.completedCount).toBe(2);
    expect(r.cancelledCount).toBe(1);
    expect(r.noShowCount).toBe(1);
    expect(r.cancellationRate).toBe(25);
    expect(r.noShowRate).toBe(25);
    expect(r.replacedCount).toBe(0);
    expect(r.uniquePatients).toBe(2);
  });

  it("derives follow-up completion and overdue counts from own completed appointments", async () => {
    const { data } = await doctorA1.rpc("get_my_performance_summary", RANGE);
    const r = data as unknown as Perf;
    expect(r.followupsEligible).toBe(2);
    expect(r.followupsCompleted).toBe(1);
    expect(r.followupCompletionRate).toBe(50);
    expect(r.overdueFollowups).toBe(1);
  });

  it("computes average patients per active day", async () => {
    const { data } = await doctorA1.rpc("get_my_performance_summary", RANGE);
    const r = data as unknown as Perf;
    // Both completed sessions on the same UTC day → 1 active day, 2 / 1 = 2.
    expect(r.activeDays).toBe(1);
    expect(r.averagePatientsPerDay).toBe(2);
  });

  it("gives the other doctor only their own single completed session", async () => {
    const { data, error } = await doctorA2.rpc("get_my_performance_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as Perf;
    // A2 has one own completed + one treating A1's patient = 2 own completed.
    expect(r.completedCount).toBe(2);
    expect(r.appointmentCount).toBe(2);
  });

  it("reports no prior baseline as a null trend", async () => {
    const { data } = await doctorA1.rpc("get_my_performance_summary", RANGE);
    const r = data as unknown as Perf;
    expect(r.previousCompletedCount).toBe(0);
    expect(r.completedTrendPct).toBeNull();
  });
});

describe("My Performance — non-doctor callers are denied", () => {
  it("denies admin (uses the clinic-wide doctor-performance report instead)", async () => {
    const { error } = await adminA.rpc("get_my_performance_summary", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies receptionist", async () => {
    const { error } = await receptionistA.rpc("get_my_performance_summary", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies assistant (their operational activity is measured under 8C)", async () => {
    const { error } = await assistant.rpc("get_my_performance_summary", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies an anonymous caller", async () => {
    const { error } = await anonClient().rpc("get_my_performance_summary", RANGE);
    expect(error).not.toBeNull();
  });
});
