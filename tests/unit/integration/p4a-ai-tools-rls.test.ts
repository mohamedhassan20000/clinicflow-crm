import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Json } from "@/types/database";

// P4A two-clinic denial suite (§10's most important suite). Asserts:
//   * agent_conversations / agent_messages are owner-scoped — a staff member
//     sees only their own chats, never a colleague's, never another clinic's,
//     and receptionist/manager roles see nothing at all.
//   * clinic_faq is clinic-readable but not authenticated-writable in P4A.
//   * log_agent_tool_call is service-role only; a clinic user cannot forge an
//     audit entry, and a real entry lands in audit_logs for the clinic admin.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p4a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P4aTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const convDoctorA = randomUUID();
const convDoctorB = randomUUID();
const msgDoctorA = randomUUID();
const faqA = randomUUID();
const faqB = randomUUID();
const departmentA = randomUUID();
const departmentB = randomUUID();
const patientDepartmentA = randomUUID();
const patientDepartmentB = randomUUID();
const patientClinicB = randomUUID();
const appointmentDepartmentA = randomUUID();
const appointmentDepartmentB = randomUUID();
const appointmentClinicB = randomUUID();
const noteDepartmentA = randomUUID();
const noteDepartmentB = randomUUID();
const noteClinicB = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
let adminA: Client;
let doctorA: Client;
let receptionistA: Client;
let managerA: Client;
let doctorDepartmentB: Client;
let doctorB: Client;
let anon: Client;
let doctorAId = "";
let receptionistAId = "";
let managerAId = "";
let doctorDepartmentBId = "";
let doctorBId = "";

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p4a-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? `create ${label}`);
  userIds.push(data.user.id);
  const signedIn = client();
  const login = await signedIn.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client: signedIn };
}

async function cleanup() {
  await service.from("agent_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("agent_conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinic_faq").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("medical_notes").delete().in("id", [noteDepartmentA, noteDepartmentB, noteClinicB]);
  await service.from("appointments").delete().in("id", [appointmentDepartmentA, appointmentDepartmentB, appointmentClinicB]);
  await service.from("patients").delete().in("id", [patientDepartmentA, patientDepartmentB, patientClinicB]);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("departments").delete().in("id", [departmentA, departmentB]);
  await service.from("audit_logs").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

async function buildLiveDoctorTools(dbClient: Client, user: {
  id: string;
  clinicId: string;
  role: "admin" | "receptionist" | "manager" | "doctor";
  departmentId: string | null;
}) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  // This is dependency adaptation, not a data mock: every .from() call made by
  // the production tool goes to this real signed-in local-Supabase client, so
  // Postgres RLS decides which clinical rows are returned.
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => dbClient),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: user.clinicId,
      planSlug: "pro_ai",
      features: { ai_assistant: true },
      limits: {},
      subscriptionAllowed: true,
    })),
    hasFeature: (
      entitlements: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => entitlements.subscriptionAllowed && entitlements.features[key] === true,
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async (input: {
      clinicId: string;
      actorId: string | null;
      tool: string;
      tableName?: string | null;
      recordId?: string | null;
      summary?: Record<string, unknown>;
    }) => service.rpc("log_agent_tool_call", {
      p_clinic_id: input.clinicId,
      p_actor_id: input.actorId ?? undefined,
      p_tool: input.tool,
      p_table_name: input.tableName ?? undefined,
      p_record_id: input.recordId ?? undefined,
      p_summary: (input.summary ?? {}) as Json,
    })),
  }));

  const { buildDoctorTools } = await import("@/lib/ai/tools");
  return buildDoctorTools({
    user: {
      ...user,
      email: `${user.id}@example.test`,
      fullName: "Integration User",
      avatarUrl: null,
      mustChangePassword: false,
    },
    locale: "en",
  });
}

beforeAll(async () => {
  const [admin, doctor, receptionist, manager, departmentDoctor, docB] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a"),
    createUser("receptionist-a"),
    createUser("manager-a"),
    createUser("doctor-department-b"),
    createUser("doctor-b"),
  ]);
  adminA = admin.client;
  doctorA = doctor.client;
  receptionistA = receptionist.client;
  managerA = manager.client;
  doctorDepartmentB = departmentDoctor.client;
  doctorB = docB.client;
  doctorAId = doctor.id;
  receptionistAId = receptionist.id;
  managerAId = manager.id;
  doctorDepartmentBId = departmentDoctor.id;
  doctorBId = docB.id;
  anon = client();

  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P4A Clinic A ${suffix}` },
    { id: clinicB, name: `P4A Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const departments = await service.from("departments").insert([
    { id: departmentA, clinic_id: clinicA, name: `P4A Department A ${suffix}` },
    { id: departmentB, clinic_id: clinicA, name: `P4A Department B ${suffix}` },
  ]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    { id: admin.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: doctor.id, clinic_id: clinicA, department_id: departmentA, full_name: "Doctor A", role: "doctor" },
    { id: receptionist.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist" },
    { id: manager.id, clinic_id: clinicA, full_name: "Manager A", role: "manager" },
    { id: departmentDoctor.id, clinic_id: clinicA, department_id: departmentB, full_name: "Doctor Department B", role: "doctor" },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    {
      id: patientDepartmentA,
      clinic_id: clinicA,
      full_name: "Department A Patient",
      date_of_birth: "1990-01-01",
      phone: "+96550000001",
      email: `${suffix}-patient-a@example.com`,
      national_id: `${Date.now()}01`,
      file_number: `${suffix}-a`,
      created_by: admin.id,
      department_id: departmentA,
      assigned_doctor_id: doctor.id,
    },
    {
      id: patientDepartmentB,
      clinic_id: clinicA,
      full_name: "Department B Patient",
      date_of_birth: "1985-05-05",
      phone: "+96550000002",
      email: `${suffix}-patient-b@example.com`,
      national_id: `${Date.now()}02`,
      file_number: `${suffix}-b`,
      created_by: admin.id,
      department_id: departmentB,
      assigned_doctor_id: departmentDoctor.id,
    },
    {
      id: patientClinicB,
      clinic_id: clinicB,
      full_name: "Other Clinic Patient",
      date_of_birth: "1980-08-08",
      phone: "+96550000003",
      email: `${suffix}-patient-c@example.com`,
      national_id: `${Date.now()}03`,
      file_number: `${suffix}-c`,
      created_by: docB.id,
      assigned_doctor_id: docB.id,
    },
  ]);
  if (patients.error) throw patients.error;

  const appointments = await service.from("appointments").insert([
    {
      id: appointmentDepartmentA,
      clinic_id: clinicA,
      patient_id: patientDepartmentA,
      doctor_id: doctor.id,
      department_id: departmentA,
      scheduled_at: "2026-07-15T07:00:00.000Z",
      status: "completed",
      created_by: admin.id,
    },
    {
      id: appointmentDepartmentB,
      clinic_id: clinicA,
      patient_id: patientDepartmentB,
      doctor_id: departmentDoctor.id,
      department_id: departmentB,
      scheduled_at: "2026-07-16T07:00:00.000Z",
      status: "completed",
      created_by: admin.id,
    },
    {
      id: appointmentClinicB,
      clinic_id: clinicB,
      patient_id: patientClinicB,
      doctor_id: docB.id,
      scheduled_at: "2026-07-17T07:00:00.000Z",
      status: "completed",
      created_by: docB.id,
    },
  ]);
  if (appointments.error) throw appointments.error;

  const notes = await service.from("medical_notes").insert([
    { id: noteDepartmentA, patient_id: patientDepartmentA, doctor_id: doctor.id, created_by: doctor.id, note: "Department A clinical marker" },
    { id: noteDepartmentB, patient_id: patientDepartmentB, doctor_id: departmentDoctor.id, created_by: departmentDoctor.id, note: "Department B confidential clinical marker" },
    { id: noteClinicB, patient_id: patientClinicB, doctor_id: docB.id, created_by: docB.id, note: "Other clinic confidential clinical marker" },
  ]);
  if (notes.error) throw notes.error;

  const conversations = await service.from("agent_conversations").insert([
    { id: convDoctorA, clinic_id: clinicA, user_id: doctor.id, persona: "doctor" },
    { id: convDoctorB, clinic_id: clinicB, user_id: docB.id, persona: "doctor" },
  ]);
  if (conversations.error) throw conversations.error;

  const messages = await service.from("agent_messages").insert([
    { id: msgDoctorA, clinic_id: clinicA, conversation_id: convDoctorA, role: "user", content: "summarize patient" },
  ]);
  if (messages.error) throw messages.error;

  const faqs = await service.from("clinic_faq").insert([
    { id: faqA, clinic_id: clinicA, question: "Working hours?", answer: "9-5", language: "en" },
    { id: faqB, clinic_id: clinicB, question: "Parking?", answer: "Yes", language: "en" },
  ]);
  if (faqs.error) throw faqs.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)));
  await Promise.all([
    adminA?.auth.signOut(),
    doctorA?.auth.signOut(),
    receptionistA?.auth.signOut(),
    managerA?.auth.signOut(),
    doctorDepartmentB?.auth.signOut(),
    doctorB?.auth.signOut(),
  ]);
}, 60_000);

describe("P4A doctor tools through live clinical RLS", () => {
  const toolOptions = {} as never;

  it("denies doctor A a summary and visit search for doctor B's department patient", async () => {
    const tools = await buildLiveDoctorTools(doctorA, {
      id: doctorAId,
      clinicId: clinicA,
      role: "doctor",
      departmentId: departmentA,
    });

    const summary = await tools.get_patient_summary.execute!(
      { patient_id: patientDepartmentB },
      toolOptions,
    );
    expect(summary).toMatchObject({ found: false });
    expect(summary).not.toHaveProperty("patient");

    const visits = await tools.search_patient_visits.execute!(
      { patient_id: patientDepartmentB, query: "confidential" },
      toolOptions,
    );
    expect(visits).toEqual({ found: false, notes: [], appointments: [] });
  });

  it("returns the same patient's real clinical summary to the matching department doctor", async () => {
    const tools = await buildLiveDoctorTools(doctorDepartmentB, {
      id: doctorDepartmentBId,
      clinicId: clinicA,
      role: "doctor",
      departmentId: departmentB,
    });

    const summary = (await tools.get_patient_summary.execute!(
      { patient_id: patientDepartmentB },
      toolOptions,
    )) as {
      found: boolean;
      patient: { full_name: string };
      notes: { excerpt: string }[];
      appointments: { date: string }[];
    };
    expect(summary).toMatchObject({
      found: true,
      patient: { full_name: "Department B Patient" },
    });
    expect(summary.notes).toEqual([
      expect.objectContaining({ excerpt: "Department B confidential clinical marker" }),
    ]);
    expect(summary.appointments).toEqual([
      expect.objectContaining({ date: "2026-07-16T07:00:00+00:00" }),
    ]);
  });

  it("denies a cross-clinic patient through both patient tools", async () => {
    const tools = await buildLiveDoctorTools(doctorA, {
      id: doctorAId,
      clinicId: clinicA,
      role: "doctor",
      departmentId: departmentA,
    });
    await expect(
      tools.get_patient_summary.execute!({ patient_id: patientClinicB }, toolOptions),
    ).resolves.toMatchObject({ found: false });
    await expect(
      tools.search_patient_visits.execute!(
        { patient_id: patientClinicB, query: "confidential" },
        toolOptions,
      ),
    ).resolves.toEqual({ found: false, notes: [], appointments: [] });
  });

  it.each([
    ["receptionist", () => receptionistA],
    ["manager", () => managerA],
  ] as const)("rejects the %s persona at the tool boundary", async (role, getClient) => {
    const tools = await buildLiveDoctorTools(getClient(), {
      id: role === "receptionist" ? receptionistAId : managerAId,
      clinicId: clinicA,
      role,
      departmentId: null,
    });
    await expect(
      tools.get_patient_summary.execute!({ patient_id: patientDepartmentA }, toolOptions),
    ).rejects.toMatchObject({ reason: "role_forbidden" });
  });
});

describe("P4A agent conversation RLS", () => {
  it("lets the owner read their own conversation and messages", async () => {
    const conv = await doctorA.from("agent_conversations").select("id, user_id");
    expect(conv.error).toBeNull();
    expect(conv.data).toEqual([{ id: convDoctorA, user_id: doctorAId }]);

    const msg = await doctorA.from("agent_messages").select("id");
    expect(msg.error).toBeNull();
    expect(msg.data).toEqual([{ id: msgDoctorA }]);
  });

  it("hides a colleague's conversation from another staff member in the same clinic", async () => {
    // Admin A is in clinic A but is NOT the owner of doctor A's conversation.
    const conv = await adminA.from("agent_conversations").select("id");
    expect(conv.error).toBeNull();
    expect(conv.data).toEqual([]);
    const msg = await adminA.from("agent_messages").select("id");
    expect(msg.data).toEqual([]);
  });

  it("denies conversations to receptionist/manager roles entirely", async () => {
    const conv = await receptionistA.from("agent_conversations").select("id");
    expect(conv.data).toEqual([]);
  });

  it("denies cross-clinic reads", async () => {
    const conv = await doctorB.from("agent_conversations").select("id").eq("clinic_id", clinicA);
    expect(conv.data).toEqual([]);
    const msg = await doctorB.from("agent_messages").select("id").eq("clinic_id", clinicA);
    expect(msg.data).toEqual([]);
  });

  it("denies anonymous access", async () => {
    const conv = await anon.from("agent_conversations").select("id");
    expect(conv.data ?? []).toEqual([]);
    const faq = await anon.from("clinic_faq").select("id");
    expect(faq.data ?? []).toEqual([]);
  });

  it("lets the owner insert their own conversation but not one owned by someone else or another clinic", async () => {
    const own = await doctorA
      .from("agent_conversations")
      .insert({ clinic_id: clinicA, user_id: doctorAId, persona: "doctor" })
      .select("id");
    expect(own.error).toBeNull();
    expect(own.data?.length).toBe(1);
    if (own.data?.[0]) {
      await service.from("agent_conversations").delete().eq("id", own.data[0].id);
    }

    // Forging another user as owner is rejected by WITH CHECK.
    const forgedOwner = await doctorA
      .from("agent_conversations")
      .insert({ clinic_id: clinicA, user_id: doctorBId, persona: "doctor" })
      .select("id");
    expect(forgedOwner.error).not.toBeNull();

    // Cross-clinic insert is rejected.
    const forgedClinic = await doctorA
      .from("agent_conversations")
      .insert({ clinic_id: clinicB, user_id: doctorAId, persona: "doctor" })
      .select("id");
    expect(forgedClinic.error).not.toBeNull();
  });
});

describe("P4A clinic_faq RLS", () => {
  it("lets any staff member read their own clinic's FAQ and nobody else's", async () => {
    const own = await receptionistA.from("clinic_faq").select("id, clinic_id");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id: faqA, clinic_id: clinicA }]);

    const cross = await doctorB.from("clinic_faq").select("id").eq("clinic_id", clinicA);
    expect(cross.data).toEqual([]);
  });

  it("denies authenticated writes in P4A (content UI is P5)", async () => {
    const insert = await adminA
      .from("clinic_faq")
      .insert({ clinic_id: clinicA, question: "X?", answer: "Y", language: "en" })
      .select("id");
    expect(insert.data ?? []).toEqual([]);
    expect(insert.error).not.toBeNull();
  });
});

describe("P4A log_agent_tool_call audit boundary (§6.6)", () => {
  it("rejects a clinic user forging an audit entry", async () => {
    const forged = await doctorA.rpc("log_agent_tool_call", {
      p_clinic_id: clinicA,
      p_tool: "get_patient_summary",
      p_actor_id: doctorAId,
      p_summary: { found: true },
    });
    expect(forged.error).not.toBeNull();
  });

  it("records a service-role tool call that the clinic admin can read", async () => {
    const logged = await service.rpc("log_agent_tool_call", {
      p_clinic_id: clinicA,
      p_tool: "get_patient_summary",
      p_actor_id: doctorAId,
      p_summary: { found: true, patient_id: "p1" },
    });
    expect(logged.error).toBeNull();

    const seen = await adminA
      .from("audit_logs")
      .select("action, clinic_id, actor_id")
      .eq("clinic_id", clinicA)
      .eq("action", "agent_tool:get_patient_summary")
      .eq("actor_id", doctorAId);
    expect(seen.error).toBeNull();
    expect(seen.data?.length).toBeGreaterThan(0);
    expect(seen.data?.[0]).toMatchObject({ actor_id: doctorAId, clinic_id: clinicA });

    // A doctor (non-admin/manager) does not see the clinic audit trail.
    const doctorView = await doctorA
      .from("audit_logs")
      .select("action")
      .eq("action", "agent_tool:get_patient_summary");
    expect(doctorView.data ?? []).toEqual([]);
  });
});
