import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import {
  listAssistantConversations,
  loadAssistantConversationById,
} from "@/lib/ai/conversations";
import type { AuthedUser } from "@/lib/rbac";

/**
 * Post-plan product completion, at the database boundary.
 *
 * Two of the three changes widen what a user can *reach*, so their safety is a
 * database property and a mocked client cannot prove it:
 *
 *  - Change 1: grouped counts must be exact for authorized rows, and must stay
 *    narrowed by the same RLS that narrows the rows — a doctor's distribution
 *    covers their patients and nobody else's, and no bucket may cross a tenant.
 *  - Change 2: conversation history must list and open exactly the caller's own
 *    conversations, with `agent_messages` RLS still refusing another user's
 *    transcript even when the id is known.
 *
 * Run with `pnpm test:integration` against the local stack.
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `postplan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "PostPlan12345";
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

const departmentA = randomUUID();
const departmentB = randomUUID();
const patientsA = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const patientB = randomUUID();
const convAdminOne = randomUUID();
const convAdminTwo = randomUUID();
const convDoctorPatient = randomUUID();
const convOtherClinic = randomUUID();

let adminA: Client;
let adminAId = "";
let doctorA: Client;
let doctorAId = "";
let adminB: Client;
let adminBId = "";
let doctorBId = "";

function authed(id: string, clinicId: string, role: AuthedUser["role"], departmentId: string | null = null): AuthedUser {
  return {
    id,
    clinicId,
    role,
    email: `${id}@example.com`,
    fullName: "Post Plan User",
    avatarUrl: null,
    departmentId,
    mustChangePassword: false,
  };
}

function patientRow(input: {
  id: string;
  clinicId: string;
  createdBy: string;
  doctorId: string | null;
  departmentId: string | null;
  bloodType: Database["public"]["Enums"]["blood_type"] | null;
  index: number;
}) {
  return {
    id: input.id,
    clinic_id: input.clinicId,
    full_name: `Post Plan Patient ${input.index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655200${String(input.index).padStart(4, "0")}`,
    email: `${suffix}-p${input.index}@example.com`,
    national_id: `${Date.now()}${input.index}${input.clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${input.index}`,
    assigned_doctor_id: input.doctorId,
    department_id: input.departmentId,
    blood_type: input.bloodType,
    created_by: input.createdBy,
  };
}

async function cleanup() {
  await service.from("agent_messages").delete().in("clinic_id", ALL_CLINICS);
  await service.from("agent_conversations").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("departments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [admin, doctor, otherAdmin, otherDoctor] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a"),
    createUser("admin-b"),
    createUser("doctor-b"),
  ]);
  adminA = admin.client;
  adminAId = admin.id;
  doctorA = doctor.client;
  doctorAId = doctor.id;
  adminB = otherAdmin.client;
  adminBId = otherAdmin.id;
  doctorBId = otherDoctor.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Post Plan Clinic A ${suffix}` },
    { id: clinicB, name: `Post Plan Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: adminAId, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: doctorAId, clinic_id: clinicA, full_name: "Doctor A", role: "doctor", is_active: true },
    { id: adminBId, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: doctorBId, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const departments = await service.from("departments").insert([
    { id: departmentA, clinic_id: clinicA, name: `Dermatology ${suffix}`, is_active: true },
    { id: departmentB, clinic_id: clinicB, name: `Cardiology ${suffix}`, is_active: true },
  ]);
  if (departments.error) throw departments.error;

  // Clinic A: three O+ patients assigned to Doctor A, one A- patient assigned to
  // nobody. Clinic B: one O+ patient, which must never appear in a clinic A
  // distribution.
  const patients = await service.from("patients").insert([
    patientRow({
      id: patientsA[0]!,
      clinicId: clinicA,
      createdBy: adminAId,
      doctorId: doctorAId,
      departmentId: departmentA,
      bloodType: "O+",
      index: 1,
    }),
    patientRow({
      id: patientsA[1]!,
      clinicId: clinicA,
      createdBy: adminAId,
      doctorId: doctorAId,
      departmentId: departmentA,
      bloodType: "O+",
      index: 2,
    }),
    patientRow({
      id: patientsA[2]!,
      clinicId: clinicA,
      createdBy: adminAId,
      doctorId: doctorAId,
      departmentId: departmentA,
      bloodType: "A-",
      index: 3,
    }),
    patientRow({
      id: patientsA[3]!,
      clinicId: clinicA,
      createdBy: adminAId,
      doctorId: null,
      departmentId: null,
      bloodType: "O+",
      index: 4,
    }),
    patientRow({
      id: patientB,
      clinicId: clinicB,
      createdBy: adminBId,
      doctorId: doctorBId,
      departmentId: departmentB,
      bloodType: "O+",
      index: 5,
    }),
  ]);
  if (patients.error) throw patients.error;

  const conversations = await service.from("agent_conversations").insert([
    {
      id: convAdminOne,
      clinic_id: clinicA,
      user_id: adminAId,
      persona: "doctor",
      locale: "en",
      title: "Which patients have O+ blood?",
    },
    {
      id: convAdminTwo,
      clinic_id: clinicA,
      user_id: adminAId,
      persona: "doctor",
      locale: "en",
      title: "Second admin conversation",
    },
    {
      id: convDoctorPatient,
      clinic_id: clinicA,
      user_id: doctorAId,
      persona: "doctor",
      locale: "en",
      title: "About my patient",
      patient_id: patientsA[0]!,
    },
    {
      id: convOtherClinic,
      clinic_id: clinicB,
      user_id: adminBId,
      persona: "doctor",
      locale: "en",
      title: "Other clinic conversation",
    },
  ]);
  if (conversations.error) throw conversations.error;

  const messages = await service.from("agent_messages").insert([
    { conversation_id: convAdminOne, clinic_id: clinicA, role: "user", content: "who is O+?" },
    { conversation_id: convAdminOne, clinic_id: clinicA, role: "assistant", content: "Three patients." },
    { conversation_id: convOtherClinic, clinic_id: clinicB, role: "user", content: "other clinic secret" },
  ]);
  if (messages.error) throw messages.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("change 1 — grouped counts stay narrowed by RLS", () => {
  async function countBloodType(client: Client, value: "O+" | "A-") {
    const { count, error } = await client
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .eq("blood_type", value);
    expect(error).toBeNull();
    return count ?? 0;
  }

  it("gives an admin an exact clinic-wide distribution, small buckets included", async () => {
    // The bucket of one is the case the statistical path suppressed and this
    // path must report, because the same admin can list the row itself.
    expect(await countBloodType(adminA, "O+")).toBe(3);
    expect(await countBloodType(adminA, "A-")).toBe(1);
  });

  it("never counts another tenant's rows into a bucket", async () => {
    const { count, error } = await adminA
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicB)
      .eq("blood_type", "O+");
    expect(error).toBeNull();
    // RLS refuses the other tenant regardless of the requested clinic id.
    expect(count ?? 0).toBe(0);
  });

  it("narrows a doctor's distribution to their own scope, not the clinic's", async () => {
    // Doctor A is assigned three of clinic A's four patients; the unassigned
    // O+ patient is outside their RLS scope and must not enter their buckets.
    expect(await countBloodType(doctorA, "O+")).toBe(2);
    expect(await countBloodType(doctorA, "A-")).toBe(1);
  });

  it("keeps every bucket's rows individually listable by the same caller", async () => {
    const { data, error } = await adminA
      .from("patients")
      .select("id, full_name, blood_type")
      .eq("clinic_id", clinicA)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .eq("blood_type", "A-");
    expect(error).toBeNull();
    // This is the property the whole change rests on: a bucket is never more
    // than the caller could already read row by row.
    expect(data).toHaveLength(1);
    expect(data![0]!.blood_type).toBe("A-");
  });

  it("enumerates department buckets only from departments the caller may read", async () => {
    const { data, error } = await adminA
      .from("departments")
      .select("id, name")
      .is("deleted_at", null);
    expect(error).toBeNull();
    expect(data!.map((row) => row.id)).toEqual([departmentA]);
  });
});

describe("change 2 — conversation history is scoped to its owner", () => {
  it("lists every one of the caller's own conversations, not only the latest", async () => {
    const rows = await listAssistantConversations({
      supabase: adminA,
      user: authed(adminAId, clinicA, "admin"),
    });
    // The regression: before this pass only the newest was reachable.
    expect(rows.map((row) => row.id).sort()).toEqual(
      [convAdminOne, convAdminTwo].sort(),
    );
    expect(rows.every((row) => row.patientBound === false)).toBe(true);
  });

  it("never lists another user's conversation, in the same clinic or another", async () => {
    const rows = await listAssistantConversations({
      supabase: adminA,
      user: authed(adminAId, clinicA, "admin"),
    });
    expect(rows.map((row) => row.id)).not.toContain(convDoctorPatient);
    expect(rows.map((row) => row.id)).not.toContain(convOtherClinic);
  });

  it("opens the caller's own conversation with its persisted transcript", async () => {
    const loaded = await loadAssistantConversationById({
      supabase: adminA,
      user: authed(adminAId, clinicA, "admin"),
      conversationId: convAdminOne,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Which patients have O+ blood?");
    expect(loaded!.messages).toHaveLength(2);
  });

  it("returns null for a known id belonging to another user", async () => {
    await expect(
      loadAssistantConversationById({
        supabase: adminA,
        user: authed(adminAId, clinicA, "admin"),
        conversationId: convDoctorPatient,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a known id in another tenant", async () => {
    await expect(
      loadAssistantConversationById({
        supabase: adminA,
        user: authed(adminAId, clinicA, "admin"),
        conversationId: convOtherClinic,
      }),
    ).resolves.toBeNull();
  });

  it("refuses the transcript at the database even when the conversation id is known", async () => {
    const { data, error } = await adminA
      .from("agent_messages")
      .select("id, content")
      .eq("conversation_id", convOtherClinic);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("keeps a patient-bound conversation reachable for the doctor still in scope", async () => {
    const loaded = await loadAssistantConversationById({
      supabase: doctorA,
      user: authed(doctorAId, clinicA, "doctor"),
      conversationId: convDoctorPatient,
    });
    expect(loaded).toMatchObject({
      id: convDoctorPatient,
      patientId: patientsA[0]!,
    });
  });

  it("drops the patient-bound conversation once the doctor loses the patient", async () => {
    const reassign = await service
      .from("patients")
      .update({ assigned_doctor_id: null })
      .eq("id", patientsA[0]!);
    expect(reassign.error).toBeNull();
    try {
      const user = authed(doctorAId, clinicA, "doctor");
      await expect(
        loadAssistantConversationById({
          supabase: doctorA,
          user,
          conversationId: convDoctorPatient,
        }),
      ).resolves.toBeNull();
      const rows = await listAssistantConversations({ supabase: doctorA, user });
      // Not merely un-openable — un-listed, so its title cannot leak either.
      expect(rows.map((row) => row.id)).not.toContain(convDoctorPatient);
    } finally {
      await service
        .from("patients")
        .update({ assigned_doctor_id: doctorAId })
        .eq("id", patientsA[0]!);
    }
  });

  it("shows the other clinic's admin only their own conversation", async () => {
    const rows = await listAssistantConversations({
      supabase: adminB,
      user: authed(adminBId, clinicB, "admin"),
    });
    expect(rows.map((row) => row.id)).toEqual([convOtherClinic]);
  });
});
