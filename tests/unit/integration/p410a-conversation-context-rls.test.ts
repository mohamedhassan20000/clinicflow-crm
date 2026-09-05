import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Json } from "@/types/database";
import {
  ensureDoctorConversation,
  loadLatestDoctorConversation,
  persistDoctorTurn,
} from "@/lib/ai/conversations";
import {
  activeEntityId,
  activePatientId,
} from "@/lib/ai/conversation-context";

// P4.10A conversational entity context (session memory) through live RLS.
// Asserts the trust boundary end to end against local Postgres:
//   * a server-derived resolution persists into the owner's active_context and
//     the next turn resolves the same patient — no re-asking;
//   * a later resolution switches the slot;
//   * active_context is owner-scoped and clinic-isolated exactly like the rest of
//     the conversation — no colleague, no other clinic can read it;
//   * ending the conversation (archive) clears it and deleting it removes it;
//   * a patient tool defaulting to the active patient still re-authorizes the
//     effective id through doctor-scoping RLS, so a lost-access patient yields
//     found:false — context can never widen access.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p410a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P410aContextTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const departmentA = randomUUID();
const departmentB = randomUUID();
const patientA = randomUUID();
const patientB = randomUUID();
const patientClinicB = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
let doctorA: Client;
let doctorDeptB: Client;
let doctorB: Client;
let doctorAId = "";

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p410a-${Math.random().toString(36).slice(2)}`,
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

function userFor(id: string, departmentId: string | null) {
  return {
    id,
    clinicId: clinicA,
    email: `${id}@example.test`,
    fullName: "Doctor",
    role: "doctor" as const,
    avatarUrl: null,
    departmentId,
    mustChangePassword: false,
  };
}

async function cleanup() {
  await service.from("agent_messages").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("agent_conversations").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("medical_notes").delete().in("patient_id", [patientA, patientB, patientClinicB]);
  await service.from("patients").delete().in("id", [patientA, patientB, patientClinicB]);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("departments").delete().in("id", [departmentA, departmentB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

/**
 * Phase 7. This built `get_patient_summary` to prove that an active-context
 * patient id is re-authorized against live RLS on every turn — a stale or
 * cross-clinic slot returns nothing, never data. That tool is superseded, so the
 * same property is now asserted on the surface that carries it: the model reads
 * the active id out of its prompt and passes it to `get_record`, whose compiler
 * re-authorizes it identically. The claim under test is unchanged and still runs
 * against real policies with real JWTs.
 */
async function buildLiveRecordTool(
  dbClient: Client,
  user: { id: string; clinicId: string; role: "doctor"; departmentId: string | null },
) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => dbClient) }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: user.clinicId,
      planSlug: "pro_ai",
      features: {
        ai_assistant: true,
        "ai.read_clinical": true,
        "ai.read_operational": true,
      },
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

  const { getRecordTool } = await import("@/lib/ai/tools/get-record");
  return getRecordTool({
    user: { ...user, email: `${user.id}@example.test`, fullName: "Doctor", avatarUrl: null, mustChangePassword: false },
    locale: "en",
  });
}

beforeAll(async () => {
  const [docA, docDeptB, docB] = await Promise.all([
    createUser("doctor-a"),
    createUser("doctor-dept-b"),
    createUser("doctor-b"),
  ]);
  doctorA = docA.client;
  doctorDeptB = docDeptB.client;
  doctorB = docB.client;
  doctorAId = docA.id;

  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P410A Clinic A ${suffix}` },
    { id: clinicB, name: `P410A Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const departments = await service.from("departments").insert([
    { id: departmentA, clinic_id: clinicA, name: `P410A Dept A ${suffix}` },
    { id: departmentB, clinic_id: clinicA, name: `P410A Dept B ${suffix}` },
  ]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    { id: docA.id, clinic_id: clinicA, department_id: departmentA, full_name: "Doctor A", role: "doctor" },
    { id: docDeptB.id, clinic_id: clinicA, department_id: departmentB, full_name: "Doctor Dept B", role: "doctor" },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    {
      id: patientA, clinic_id: clinicA, full_name: "Mohamed Hassan", date_of_birth: "1990-01-01",
      phone: "+96550000001", email: `${suffix}-a@example.com`, national_id: `${Date.now()}01`,
      file_number: `${suffix}-a`, created_by: docA.id, department_id: departmentA, assigned_doctor_id: docA.id,
    },
    {
      id: patientB, clinic_id: clinicA, full_name: "Sara Ali", date_of_birth: "1985-05-05",
      phone: "+96550000002", email: `${suffix}-b@example.com`, national_id: `${Date.now()}02`,
      file_number: `${suffix}-b`, created_by: docA.id, department_id: departmentB, assigned_doctor_id: docDeptB.id,
    },
    {
      id: patientClinicB, clinic_id: clinicB, full_name: "Other Clinic Patient", date_of_birth: "1980-08-08",
      phone: "+96550000003", email: `${suffix}-c@example.com`, national_id: `${Date.now()}03`,
      file_number: `${suffix}-c`, created_by: docB.id, assigned_doctor_id: docB.id,
    },
  ]);
  if (patients.error) throw patients.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)));
  await Promise.all([doctorA?.auth.signOut(), doctorDeptB?.auth.signOut(), doctorB?.auth.signOut()]);
}, 60_000);

describe("P4.10A active-context round-trip and switching", () => {
  it("persists a server-derived resolution and resolves it on the next turn without re-asking", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);

    // Turn 1: the row is virtual until persisted; a tool resolved patient A.
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed Hassan", assistantText: "Opened.",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });

    // Turn 2: the follow-up ("when was his last visit?") loads the active patient.
    const turn2 = await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    expect(activePatientId(turn2.activeContext)).toBe(patientA);
    expect(turn2.activeContext.patient).toMatchObject({
      entity_type: "patient", entity_id: patientA, display_label: "Mohamed Hassan", set_by: "resolution",
    });

    // loadLatestDoctorConversation returns the same context.
    const latest = await loadLatestDoctorConversation({ supabase: doctorA, user });
    expect(latest?.id).toBe(conversationId);
    expect(activePatientId(latest?.activeContext ?? {})).toBe(patientA);
  });

  it("switches the active patient on a later resolution (natural context switch)", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "now show me Sara", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientB, displayLabel: "Sara Ali", setBy: "resolution" },
    });
    const reloaded = await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    expect(activePatientId(reloaded.activeContext)).toBe(patientB);
  });

  it("leaves the stored context untouched on a turn with no proposal", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "thanks", assistantText: "you're welcome", contextProposal: null,
    });
    const reloaded = await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    expect(activePatientId(reloaded.activeContext)).toBe(patientA);
  });
});

describe("P4.10A tenant/owner isolation of active_context", () => {
  it("keeps active_context private to the owner, invisible to a colleague and another clinic", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });

    // A colleague in the same clinic (not the owner) cannot read the row at all.
    const colleague = await doctorDeptB
      .from("agent_conversations")
      .select("id, active_context")
      .eq("id", conversationId);
    expect(colleague.data ?? []).toEqual([]);

    // Another clinic cannot read it either.
    const otherClinic = await doctorB
      .from("agent_conversations")
      .select("id, active_context")
      .eq("id", conversationId);
    expect(otherClinic.data ?? []).toEqual([]);

    // The owner sees the persisted context.
    const owner = await doctorA
      .from("agent_conversations")
      .select("active_context")
      .eq("id", conversationId)
      .single();
    expect(owner.error).toBeNull();
    expect((owner.data?.active_context as { patient?: { entity_id: string } }).patient?.entity_id).toBe(patientA);
  });
});

describe("P4.10B cross-entity context through live RLS", () => {
  it("persists every independent slot, switches one naturally, and remains owner/clinic isolated", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    const appointmentId = randomUUID();
    const invoiceId = randomUUID();
    const staffId = randomUUID();
    const departmentId = randomUUID();

    await ensureDoctorConversation({
      supabase: doctorA,
      user,
      conversationId,
      locale: "en",
      patientId: null,
    });
    await persistDoctorTurn({
      supabase: doctorA,
      user,
      conversationId,
      locale: "en",
      patientId: null,
      userText: "resolve the entities",
      assistantText: "ok",
      contextProposals: [
        { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
        { entityType: "appointment", entityId: appointmentId, displayLabel: "Appointment A", setBy: "resolution" },
        { entityType: "invoice", entityId: invoiceId, displayLabel: "Invoice A", setBy: "resolution" },
        { entityType: "staff", entityId: staffId, displayLabel: "Doctor A", setBy: "resolution" },
        { entityType: "department", entityId: departmentId, displayLabel: "Department A", setBy: "resolution" },
        { entityType: "report", entityId: "no_shows", displayLabel: "No-show report", setBy: "resolution" },
      ],
    });

    const owner = await ensureDoctorConversation({
      supabase: doctorA,
      user,
      conversationId,
      locale: "en",
      patientId: null,
    });
    expect(activeEntityId(owner.activeContext, "patient")).toBe(patientA);
    expect(activeEntityId(owner.activeContext, "appointment")).toBe(appointmentId);
    expect(activeEntityId(owner.activeContext, "invoice")).toBe(invoiceId);
    expect(activeEntityId(owner.activeContext, "staff")).toBe(staffId);
    expect(activeEntityId(owner.activeContext, "department")).toBe(departmentId);
    expect(activeEntityId(owner.activeContext, "report")).toBe("no_shows");

    const switchedAppointment = randomUUID();
    await persistDoctorTurn({
      supabase: doctorA,
      user,
      conversationId,
      locale: "en",
      patientId: null,
      userText: "now use the other appointment",
      assistantText: "ok",
      contextProposals: [
        {
          entityType: "appointment",
          entityId: switchedAppointment,
          displayLabel: "Appointment B",
          setBy: "user_choice",
        },
      ],
    });
    const switched = await ensureDoctorConversation({
      supabase: doctorA,
      user,
      conversationId,
      locale: "en",
      patientId: null,
    });
    expect(activeEntityId(switched.activeContext, "appointment")).toBe(
      switchedAppointment,
    );
    expect(activeEntityId(switched.activeContext, "patient")).toBe(patientA);
    expect(activeEntityId(switched.activeContext, "report")).toBe("no_shows");

    const [colleague, otherClinic] = await Promise.all([
      doctorDeptB
        .from("agent_conversations")
        .select("id, active_context")
        .eq("id", conversationId),
      doctorB
        .from("agent_conversations")
        .select("id, active_context")
        .eq("id", conversationId),
    ]);
    expect(colleague.data ?? []).toEqual([]);
    expect(otherClinic.data ?? []).toEqual([]);
  });
});

describe("P4.10A session-scoped lifecycle", () => {
  it("clears active_context when the conversation ends (archive)", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });

    const archived = await doctorA
      .from("agent_conversations")
      .update({ status: "archived" })
      .eq("id", conversationId)
      .select("status, active_context")
      .single();
    expect(archived.error).toBeNull();
    expect(archived.data?.status).toBe("archived");
    expect(archived.data?.active_context).toEqual({});
  });

  it("removes active_context with the conversation on delete", async () => {
    const conversationId = randomUUID();
    const user = userFor(doctorAId, departmentA);
    await ensureDoctorConversation({ supabase: doctorA, user, conversationId, locale: "en", patientId: null });
    await persistDoctorTurn({
      supabase: doctorA, user, conversationId, locale: "en", patientId: null,
      userText: "open Mohamed", assistantText: "ok",
      contextProposal: { entityType: "patient", entityId: patientA, displayLabel: "Mohamed Hassan", setBy: "resolution" },
    });
    const del = await doctorA.from("agent_conversations").delete().eq("id", conversationId);
    expect(del.error).toBeNull();
    const gone = await doctorA.from("agent_conversations").select("id").eq("id", conversationId);
    expect(gone.data ?? []).toEqual([]);
  });
});

describe("P4.10A active-context id is re-authorized every turn", () => {
  const actor = () => ({
    id: doctorAId,
    clinicId: clinicA,
    role: "doctor" as const,
    departmentId: departmentA,
  });

  it("returns the record when the active patient is in the doctor's scope", async () => {
    const tool = await buildLiveRecordTool(doctorA, actor());
    const result = (await tool.execute!(
      { resource: "patients", id: patientA, fields: ["id", "full_name"] },
      {} as never,
    )) as { record?: { full_name: string } };
    expect(result).toMatchObject({ record: { full_name: "Mohamed Hassan" } });
  });

  it("denies with unauthorized_scope when the active patient is outside the doctor's RLS scope", async () => {
    // patientB belongs to department B — not doctor A's assignment/department.
    // The advisory context can never widen access: RLS still returns nothing.
    const tool = await buildLiveRecordTool(doctorA, actor());
    // Raw tool, so the denial surfaces as the typed authorization error the
    // hardening boundary would render as `{permission_denied, reason}`.
    await expect(
      tool.execute!(
        { resource: "patients", id: patientB, fields: ["id", "full_name"] },
        {} as never,
      ),
    ).rejects.toMatchObject({ reason: "unauthorized_scope" });
  });

  it("denies identically when the active patient belongs to another clinic", async () => {
    const tool = await buildLiveRecordTool(doctorA, actor());
    const denial = async (id: string) => {
      try {
        await tool.execute!(
          { resource: "patients", id, fields: ["id", "full_name"] },
          {} as never,
        );
        throw new Error(`Expected a denial for ${id}.`);
      } catch (error) {
        const typed = error as { reason?: string; message?: string };
        return { reason: typed.reason, message: typed.message };
      }
    };
    const foreign = await denial(patientClinicB);
    const absent = await denial("00000000-0000-4000-8000-0000000000ff");
    // Byte-identical: "not yours" must not be distinguishable from "not there".
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(absent));
    expect(foreign.reason).toBe("unauthorized_scope");
  });
});
