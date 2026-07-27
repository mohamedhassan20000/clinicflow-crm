import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// Phase 8A — "My Revenue" data scope, proven against live Postgres because the
// guarantee is a database property: a doctor sees ONLY their own collected
// revenue; an assistant sees ONLY the union of their assigned doctors' revenue;
// nobody else may run the RPC at all; and it never crosses clinics. The RPC is
// SECURITY INVOKER over RLS-scoped appointments, so only a real session can
// prove the scoping.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `myrev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "MyRevScope12345";
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

const RANGE = {
  p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
};
const inRange = () => new Date(Date.now() - 86_400_000).toISOString();

type MyRevenue = {
  grossTotal: number;
  primaryTotal: number;
  transactionCount: number;
  outstandingTotal: number;
};

let assistant: Client;
let assistantId = "";
let doctorA1: Client;
let doctorA2: Client;
let adminA: Client;
let receptionistA: Client;
let adminAId = "";
let docA1Id = "";
let docA2Id = "";
let docBId = "";

const patientA1 = randomUUID();
const patientA2 = randomUUID();
const patientB = randomUUID();

function patientRow(clinicId: string, createdBy: string, doctorId: string, id: string, index: number) {
  return {
    id,
    clinic_id: clinicId,
    full_name: `MyRev Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655200${String(index).padStart(4, "0")}`,
    email: `${suffix}-p${index}-${clinicId.slice(0, 8)}@example.com`,
    national_id: `${Date.now()}${index}${clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${clinicId.slice(0, 4)}-${index}`,
    assigned_doctor_id: doctorId,
    created_by: createdBy,
  };
}

// A completed, paid appointment contributing `primary` to gross and `outstanding`.
function paidAppt(
  clinicId: string,
  patientId: string,
  doctorId: string,
  createdBy: string,
  primary: number,
  outstanding: number,
) {
  return {
    id: randomUUID(),
    clinic_id: clinicId,
    patient_id: patientId,
    doctor_id: doctorId,
    scheduled_at: inRange(),
    duration_minutes: 30,
    created_by: createdBy,
    status: "completed" as const,
    paid_at: inRange(),
    total_amount: primary + outstanding,
    paid_amount: primary,
    outstanding_amount: outstanding,
    payment_method: "cash" as const,
  };
}

async function cleanup() {
  await service.from("assistant_doctor_assignments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("appointments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [admin, d1, d2, asst, recep, adminB, docB] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a1"),
    createUser("doctor-a2"),
    createUser("assistant"),
    createUser("receptionist-a"),
    createUser("admin-b"),
    createUser("doctor-b"),
  ]);
  adminA = admin.client;
  adminAId = admin.id;
  doctorA1 = d1.client;
  doctorA2 = d2.client;
  docA1Id = d1.id;
  docA2Id = d2.id;
  assistant = asst.client;
  assistantId = asst.id;
  receptionistA = recep.client;
  docBId = docB.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `MyRev Clinic A ${suffix}` },
    { id: clinicB, name: `MyRev Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: admin.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: d1.id, clinic_id: clinicA, full_name: "Doctor A1", role: "doctor", is_active: true },
    { id: d2.id, clinic_id: clinicA, full_name: "Doctor A2", role: "doctor", is_active: true },
    { id: asst.id, clinic_id: clinicA, full_name: "Assistant", role: "assistant", is_active: true },
    { id: recep.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    patientRow(clinicA, adminAId, docA1Id, patientA1, 1),
    patientRow(clinicA, adminAId, docA2Id, patientA2, 2),
    patientRow(clinicB, adminB.id, docBId, patientB, 3),
  ]);
  if (patients.error) throw patients.error;

  const appts = await service.from("appointments").insert([
    // Doctor A1: 100 collected + 20 outstanding.
    paidAppt(clinicA, patientA1, docA1Id, adminAId, 100, 20),
    // Doctor A2: 250 collected + 0 outstanding.
    paidAppt(clinicA, patientA2, docA2Id, adminAId, 250, 0),
    // Clinic B doctor: 999 collected — must never appear in clinic A scopes.
    paidAppt(clinicB, patientB, docBId, adminB.id, 999, 0),
  ]);
  if (appts.error) throw appts.error;

  // Assign the assistant to Doctor A1 only, to start.
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

describe("My Revenue — doctor sees only their own collected revenue", () => {
  it("scopes get_my_revenue_summary to the doctor's own appointments", async () => {
    const { data, error } = await doctorA1.rpc("get_my_revenue_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as MyRevenue;
    expect(r.grossTotal).toBe(100);
    expect(r.primaryTotal).toBe(100);
    expect(r.transactionCount).toBe(1);
    expect(r.outstandingTotal).toBe(20);
  });

  it("gives a different doctor only their own figure (never the other doctor's)", async () => {
    const { data, error } = await doctorA2.rpc("get_my_revenue_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as MyRevenue;
    expect(r.grossTotal).toBe(250);
    expect(r.transactionCount).toBe(1);
  });
});

describe("My Revenue — assistant sees the supervised-doctor union only", () => {
  it("with one assigned doctor, sees only that doctor's revenue", async () => {
    const { data, error } = await assistant.rpc("get_my_revenue_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as MyRevenue;
    expect(r.grossTotal).toBe(100);
    expect(r.transactionCount).toBe(1);
  });

  it("unions both doctors' revenue once a second doctor is assigned", async () => {
    const assign = await service.from("assistant_doctor_assignments").insert({
      clinic_id: clinicA,
      assistant_id: assistantId,
      doctor_id: docA2Id,
      created_by: adminAId,
    });
    expect(assign.error).toBeNull();

    const { data, error } = await assistant.rpc("get_my_revenue_summary", RANGE);
    expect(error).toBeNull();
    const r = data as unknown as MyRevenue;
    // 100 (A1) + 250 (A2). Clinic B's 999 never included.
    expect(r.grossTotal).toBe(350);
    expect(r.transactionCount).toBe(2);
  });

  it("re-scopes immediately when a doctor is unassigned", async () => {
    const remove = await service
      .from("assistant_doctor_assignments")
      .delete()
      .eq("assistant_id", assistantId)
      .eq("doctor_id", docA2Id);
    expect(remove.error).toBeNull();

    const { data } = await assistant.rpc("get_my_revenue_summary", RANGE);
    const r = data as unknown as MyRevenue;
    expect(r.grossTotal).toBe(100);
  });
});

describe("My Revenue — non-doctor/assistant callers are denied", () => {
  it("denies admin (uses the clinic-wide revenue report instead)", async () => {
    const { error } = await adminA.rpc("get_my_revenue_summary", RANGE);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("denies receptionist", async () => {
    const { error } = await receptionistA.rpc("get_my_revenue_summary", RANGE);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("denies an anonymous caller", async () => {
    const { error } = await anonClient().rpc("get_my_revenue_summary", RANGE);
    expect(error).not.toBeNull();
  });
});
