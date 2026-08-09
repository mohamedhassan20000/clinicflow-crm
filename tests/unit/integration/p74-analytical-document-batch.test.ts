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
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
type Client = SupabaseClient<Database>;

const suffix = `p74-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P74Analytical12345!";
const clinicA = randomUUID();
const clinicB = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const appointmentA = randomUUID();
const appointmentB = randomUUID();
const userIds: string[] = [];
const now = new Date();
const range = {
  p_start: new Date(now.valueOf() - 86_400_000).toISOString(),
  p_end: new Date(now.valueOf() + 86_400_000).toISOString(),
};

let adminA: Client;
let adminB: Client;
let doctorA: Client;
let adminAId = "";
let adminBId = "";
let doctorAId = "";
let doctorBId = "";
let documentId = "";
let documentNumber = "";

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
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("User creation returned no user");
  }
  userIds.push(created.data.user.id);
  const client = anonClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

function patientRow(
  id: string,
  clinicId: string,
  doctorId: string,
  createdBy: string,
  index: number,
) {
  return {
    id,
    clinic_id: clinicId,
    full_name: `P74 Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+905550074${String(index).padStart(3, "0")}`,
    email: `${suffix}-patient-${index}@example.com`,
    national_id: `${Date.now()}74${index}`,
    file_number: `P74-${index}`,
    assigned_doctor_id: doctorId,
    created_by: createdBy,
  };
}

async function cleanup() {
  await service.from("document_events").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("documents").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("document_counters").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("outstanding_settlements").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("follow_ups").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("appointments").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("patients").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  const [a, b, doctor, doctorB] = await Promise.all([
    createUser("admin-a"),
    createUser("admin-b"),
    createUser("doctor-a"),
    createUser("doctor-b"),
  ]);
  adminA = a.client;
  adminB = b.client;
  doctorA = doctor.client;
  adminAId = a.id;
  adminBId = b.id;
  doctorAId = doctor.id;
  doctorBId = doctorB.id;

  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P74 Clinic A ${suffix}` },
    { id: clinicB, name: `P74 Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: adminAId, clinic_id: clinicA, full_name: "P74 Admin A", role: "admin" },
    { id: adminBId, clinic_id: clinicB, full_name: "P74 Admin B", role: "admin" },
    { id: doctorAId, clinic_id: clinicA, full_name: "P74 Doctor A", role: "doctor" },
    { id: doctorBId, clinic_id: clinicB, full_name: "P74 Doctor B", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;
  const patients = await service.from("patients").insert([
    patientRow(patientA, clinicA, doctorAId, adminAId, 1),
    patientRow(patientB, clinicB, doctorBId, adminBId, 2),
  ]);
  if (patients.error) throw patients.error;
  const appointments = await service.from("appointments").insert([
    {
      id: appointmentA,
      clinic_id: clinicA,
      patient_id: patientA,
      doctor_id: doctorAId,
      created_by: adminAId,
      scheduled_at: now.toISOString(),
      status: "completed",
      paid_at: now.toISOString(),
      total_amount: 180,
      paid_amount: 100,
      secondary_amount: 30,
      secondary_payment_method: "credit_card",
      insurance_amount: 20,
      deposit_amount: 10,
      outstanding_amount: 20,
      payment_method: "cash",
    },
    {
      id: appointmentB,
      clinic_id: clinicB,
      patient_id: patientB,
      doctor_id: doctorBId,
      created_by: adminBId,
      scheduled_at: now.toISOString(),
      status: "completed",
      paid_at: now.toISOString(),
      total_amount: 999,
      paid_amount: 999,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: 0,
      payment_method: "cash",
    },
  ]);
  if (appointments.error) throw appointments.error;
  const followUps = await service.from("follow_ups").insert([
    {
      clinic_id: clinicA,
      appointment_id: appointmentA,
      patient_id: patientA,
      outcome: "all_fine",
      recorded_by: adminAId,
    },
    {
      clinic_id: clinicB,
      appointment_id: appointmentB,
      patient_id: patientB,
      outcome: "has_problem",
      recorded_by: adminBId,
    },
  ]);
  if (followUps.error) throw followUps.error;
  const settlement = await service.from("outstanding_settlements").insert({
    clinic_id: clinicA,
    patient_id: patientA,
    appointment_id: appointmentA,
    amount: 15,
    payment_method: "bank_transfer",
    settled_at: now.toISOString(),
    created_by: adminAId,
  });
  if (settlement.error) throw settlement.error;

  const reserved = await service.rpc("reserve_document_issue", {
    p_clinic_id: clinicA,
    p_actor_id: adminAId,
    p_doc_type: "SALES_REPORT",
    p_idempotency_key: `${suffix}:sales-issued`,
    p_locale: "en",
    p_numbering_prefix: "SAL",
    p_period_key: String(now.getUTCFullYear()),
    p_sequence_padding: 4,
    p_params: { from: range.p_start, to: range.p_end },
    p_snapshot: { version: 1, collectedTotal: 175 },
    p_watermark_snapshot: null,
  });
  if (reserved.error) throw reserved.error;
  documentId = reserved.data[0].document_id;
  documentNumber = reserved.data[0].document_number;
  const completed = await service.rpc("complete_document_issue", {
    p_clinic_id: clinicA,
    p_actor_id: adminAId,
    p_document_id: documentId,
    p_pdf_storage_path: `documents/${clinicA}/SALES_REPORT/${documentId}.pdf`,
    p_page_count: 1,
  });
  if (completed.error) throw completed.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P7-4 analytical data pipelines", () => {
  it("returns honest collection-period Sales totals without cross-clinic leakage", async () => {
    const { data, error } = await adminA.rpc("get_document_sales_report", range);
    if (error) throw error;
    expect(data).toMatchObject({
      serviceTotal: 180,
      primaryTotal: 100,
      secondaryTotal: 30,
      insuranceTotal: 20,
      depositTotal: 10,
      settlementTotal: 15,
      outstandingTotal: 20,
      collectedTotal: 175,
      transactionCount: 1,
      settlementCount: 1,
    });

    const clinicBResult = await adminB.rpc("get_document_sales_report", range);
    if (clinicBResult.error) throw clinicBResult.error;
    expect(clinicBResult.data).toMatchObject({
      serviceTotal: 999,
      collectedTotal: 999,
      transactionCount: 1,
    });
  });

  it("denies Sales to roles outside its financial report scope", async () => {
    const { error } = await doctorA.rpc("get_document_sales_report", range);
    expect(error?.code).toBe("42501");
  });

  it("scopes Follow-up Analytics to the caller and requested doctor", async () => {
    const { data, error } = await adminA.rpc(
      "get_document_follow_up_analytics_report",
      { ...range, p_doctor_id: doctorAId },
    );
    if (error) throw error;
    expect(data).toMatchObject({
      completedCount: 1,
      allFineCount: 1,
      hasProblemCount: 0,
      noResponseCount: 0,
    });

    const doctorResult = await doctorA.rpc(
      "get_document_follow_up_analytics_report",
      { ...range, p_doctor_id: doctorAId },
    );
    if (doctorResult.error) throw doctorResult.error;
    expect(doctorResult.data).toMatchObject({ completedCount: 1, allFineCount: 1 });

    const clinicBResult = await adminB.rpc(
      "get_document_follow_up_analytics_report",
      { ...range, p_doctor_id: doctorBId },
    );
    if (clinicBResult.error) throw clinicBResult.error;
    expect(clinicBResult.data).toMatchObject({ completedCount: 1, hasProblemCount: 1 });
  });

  it("reprints only the own-clinic canonical document and appends history", async () => {
    const { data, error } = await adminA.rpc("record_analytical_document_reprint", {
      p_document_id: documentId,
    });
    if (error) throw error;
    expect(data[0]).toEqual({
      pdf_storage_path: `documents/${clinicA}/SALES_REPORT/${documentId}.pdf`,
      document_number: documentNumber,
      print_count: 1,
    });

    const foreign = await adminB.rpc("record_analytical_document_reprint", {
      p_document_id: documentId,
    });
    expect(foreign.error?.code).toBe("P0002");
    const events = await service
      .from("document_events")
      .select("event")
      .eq("document_id", documentId)
      .order("occurred_at");
    if (events.error) throw events.error;
    expect(events.data.map((event) => event.event)).toEqual(["issued", "reprinted"]);
  });
});
