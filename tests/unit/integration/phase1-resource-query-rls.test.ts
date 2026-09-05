import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";
import type { AuthedUser, UserRole } from "@/lib/rbac";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `phase1-resource-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase1Resource12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const departmentDermA = randomUUID();
const departmentOtherA = randomUUID();
const departmentDermB = randomUUID();
const insuranceA = randomUUID();
const serviceA = randomUUID();
const patientDermA = randomUUID();
const patientOtherA = randomUUID();
const patientDermB = randomUUID();
const literalStarPatient = randomUUID();
const expandedStarPatient = randomUUID();
const tiedPatientIds = Array.from({ length: 5 }, () => randomUUID());
const appointmentDermA = randomUUID();
const appointmentOtherA = randomUUID();
const followUpDermA = randomUUID();
const documentDermA = randomUUID();
const documentOtherA = randomUUID();
const documentCatalogDeniedA = randomUUID();
const missingPatient = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

function client(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
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
  const signedIn = client();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, email, client: signedIn };
}

let adminA: Awaited<ReturnType<typeof createUser>>;
let managerA: Awaited<ReturnType<typeof createUser>>;
let receptionistA: Awaited<ReturnType<typeof createUser>>;
let doctorDermA: Awaited<ReturnType<typeof createUser>>;
let doctorOtherA: Awaited<ReturnType<typeof createUser>>;
let assistantA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;

function authed(
  account: Awaited<ReturnType<typeof createUser>>,
  role: UserRole,
  departmentId: string | null,
): AuthedUser {
  return {
    id: account.id,
    email: account.email,
    role,
    fullName: `${role} integration user`,
    avatarUrl: null,
    clinicId: role === "admin" && account.id === adminB.id ? clinicB : clinicA,
    departmentId,
    mustChangePassword: false,
  };
}

async function buildLiveTools(dbClient: Client, user: AuthedUser) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => dbClient),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: randomUUID(), error: null })),
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: user.clinicId,
      planSlug: "pro_ai",
      features: {
        ai_assistant: true,
        "ai.read_operational": true,
        "ai.bulk_export": true,
      },
      limits: {},
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    })),
    hasFeature: (
      entitlements: { features: Record<string, boolean> },
      key: string,
    ) => entitlements.features[key] === true,
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ai/permissions")>()),
    hasAiUserPermission: vi.fn(async () => false),
  }));
  const { buildStaffTools } = await import("@/lib/ai/tools");
  return buildStaffTools({ user, locale: "en" });
}

async function cleanup() {
  await service.from("documents").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("follow_ups").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("appointments").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("assistant_doctor_assignments")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("patients").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("services").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("insurance_providers")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("departments").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  [adminA, managerA, receptionistA, doctorDermA, doctorOtherA, assistantA, adminB] = await Promise.all([
    createUser("admin-a"),
    createUser("manager-a"),
    createUser("receptionist-a"),
    createUser("doctor-derm-a"),
    createUser("doctor-other-a"),
    createUser("assistant-a"),
    createUser("admin-b"),
  ]);
  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Phase 1 Clinic A ${suffix}` },
    { id: clinicB, name: `Phase 1 Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const departments = await service.from("departments").insert([
    { id: departmentDermA, clinic_id: clinicA, name: "Dermatology" },
    { id: departmentOtherA, clinic_id: clinicA, name: "Cardiology" },
    { id: departmentDermB, clinic_id: clinicB, name: "Dermatology" },
  ]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    { id: adminA.id, clinic_id: clinicA, full_name: "Owner A", role: "admin", is_active: true },
    { id: managerA.id, clinic_id: clinicA, full_name: "Manager A", role: "manager", is_active: true },
    { id: receptionistA.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist", is_active: true },
    { id: doctorDermA.id, clinic_id: clinicA, full_name: "Doctor Derm A", role: "doctor", department_id: departmentDermA, is_active: true },
    { id: doctorOtherA.id, clinic_id: clinicA, full_name: "Doctor Other A", role: "doctor", department_id: departmentOtherA, is_active: true },
    { id: assistantA.id, clinic_id: clinicA, full_name: "Assistant A", role: "assistant", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Owner B", role: "admin", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const assignment = await service.from("assistant_doctor_assignments").insert({
    clinic_id: clinicA,
    assistant_id: assistantA.id,
    doctor_id: doctorDermA.id,
    created_by: adminA.id,
  });
  if (assignment.error) throw assignment.error;

  const insurance = await service.from("insurance_providers").insert({
    id: insuranceA,
    clinic_id: clinicA,
    name: "Phase 1 Insurance",
    code: "P1",
  });
  if (insurance.error) throw insurance.error;

  const services = await service.from("services").insert({
    id: serviceA,
    clinic_id: clinicA,
    department_id: departmentDermA,
    name: "Phase 1 Consultation",
    price: 125,
  });
  if (services.error) throw services.error;

  const patients = await service.from("patients").insert([
    {
      id: patientDermA,
      clinic_id: clinicA,
      full_name: "Aylin Dermatology",
      date_of_birth: "1990-01-01",
      phone: "+905551110001",
      email: `${suffix}-derm-a@example.com`,
      national_id: `${Date.now()}-derm-a`,
      file_number: `${suffix}-D-A`,
      assigned_doctor_id: doctorDermA.id,
      department_id: departmentDermA,
      insurance_provider_id: insuranceA,
      created_by: adminA.id,
    },
    {
      id: patientOtherA,
      clinic_id: clinicA,
      full_name: "Bora Cardiology",
      date_of_birth: "1991-01-01",
      phone: "+905551110002",
      email: `${suffix}-other-a@example.com`,
      national_id: `${Date.now()}-other-a`,
      file_number: `${suffix}-C-A`,
      assigned_doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      created_by: adminA.id,
    },
    {
      id: patientDermB,
      clinic_id: clinicB,
      full_name: "Cross Tenant Dermatology",
      date_of_birth: "1992-01-01",
      phone: "+905551110003",
      email: `${suffix}-derm-b@example.com`,
      national_id: `${Date.now()}-derm-b`,
      file_number: `${suffix}-D-B`,
      department_id: departmentDermB,
      created_by: adminB.id,
    },
    {
      id: literalStarPatient,
      clinic_id: clinicA,
      full_name: "Literal*Star",
      date_of_birth: "1993-01-01",
      phone: "+905551110004",
      email: `${suffix}-literal-star@example.com`,
      national_id: `${Date.now()}-literal-star`,
      file_number: `${suffix}-STAR-1`,
      assigned_doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      created_by: adminA.id,
    },
    {
      id: expandedStarPatient,
      clinic_id: clinicA,
      full_name: "Literal expanded Star",
      date_of_birth: "1994-01-01",
      phone: "+905551110005",
      email: `${suffix}-expanded-star@example.com`,
      national_id: `${Date.now()}-expanded-star`,
      file_number: `${suffix}-STAR-2`,
      assigned_doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      created_by: adminA.id,
    },
    ...tiedPatientIds.map((id, index) => ({
      id,
      clinic_id: clinicA,
      full_name: "Pagination Tie",
      date_of_birth: "1995-01-01",
      phone: `+90555112${String(index).padStart(4, "0")}`,
      email: `${suffix}-pagination-${index}@example.com`,
      national_id: `${Date.now()}-pagination-${index}`,
      file_number: `${suffix}-PAGE-${index}`,
      assigned_doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      created_by: adminA.id,
    })),
  ]);
  if (patients.error) throw patients.error;

  const appointments = await service.from("appointments").insert([
    {
      id: appointmentDermA,
      clinic_id: clinicA,
      patient_id: patientDermA,
      doctor_id: doctorDermA.id,
      department_id: departmentDermA,
      service_id: serviceA,
      scheduled_at: "2026-08-13T08:00:00.000Z",
      status: "confirmed",
      created_by: adminA.id,
    },
    {
      id: appointmentOtherA,
      clinic_id: clinicA,
      patient_id: patientOtherA,
      doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      scheduled_at: "2026-08-13T09:00:00.000Z",
      status: "confirmed",
      created_by: adminA.id,
    },
  ]);
  if (appointments.error) throw appointments.error;

  const followUps = await service.from("follow_ups").insert({
    id: followUpDermA,
    clinic_id: clinicA,
    patient_id: patientDermA,
    appointment_id: appointmentDermA,
    outcome: "all_fine",
    recorded_by: receptionistA.id,
  });
  if (followUps.error) throw followUps.error;

  const issuedAt = "2026-08-13T10:00:00.000Z";
  const documentRows = [
    {
      id: documentDermA,
      doc_type: "PATIENT_FILE",
      patient_id: patientDermA,
      doctor_id: doctorDermA.id,
      sequence_value: 1,
    },
    {
      id: documentOtherA,
      doc_type: "PATIENT_FILE",
      patient_id: patientOtherA,
      doctor_id: doctorOtherA.id,
      sequence_value: 2,
    },
    {
      id: documentCatalogDeniedA,
      doc_type: "REVENUE_REPORT",
      patient_id: patientDermA,
      doctor_id: doctorDermA.id,
      sequence_value: 3,
    },
  ].map((row) => ({
    ...row,
    clinic_id: clinicA,
    idempotency_key: `${suffix}:document:${row.sequence_value}`,
    document_number: `P1-${row.sequence_value}`,
    numbering_prefix_snapshot: "P1",
    counter_period_key: "2026",
    locale: "en",
    params: {},
    snapshot: {},
    status: "issued",
    issued_by: adminA.id,
    issued_at: issuedAt,
    pdf_storage_path: `documents/${clinicA}/${row.doc_type}/${row.id}.pdf`,
    page_count: 1,
  }));
  const documents = await service.from("documents").insert(documentRows);
  if (documents.error) throw documents.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

const opts = {} as never;

function modelUsage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

async function dermatologyNames(account: typeof adminA, user: AuthedUser) {
  const tools = await buildLiveTools(account.client, user);
  return (await tools.query_resource!.execute!(
    {
      resource: "patients",
      filters: { department: "Dermatology" },
      fields: ["full_name", "file_number"],
      sort: "full_name",
    },
    opts,
  )) as {
    rows: { full_name: string; file_number: string }[];
    total: number;
    truncated: boolean;
  };
}

describe("Phase 1 generic resources against live RLS", () => {
  it("Case A end to end: an owner question reaches query_resource and the authorized name reaches the answer step", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    let call = 0;
    const model = new MockLanguageModelV3({
      provider: "phase1-test",
      modelId: "phase1/case-a",
      doGenerate: async (options) => {
        call += 1;
        if (call === 1) {
          return {
            content: [{
              type: "tool-call" as const,
              toolCallId: "case-a-query",
              toolName: "query_resource",
              input: JSON.stringify({
                resource: "patients",
                filters: { department: "Dermatology" },
                fields: ["full_name", "file_number"],
                sort: "full_name",
              }),
            }],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: modelUsage(),
            warnings: [],
          };
        }
        expect(JSON.stringify(options.prompt)).toContain("Aylin Dermatology");
        return {
          content: [{ type: "text" as const, text: "Aylin Dermatology" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: modelUsage(),
          warnings: [],
        };
      },
    });

    const result = await generateText({
      model,
      tools,
      prompt: "Give me the names of Dermatology patients.",
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(result.text).toBe("Aylin Dermatology");
    expect(call).toBe(2);
  });

  it("Case A: clinic owner receives authorized Dermatology patient names and exact total", async () => {
    const result = await dermatologyNames(adminA, authed(adminA, "admin", null));
    expect(result.rows).toEqual([
      { full_name: "Aylin Dermatology", file_number: `${suffix}-D-A` },
    ]);
    expect(result).toMatchObject({ total: 1, truncated: false });
  });

  it("Case A: receptionist receives the same in-clinic Dermatology result", async () => {
    const result = await dermatologyNames(
      receptionistA,
      authed(receptionistA, "receptionist", null),
    );
    expect(result.rows.map((row) => row.full_name)).toEqual(["Aylin Dermatology"]);
    expect(result.total).toBe(1);
  });

  it("Case A: doctor receives only their department-scoped Dermatology patient", async () => {
    const result = await dermatologyNames(
      doctorDermA,
      authed(doctorDermA, "doctor", departmentDermA),
    );
    expect(result.rows.map((row) => row.full_name)).toEqual(["Aylin Dermatology"]);
    expect(result.total).toBe(1);

    const tools = await buildLiveTools(
      doctorDermA.client,
      authed(doctorDermA, "doctor", departmentDermA),
    );
    const all = (await tools.query_resource!.execute!(
      { resource: "patients", fields: ["full_name"], sort: "full_name" },
      opts,
    )) as { rows: { full_name: string }[] };
    expect(all.rows.map((row) => row.full_name)).toEqual(["Aylin Dermatology"]);
  });

  it("manager receives the clinic-wide patient scope without cross-tenant rows", async () => {
    const tools = await buildLiveTools(
      managerA.client,
      authed(managerA, "manager", null),
    );
    const result = (await tools.query_resource!.execute!(
      { resource: "patients", fields: ["id"], page_size: 20 },
      opts,
    )) as { rows: { id: string }[]; total: number };
    const ids = result.rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([patientDermA, patientOtherA]));
    expect(ids).not.toContain(patientDermB);
    expect(result.total).toBe(9);
  });

  it("assistant reads only the supervised-doctor union for patients and appointments", async () => {
    const tools = await buildLiveTools(
      assistantA.client,
      authed(assistantA, "assistant", null),
    );
    const patients = (await tools.query_resource!.execute!(
      { resource: "patients", fields: ["id"], page_size: 20 },
      opts,
    )) as { rows: { id: string }[]; total: number };
    expect(patients.rows.map((row) => row.id)).toEqual([patientDermA]);
    expect(patients.total).toBe(1);

    const appointments = (await tools.query_resource!.execute!(
      { resource: "appointments", fields: ["id"], page_size: 20 },
      opts,
    )) as { rows: { id: string }[]; total: number };
    expect(appointments.rows.map((row) => row.id)).toEqual([appointmentDermA]);
    expect(appointments.total).toBe(1);
  });

  it("queries all eight resources with their declared live relation embeds", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    const query = async (input: Record<string, unknown>) =>
      (await tools.query_resource!.execute!(input as never, opts)) as {
        rows: Record<string, unknown>[];
        total: number;
      };

    const patients = await query({
      resource: "patients",
      filters: { id: patientDermA },
      fields: ["id"],
      relations: {
        department: ["id", "name"],
        assigned_doctor: ["id", "full_name"],
        insurance_provider: ["id", "name"],
      },
    });
    expect(patients.rows[0]).toMatchObject({
      id: patientDermA,
      department: { id: departmentDermA, name: "Dermatology" },
      assigned_doctor: { id: doctorDermA.id, full_name: "Doctor Derm A" },
      insurance_provider: { id: insuranceA, name: "Phase 1 Insurance" },
    });

    const appointments = await query({
      resource: "appointments",
      filters: { id: appointmentDermA },
      fields: ["id"],
      relations: {
        patient: ["id", "full_name", "file_number"],
        doctor: ["id", "full_name"],
        department: ["id", "name"],
        service: ["id", "name"],
      },
    });
    expect(appointments.rows[0]).toMatchObject({
      id: appointmentDermA,
      patient: { id: patientDermA },
      doctor: { id: doctorDermA.id },
      department: { id: departmentDermA },
      service: { id: serviceA },
    });

    const departments = await query({
      resource: "departments",
      filters: { id: departmentDermA },
      fields: ["id", "name"],
    });
    expect(departments.rows[0]).toMatchObject({ id: departmentDermA, name: "Dermatology" });

    const services = await query({
      resource: "services",
      filters: { id: serviceA },
      fields: ["id", "name"],
      relations: { department: ["id", "name"] },
    });
    expect(services.rows[0]).toMatchObject({
      id: serviceA,
      department: { id: departmentDermA, name: "Dermatology" },
    });

    const profiles = await query({
      resource: "profiles",
      filters: { id: doctorDermA.id },
      fields: ["id", "full_name"],
      relations: { department: ["id", "name"] },
    });
    expect(profiles.rows[0]).toMatchObject({
      id: doctorDermA.id,
      department: { id: departmentDermA, name: "Dermatology" },
    });

    const followUps = await query({
      resource: "follow_ups",
      filters: { id: followUpDermA },
      fields: ["id"],
      relations: {
        patient: ["id", "full_name", "file_number"],
        recorded_by_profile: ["id", "full_name"],
      },
    });
    expect(followUps.rows[0]).toMatchObject({
      id: followUpDermA,
      patient: { id: patientDermA },
      recorded_by_profile: { id: receptionistA.id },
    });

    const documents = await query({
      resource: "documents",
      filters: { id: documentDermA },
      fields: ["id", "doc_type"],
      relations: {
        patient: ["id", "full_name", "file_number"],
        doctor: ["id", "full_name"],
        issuer: ["id", "full_name"],
      },
    });
    expect(documents.rows[0]).toMatchObject({
      id: documentDermA,
      doc_type: "PATIENT_FILE",
      patient: { id: patientDermA },
      doctor: { id: doctorDermA.id },
      issuer: { id: adminA.id },
    });

    const insurance = await query({
      resource: "insurance_providers",
      filters: { id: insuranceA },
      fields: ["id", "name"],
    });
    expect(insurance.rows[0]).toMatchObject({
      id: insuranceA,
      name: "Phase 1 Insurance",
    });
  });

  it("paginates tied sort values without duplicates or omissions", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    const pageIds: string[] = [];
    for (const page of [1, 2, 3]) {
      const result = (await tools.query_resource!.execute!(
        {
          resource: "patients",
          filters: { full_name: "Pagination Tie" },
          fields: ["id"],
          sort: "full_name",
          direction: "desc",
          page,
          page_size: 2,
        },
        opts,
      )) as { rows: { id: string }[]; total: number };
      expect(result.total).toBe(5);
      pageIds.push(...result.rows.map((row) => row.id));
    }
    expect(pageIds).toHaveLength(5);
    expect(new Set(pageIds).size).toBe(5);
    expect(pageIds.sort()).toEqual([...tiedPatientIds].sort());
  });

  it("rejects a star before live PostgREST can expand it as a wildcard", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    const result = (await tools.query_resource!.execute!(
      {
        resource: "patients",
        filters: { full_name: { operator: "ilike", value: "Literal*Star" } },
        fields: ["id", "full_name"],
      },
      opts,
    )) as {
      invalid_request: boolean;
      reason: string;
      forbidden_character: string;
    };
    expect(result).toMatchObject({
      invalid_request: true,
      reason: "invalid_filter_value",
      forbidden_character: "*",
    });

    const expanded = await adminA.client
      .from("patients")
      .select("id")
      .eq("id", expandedStarPatient)
      .single();
    if (expanded.error) throw expanded.error;
    expect(expanded.data.id).toBe(expandedStarPatient);
  });

  it("combines doctor document catalog authorization with independent RLS scope", async () => {
    const rlsVisibleButCatalogDenied = await doctorDermA.client
      .from("documents")
      .select("id, doc_type")
      .eq("id", documentCatalogDeniedA)
      .single();
    if (rlsVisibleButCatalogDenied.error) throw rlsVisibleButCatalogDenied.error;
    expect(rlsVisibleButCatalogDenied.data.doc_type).toBe("REVENUE_REPORT");

    const rlsDenied = await doctorDermA.client
      .from("documents")
      .select("id")
      .eq("id", documentOtherA);
    if (rlsDenied.error) throw rlsDenied.error;
    expect(rlsDenied.data).toEqual([]);

    const tools = await buildLiveTools(
      doctorDermA.client,
      authed(doctorDermA, "doctor", departmentDermA),
    );
    const result = (await tools.query_resource!.execute!(
      { resource: "documents", fields: ["id", "doc_type"] },
      opts,
    )) as { rows: { id: string; doc_type: string }[]; total: number };
    expect(result.rows).toEqual([{ id: documentDermA, doc_type: "PATIENT_FILE" }]);
    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.id)).not.toContain(documentOtherA);
    expect(result.rows.map((row) => row.id)).not.toContain(documentCatalogDeniedA);
  });

  it("returns byte-identical unauthorized_scope for cross-tenant and missing UUIDs", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    const crossTenant = await tools.get_record!.execute!(
      { resource: "patients", id: patientDermB, fields: ["id", "full_name"] },
      opts,
    );
    const missing = await tools.get_record!.execute!(
      { resource: "patients", id: missingPatient, fields: ["id", "full_name"] },
      opts,
    );
    expect(crossTenant).toEqual(missing);
    expect(crossTenant).toMatchObject({
      permission_denied: true,
      reason: "unauthorized_scope",
    });
  });
});
