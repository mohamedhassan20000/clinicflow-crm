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

const suffix = `phase2-clinical-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase2Clinical12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const departmentA = randomUUID();
const departmentOtherA = randomUUID();
const departmentB = randomUUID();
const patientA = randomUUID();
const patientOtherA = randomUUID();
const patientDeletedA = randomUUID();
const patientB = randomUUID();
const appointmentA = randomUUID();
const appointmentOtherA = randomUUID();
const prescriptionA = randomUUID();
const prescriptionOtherA = randomUUID();
const prescriptionB = randomUUID();
const labRequestA = randomUUID();
const labRequestOtherA = randomUUID();
const sickLeaveA = randomUUID();
const sickLeaveOtherA = randomUUID();
const medicalNoteA = randomUUID();
const medicalNoteOtherA = randomUUID();
const medicalNoteAttachmentA = randomUUID();
const medicalNoteAttachmentOtherA = randomUUID();
const patientDocumentA = randomUUID();
const patientPackageA = randomUUID();
const patientPackageOtherA = randomUUID();
const patientPackageDeletedA = randomUUID();
const patientDocumentPath = `documents/${clinicA}/${patientA}/other/${patientDocumentA}.pdf`;
const medicalNoteAttachmentPathA = `medical-notes/${clinicA}/${patientA}/${medicalNoteA}/${medicalNoteAttachmentA}.pdf`;
const medicalNoteAttachmentPathOtherA = `medical-notes/${clinicA}/${patientOtherA}/${medicalNoteOtherA}/${medicalNoteAttachmentOtherA}.pdf`;

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
let doctorA: Awaited<ReturnType<typeof createUser>>;
let doctorOtherA: Awaited<ReturnType<typeof createUser>>;
let assistantA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;
let doctorB: Awaited<ReturnType<typeof createUser>>;

function authed(
  account: Awaited<ReturnType<typeof createUser>>,
  role: UserRole,
  departmentId: string | null,
): AuthedUser {
  return {
    id: account.id,
    email: account.email,
    role,
    fullName: `${role} clinical user`,
    avatarUrl: null,
    clinicId: account.id === adminB.id ? clinicB : clinicA,
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
        "ai.read_clinical": true,
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
  await service.storage.from("patient-assets").remove([
    patientDocumentPath,
    medicalNoteAttachmentPathA,
    medicalNoteAttachmentPathOtherA,
  ]);
  await service
    .from("medical_note_attachments")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("patient_documents").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("patient_packages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("sick_leaves").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("lab_requests").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("prescriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("medical_notes")
    .delete()
    .in("patient_id", [patientA, patientOtherA, patientDeletedA, patientB]);
  await service.from("appointments").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("assistant_doctor_assignments")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("patients").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("departments").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  [adminA, managerA, receptionistA, doctorA, doctorOtherA, assistantA, adminB, doctorB] =
    await Promise.all([
      createUser("admin-a"),
      createUser("manager-a"),
      createUser("receptionist-a"),
      createUser("doctor-a"),
      createUser("doctor-other-a"),
      createUser("assistant-a"),
      createUser("admin-b"),
      createUser("doctor-b"),
    ]);
  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Phase 2 Clinic A ${suffix}` },
    { id: clinicB, name: `Phase 2 Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const departments = await service.from("departments").insert([
    { id: departmentA, clinic_id: clinicA, name: "Dermatology" },
    { id: departmentOtherA, clinic_id: clinicA, name: "Cardiology" },
    { id: departmentB, clinic_id: clinicB, name: "Dermatology" },
  ]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    { id: adminA.id, clinic_id: clinicA, full_name: "Owner A", role: "admin", is_active: true },
    { id: managerA.id, clinic_id: clinicA, full_name: "Manager A", role: "manager", is_active: true },
    { id: receptionistA.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist", is_active: true },
    { id: doctorA.id, clinic_id: clinicA, full_name: "Doctor A", role: "doctor", department_id: departmentA, is_active: true },
    { id: doctorOtherA.id, clinic_id: clinicA, full_name: "Doctor Other A", role: "doctor", department_id: departmentOtherA, is_active: true },
    { id: assistantA.id, clinic_id: clinicA, full_name: "Assistant A", role: "assistant", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Owner B", role: "admin", is_active: true },
    { id: doctorB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", department_id: departmentB, is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const assignment = await service.from("assistant_doctor_assignments").insert({
    clinic_id: clinicA,
    assistant_id: assistantA.id,
    doctor_id: doctorA.id,
    created_by: adminA.id,
  });
  if (assignment.error) throw assignment.error;

  const patients = await service.from("patients").insert([
    {
      id: patientA,
      clinic_id: clinicA,
      full_name: "Mohamed Seif",
      date_of_birth: "1990-01-01",
      blood_type: "O+",
      phone: "+905551110101",
      email: `${suffix}-patient-a@example.com`,
      national_id: `${Date.now()}-clinical-a`,
      file_number: `${suffix}-A`,
      assigned_doctor_id: doctorA.id,
      department_id: departmentA,
      created_by: adminA.id,
      is_deleted: false,
    },
    {
      id: patientOtherA,
      clinic_id: clinicA,
      full_name: "Other Scope Patient",
      date_of_birth: "1991-01-01",
      blood_type: "A-",
      phone: "+905551110102",
      email: `${suffix}-patient-other-a@example.com`,
      national_id: `${Date.now()}-clinical-other-a`,
      file_number: `${suffix}-OTHER-A`,
      assigned_doctor_id: doctorOtherA.id,
      department_id: departmentOtherA,
      created_by: adminA.id,
      is_deleted: false,
    },
    {
      id: patientB,
      clinic_id: clinicB,
      full_name: "Cross Tenant Patient",
      date_of_birth: "1992-01-01",
      blood_type: "B+",
      phone: "+905551110103",
      email: `${suffix}-patient-b@example.com`,
      national_id: `${Date.now()}-clinical-b`,
      file_number: `${suffix}-B`,
      assigned_doctor_id: doctorB.id,
      department_id: departmentB,
      created_by: adminB.id,
      is_deleted: false,
    },
    {
      id: patientDeletedA,
      clinic_id: clinicA,
      full_name: "Deleted Scope Patient",
      date_of_birth: "1993-01-01",
      blood_type: "AB+",
      phone: "+905551110104",
      email: `${suffix}-patient-deleted-a@example.com`,
      national_id: `${Date.now()}-clinical-deleted-a`,
      file_number: `${suffix}-DELETED-A`,
      assigned_doctor_id: doctorA.id,
      department_id: departmentA,
      created_by: adminA.id,
      is_deleted: true,
      deleted_at: "2026-08-13T10:00:00.000Z",
    },
  ]);
  if (patients.error) throw patients.error;

  const appointments = await service.from("appointments").insert([
    {
      id: appointmentA,
      clinic_id: clinicA,
      patient_id: patientA,
      doctor_id: doctorA.id,
      department_id: departmentA,
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

  const notes = await service.from("medical_notes").insert([
    { id: medicalNoteA, patient_id: patientA, doctor_id: doctorA.id, created_by: doctorA.id, appointment_id: appointmentA, note: "Authorized clinical note" },
    { id: medicalNoteOtherA, patient_id: patientOtherA, doctor_id: doctorOtherA.id, created_by: doctorOtherA.id, appointment_id: appointmentOtherA, note: "Other-scope clinical note" },
  ]);
  if (notes.error) throw notes.error;

  const noteAttachments = await service.from("medical_note_attachments").insert([
    {
      id: medicalNoteAttachmentA,
      clinic_id: clinicA,
      patient_id: patientA,
      note_id: medicalNoteA,
      file_name: "note-a.pdf",
      mime_type: "application/pdf",
      size_bytes: 1,
      storage_path: medicalNoteAttachmentPathA,
      uploaded_by: doctorA.id,
    },
    {
      id: medicalNoteAttachmentOtherA,
      clinic_id: clinicA,
      patient_id: patientOtherA,
      note_id: medicalNoteOtherA,
      file_name: "note-other-a.pdf",
      mime_type: "application/pdf",
      size_bytes: 1,
      storage_path: medicalNoteAttachmentPathOtherA,
      uploaded_by: doctorOtherA.id,
    },
  ]);
  if (noteAttachments.error) throw noteAttachments.error;

  const prescriptions = await service.from("prescriptions").insert([
    { id: prescriptionA, clinic_id: clinicA, patient_id: patientA, appointment_id: appointmentA, responsible_doctor_id: doctorA.id, created_by: doctorA.id, notes: "Authorized prescription note" },
    { id: prescriptionOtherA, clinic_id: clinicA, patient_id: patientOtherA, appointment_id: appointmentOtherA, responsible_doctor_id: doctorOtherA.id, created_by: doctorOtherA.id, notes: "Other-scope prescription" },
    { id: prescriptionB, clinic_id: clinicB, patient_id: patientB, responsible_doctor_id: doctorB.id, created_by: doctorB.id, notes: "Cross tenant prescription" },
  ]);
  if (prescriptions.error) throw prescriptions.error;

  const labRequests = await service.from("lab_requests").insert([
    { id: labRequestA, clinic_id: clinicA, patient_id: patientA, appointment_id: appointmentA, responsible_doctor_id: doctorA.id, created_by: doctorA.id, clinical_context: "Authorized lab context" },
    { id: labRequestOtherA, clinic_id: clinicA, patient_id: patientOtherA, appointment_id: appointmentOtherA, responsible_doctor_id: doctorOtherA.id, created_by: doctorOtherA.id, clinical_context: "Other-scope lab context" },
  ]);
  if (labRequests.error) throw labRequests.error;

  const sickLeaves = await service.from("sick_leaves").insert([
    { id: sickLeaveA, clinic_id: clinicA, patient_id: patientA, appointment_id: appointmentA, responsible_doctor_id: doctorA.id, created_by: doctorA.id, leave_start_date: "2026-08-14", leave_end_date: "2026-08-15" },
    { id: sickLeaveOtherA, clinic_id: clinicA, patient_id: patientOtherA, appointment_id: appointmentOtherA, responsible_doctor_id: doctorOtherA.id, created_by: doctorOtherA.id, leave_start_date: "2026-08-14", leave_end_date: "2026-08-16" },
  ]);
  if (sickLeaves.error) throw sickLeaves.error;

  const patientDocument = await service.from("patient_documents").insert({
    id: patientDocumentA,
    clinic_id: clinicA,
    patient_id: patientA,
    category: "other",
    label: "Authorized scan",
    file_name: "scan.pdf",
    mime_type: "application/pdf",
    size_bytes: 1234,
    storage_path: patientDocumentPath,
    uploaded_by: receptionistA.id,
  });
  if (patientDocument.error) throw patientDocument.error;

  const patientPackages = await service.from("patient_packages").insert([
    {
      id: patientPackageA,
      clinic_id: clinicA,
      patient_id: patientA,
      department_id: departmentA,
      name: "Authorized package",
      total_sessions: 5,
      used_sessions: 1,
      notes: "Authorized package note",
      created_by: adminA.id,
    },
    {
      id: patientPackageOtherA,
      clinic_id: clinicA,
      patient_id: patientOtherA,
      department_id: departmentOtherA,
      name: "Other-scope package",
      total_sessions: 4,
      used_sessions: 1,
      notes: "Other-scope package note",
      created_by: adminA.id,
    },
    {
      id: patientPackageDeletedA,
      clinic_id: clinicA,
      patient_id: patientDeletedA,
      department_id: departmentA,
      name: "Deleted-patient package",
      total_sessions: 3,
      used_sessions: 0,
      notes: "Must remain hidden",
      created_by: adminA.id,
    },
  ]);
  if (patientPackages.error) throw patientPackages.error;

  for (const [path, bytes] of [
    [patientDocumentPath, new Uint8Array([1])],
    [medicalNoteAttachmentPathA, new Uint8Array([2])],
    [medicalNoteAttachmentPathOtherA, new Uint8Array([3])],
  ] as const) {
    const upload = await service.storage.from("patient-assets").upload(path, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (upload.error) throw upload.error;
  }
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

const opts = {} as never;

async function assistantIds(
  account: typeof adminA,
  user: AuthedUser,
  resource: string,
) {
  const tools = await buildLiveTools(account.client, user);
  const result = (await tools.query_resource!.execute!(
    { resource, fields: ["id"], sort: "created_at", page_size: 50 },
    opts,
  )) as { rows: { id: string }[] };
  return result.rows.map((row) => row.id).sort();
}

async function directIds(account: typeof adminA, table: string) {
  const result = await (account.client as unknown as {
    from(name: string): { select(columns: string): PromiseLike<{ data: { id: string }[] | null; error: Error | null }> };
  }).from(table).select("id");
  if (result.error) throw result.error;
  return (result.data ?? []).map((row) => row.id).sort();
}

async function storagePaths(
  account: typeof adminA,
  prefix: string,
): Promise<string[]> {
  const result = await account.client.storage
    .from("patient-assets")
    .list(prefix, { limit: 100, sortBy: { column: "name", order: "asc" } });
  if (result.error) throw result.error;
  return (result.data ?? []).map((item) => `${prefix}/${item.name}`).sort();
}

function modelUsage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

describe("Phase 2 clinical resources against live RLS", () => {
  it("Case B end to end: an authorized owner asks for Mohamed Seif's blood type and receives it", async () => {
    const tools = await buildLiveTools(adminA.client, authed(adminA, "admin", null));
    let call = 0;
    const model = new MockLanguageModelV3({
      provider: "phase2-test",
      modelId: "phase2/case-b",
      doGenerate: async (options) => {
        call += 1;
        if (call === 1) {
          return {
            content: [{
              type: "tool-call" as const,
              toolCallId: "case-b-query",
              toolName: "query_resource",
              input: JSON.stringify({
                resource: "patients",
                filters: { full_name: "Mohamed Seif" },
                fields: ["full_name", "blood_type"],
              }),
            }],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: modelUsage(),
            warnings: [],
          };
        }
        expect(JSON.stringify(options.prompt)).toContain("Mohamed Seif");
        expect(JSON.stringify(options.prompt)).toContain("O+");
        return {
          content: [{ type: "text" as const, text: "Mohamed Seif's blood type is O+." }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: modelUsage(),
          warnings: [],
        };
      },
    });

    const result = await generateText({
      model,
      tools,
      prompt: "What is Mohamed Seif's blood type?",
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(result.text).toBe("Mohamed Seif's blood type is O+.");
    expect(call).toBe(2);
  });

  it.each([
    ["admin", () => adminA, null],
    ["manager", () => managerA, null],
    ["receptionist", () => receptionistA, null],
  ] as const)("%s reads blood type and pre-authorized prescriptions through live RLS", async (role, getAccount, departmentId) => {
    const account = getAccount();
    const tools = await buildLiveTools(account.client, authed(account, role, departmentId));
    const patient = (await tools.query_resource!.execute!(
      { resource: "patients", filters: { id: patientA }, fields: ["blood_type"] },
      opts,
    )) as { rows: { blood_type: string }[] };
    const prescriptions = (await tools.query_resource!.execute!(
      { resource: "prescriptions", filters: { patient_id: patientA }, fields: ["notes"] },
      opts,
    )) as { rows: { notes: string }[] };
    expect(patient.rows[0]?.blood_type).toBe("O+");
    expect(prescriptions.rows[0]?.notes).toBe("Authorized prescription note");
  });

  it.each([
    ["admin", () => adminA],
    ["receptionist", () => receptionistA],
  ] as const)("%s reads medical notes because the application policy already admits the role", async (role, getAccount) => {
    const account = getAccount();
    const tools = await buildLiveTools(account.client, authed(account, role, null));
    const notes = (await tools.query_resource!.execute!(
      { resource: "medical_notes", filters: { patient_id: patientA }, fields: ["note"] },
      opts,
    )) as { rows: { note: string }[] };
    expect(notes.rows[0]?.note).toBe("Authorized clinical note");
  });

  it("keeps doctor and assistant scope unchanged on resources whose existing RLS admits them", async () => {
    for (const [account, role] of [[doctorA, "doctor"], [assistantA, "assistant"]] as const) {
      const user = authed(account, role, role === "doctor" ? departmentA : null);
      expect(await assistantIds(account, user, "prescriptions")).toEqual([prescriptionA]);
      expect(await assistantIds(account, user, "lab_requests")).toEqual([labRequestA]);
      expect(await assistantIds(account, user, "sick_leaves")).toEqual([sickLeaveA]);
      expect(await assistantIds(account, user, "patient_packages")).toEqual([patientPackageA]);
    }

    expect(
      await assistantIds(doctorA, authed(doctorA, "doctor", departmentA), "medical_notes"),
    ).toEqual([medicalNoteA]);

    expect(
      await assistantIds(
        doctorOtherA,
        authed(doctorOtherA, "doctor", departmentOtherA),
        "prescriptions",
      ),
    ).toEqual([prescriptionOtherA]);
  });

  it("matches direct authenticated RLS output as a compiler-fidelity check", async () => {
    const resources = [
      "medical_notes",
      "prescriptions",
      "lab_requests",
      "sick_leaves",
      "patient_packages",
    ] as const;
    const actors = [
      [adminA, authed(adminA, "admin", null)],
      [managerA, authed(managerA, "manager", null)],
      [receptionistA, authed(receptionistA, "receptionist", null)],
      [doctorA, authed(doctorA, "doctor", departmentA)],
      [assistantA, authed(assistantA, "assistant", null)],
    ] as const;

    for (const [account, user] of actors) {
      for (const resource of resources) {
        if (
          resource === "medical_notes" &&
          !(["admin", "receptionist", "doctor"] as UserRole[]).includes(user.role)
        ) {
          continue;
        }
        expect(
          await assistantIds(account, user, resource),
          `${user.role} ${resource}`,
        ).toEqual(await directIds(account, resource));
      }
    }
  });

  it("pins the pre-existing role × resource authorization matrix to literal ids", async () => {
    const actors = [
      [adminA, "admin", null],
      [managerA, "manager", null],
      [receptionistA, "receptionist", null],
      [doctorA, "doctor", departmentA],
      [assistantA, "assistant", null],
    ] as const;
    const expected: Record<UserRole, Record<string, string[]>> = {
      admin: {
        medical_notes: [medicalNoteA, medicalNoteOtherA],
        prescriptions: [prescriptionA, prescriptionOtherA],
        lab_requests: [labRequestA, labRequestOtherA],
        sick_leaves: [sickLeaveA, sickLeaveOtherA],
        patient_documents: [patientDocumentA],
        patient_packages: [patientPackageA, patientPackageOtherA],
      },
      manager: {
        medical_notes: [],
        prescriptions: [prescriptionA, prescriptionOtherA],
        lab_requests: [labRequestA, labRequestOtherA],
        sick_leaves: [sickLeaveA, sickLeaveOtherA],
        patient_documents: [],
        patient_packages: [patientPackageA, patientPackageOtherA],
      },
      receptionist: {
        medical_notes: [medicalNoteA, medicalNoteOtherA],
        prescriptions: [prescriptionA, prescriptionOtherA],
        lab_requests: [labRequestA, labRequestOtherA],
        sick_leaves: [sickLeaveA, sickLeaveOtherA],
        patient_documents: [patientDocumentA],
        patient_packages: [patientPackageA, patientPackageOtherA],
      },
      doctor: {
        medical_notes: [medicalNoteA],
        prescriptions: [prescriptionA],
        lab_requests: [labRequestA],
        sick_leaves: [sickLeaveA],
        patient_documents: [],
        patient_packages: [patientPackageA],
      },
      assistant: {
        medical_notes: [],
        prescriptions: [prescriptionA],
        lab_requests: [labRequestA],
        sick_leaves: [sickLeaveA],
        patient_documents: [],
        patient_packages: [patientPackageA],
      },
    };

    for (const [account, role] of actors) {
      for (const [resource, ids] of Object.entries(expected[role])) {
        expect(await directIds(account, resource), `${role} ${resource}`).toEqual(
          [...ids].sort(),
        );
      }
    }
  });

  it("keeps patient-document metadata and bytes on the admin/receptionist application matrix", async () => {
    const prefix = `documents/${clinicA}/${patientA}/other`;
    for (const [account, expectedIds, expectedPaths] of [
      [adminA, [patientDocumentA], [patientDocumentPath]],
      [managerA, [], []],
      [receptionistA, [patientDocumentA], [patientDocumentPath]],
      [doctorA, [], []],
      [assistantA, [], []],
    ] as const) {
      expect(await directIds(account, "patient_documents")).toEqual(expectedIds);
      expect(await storagePaths(account, prefix)).toEqual(expectedPaths);
    }
  });

  it("keeps medical-note narrative, attachment metadata, and bytes on one matrix", async () => {
    const prefixA = `medical-notes/${clinicA}/${patientA}/${medicalNoteA}`;
    const prefixOtherA = `medical-notes/${clinicA}/${patientOtherA}/${medicalNoteOtherA}`;
    const expectedByRole = [
      [adminA, [medicalNoteA, medicalNoteOtherA], [medicalNoteAttachmentA, medicalNoteAttachmentOtherA], [medicalNoteAttachmentPathA, medicalNoteAttachmentPathOtherA]],
      [managerA, [], [], []],
      [receptionistA, [medicalNoteA, medicalNoteOtherA], [medicalNoteAttachmentA, medicalNoteAttachmentOtherA], [medicalNoteAttachmentPathA, medicalNoteAttachmentPathOtherA]],
      [doctorA, [medicalNoteA], [medicalNoteAttachmentA], [medicalNoteAttachmentPathA]],
      [assistantA, [], [], []],
    ] as const;
    for (const [account, noteIds, attachmentIds, paths] of expectedByRole) {
      expect(await directIds(account, "medical_notes")).toEqual([...noteIds].sort());
      expect(await directIds(account, "medical_note_attachments")).toEqual(
        [...attachmentIds].sort(),
      );
      const visiblePaths = [
        ...(await storagePaths(account, prefixA)),
        ...(await storagePaths(account, prefixOtherA)),
      ].sort();
      expect(visiblePaths).toEqual([...paths].sort());
    }
  });

  it("covers non-AI patient-package consumers for in-scope, out-of-scope, and deleted patients", async () => {
    expect(await directIds(doctorA, "patient_packages")).toEqual([patientPackageA]);
    expect(await directIds(doctorOtherA, "patient_packages")).toEqual([
      patientPackageOtherA,
    ]);
    expect(await directIds(assistantA, "patient_packages")).toEqual([
      patientPackageA,
    ]);
    for (const account of [adminA, managerA, receptionistA]) {
      expect(await directIds(account, "patient_packages")).toEqual(
        [patientPackageA, patientPackageOtherA].sort(),
      );
    }
    for (const account of [adminA, managerA, receptionistA, doctorA, assistantA]) {
      expect(await directIds(account, "patient_packages")).not.toContain(
        patientPackageDeletedA,
      );
    }
  });

  it("keeps cross-tenant records outside both direct RLS and Assistant output", async () => {
    const user = authed(adminA, "admin", null);
    expect(await directIds(adminA, "prescriptions")).not.toContain(prescriptionB);
    expect(await assistantIds(adminA, user, "prescriptions")).not.toContain(
      prescriptionB,
    );
  });
});
