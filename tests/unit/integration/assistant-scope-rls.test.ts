import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// Assistant data-scope isolation, run against live Postgres because the property
// under test is a database property: an assistant may read exactly the UNION of
// its assigned doctors' own patients/appointments/follow-ups — never a third
// doctor's, never another clinic's, never clinic-wide. RLS + the scope-aware
// report RPCs enforce it; a mocked client cannot prove any of that.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `asst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "AsstScope12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const ALL_CLINICS = [clinicA, clinicB];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

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
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  userIds.push(created.data.user.id);
  const signedIn = client();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

function patientRow(clinicId: string, createdBy: string, doctorId: string, index: number) {
  return {
    id: randomUUID(),
    clinic_id: clinicId,
    full_name: `Asst Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655100${String(index).padStart(4, "0")}`,
    email: `${suffix}-p${index}-${clinicId.slice(0, 8)}@example.com`,
    national_id: `${Date.now()}${index}${clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${clinicId.slice(0, 4)}-${index}`,
    assigned_doctor_id: doctorId,
    created_by: createdBy,
  };
}

const RANGE = {
  p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
};
const inRange = () => new Date(Date.now() - 86_400_000).toISOString();

let assistant: Client;
let assistantId = "";
let adminA: Client;
let doctorA1: Client;
let docA1Id = "";
let docA2Id = "";
let adminAId = "";
let managerA: Client;
let managerAId = "";
let docBId = "";
const patientA1 = randomUUID();
const patientA2 = randomUUID();
const patientB = randomUUID();
const apptA1 = randomUUID();
const apptA2 = randomUUID();
const apptB = randomUUID();

async function cleanup() {
  await service.from("assistant_doctor_assignments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("appointments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [admin, d1, d2, asst, mgr, adminB, docB] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a1"),
    createUser("doctor-a2"),
    createUser("assistant"),
    createUser("manager-a"),
    createUser("admin-b"),
    createUser("doctor-b"),
  ]);
  assistant = asst.client;
  assistantId = asst.id;
  adminA = admin.client;
  doctorA1 = d1.client;
  docA1Id = d1.id;
  docA2Id = d2.id;
  adminAId = admin.id;
  managerA = mgr.client;
  managerAId = mgr.id;
  docBId = docB.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Asst Clinic A ${suffix}` },
    { id: clinicB, name: `Asst Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: admin.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: d1.id, clinic_id: clinicA, full_name: "Doctor A1", role: "doctor", is_active: true },
    { id: d2.id, clinic_id: clinicA, full_name: "Doctor A2", role: "doctor", is_active: true },
    { id: asst.id, clinic_id: clinicA, full_name: "Assistant", role: "assistant", is_active: true },
    { id: mgr.id, clinic_id: clinicA, full_name: "Manager A", role: "manager", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert([
    patientRow(clinicA, adminAId, docA1Id, 1),
    patientRow(clinicA, adminAId, docA2Id, 2),
    patientRow(clinicB, adminB.id, docB.id, 3),
  ].map((row, i) => ({ ...row, id: [patientA1, patientA2, patientB][i] })));
  if (patients.error) throw patients.error;

  const appts = await service.from("appointments").insert([
    {
      id: apptA1,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: inRange(),
      duration_minutes: 30,
      created_by: adminAId,
      status: "cancelled",
    },
    {
      id: apptA2,
      clinic_id: clinicA,
      patient_id: patientA2,
      doctor_id: docA2Id,
      scheduled_at: inRange(),
      duration_minutes: 30,
      created_by: adminAId,
      status: "no_show",
    },
    {
      id: apptB,
      clinic_id: clinicB,
      patient_id: patientB,
      doctor_id: docB.id,
      scheduled_at: inRange(),
      duration_minutes: 30,
      created_by: adminB.id,
      status: "cancelled",
    },
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

describe("assistant scope — single assigned doctor", () => {
  it("resolves auth_supervised_doctor_ids to exactly the assigned doctor", async () => {
    const { data, error } = await assistant.rpc("auth_supervised_doctor_ids");
    expect(error).toBeNull();
    expect(new Set(data as string[])).toEqual(new Set([docA1Id]));
  });

  it("reads only the assigned doctor's patients", async () => {
    const { data, error } = await assistant.from("patients").select("id, assigned_doctor_id");
    expect(error).toBeNull();
    expect((data ?? []).map((p) => p.id)).toEqual([patientA1]);
  });

  it("reads only the assigned doctor's appointments", async () => {
    const { data, error } = await assistant.from("appointments").select("id, doctor_id");
    expect(error).toBeNull();
    expect((data ?? []).map((a) => a.id)).toEqual([apptA1]);
  });

  it("scopes the cancellation report to the assigned doctor only", async () => {
    const { data, error } = await assistant.rpc("get_cancellation_report", RANGE);
    expect(error).toBeNull();
    const report = data as { totalAppointments: number; cancelledCount: number };
    expect(report.totalAppointments).toBe(1);
    expect(report.cancelledCount).toBe(1);
  });

  it("never leaks another clinic's data", async () => {
    const patients = await assistant.from("patients").select("id").eq("id", patientB);
    expect(patients.data ?? []).toHaveLength(0);
    const appts = await assistant.from("appointments").select("id").eq("id", apptB);
    expect(appts.data ?? []).toHaveLength(0);
  });
});

describe("Phase 7 supervision replacement and customization RLS", () => {
  it("atomically replaces a non-empty, valid supervising-doctor set", async () => {
    const replace = await managerA.rpc(
      "replace_assistant_doctor_assignments",
      {
        p_assistant_id: assistantId,
        p_doctor_ids: [docA1Id, docA2Id, docA2Id],
      },
    );
    expect(replace.error).toBeNull();

    const { data } = await service
      .from("assistant_doctor_assignments")
      .select("doctor_id")
      .eq("assistant_id", assistantId);
    expect(new Set((data ?? []).map((row) => row.doctor_id))).toEqual(
      new Set([docA1Id, docA2Id]),
    );

    const restore = await managerA.rpc(
      "replace_assistant_doctor_assignments",
      {
        p_assistant_id: assistantId,
        p_doctor_ids: [docA1Id],
      },
    );
    expect(restore.error).toBeNull();
  });

  it("rejects empty/cross-clinic sets without erasing the existing assignment", async () => {
    for (const p_doctor_ids of [[], [docBId]]) {
      const result = await managerA.rpc(
        "replace_assistant_doctor_assignments",
        { p_assistant_id: assistantId, p_doctor_ids },
      );
      expect(result.error).not.toBeNull();
    }

    const { data } = await service
      .from("assistant_doctor_assignments")
      .select("doctor_id")
      .eq("assistant_id", assistantId);
    expect((data ?? []).map((row) => row.doctor_id)).toEqual([docA1Id]);
  });

  it("enforces the same-clinic role invariant even for service-role writes", async () => {
    const result = await service.from("assistant_doctor_assignments").insert({
      clinic_id: clinicA,
      assistant_id: assistantId,
      doctor_id: docBId,
      created_by: adminAId,
    });
    expect(result.error?.code).toBe("23514");
  });

  it("denies partial direct assignment writes by managers", async () => {
    const deletion = await managerA
      .from("assistant_doctor_assignments")
      .delete()
      .eq("assistant_id", assistantId);
    expect(deletion.error).toBeNull();

    const insertion = await managerA
      .from("assistant_doctor_assignments")
      .insert({
        clinic_id: clinicA,
        assistant_id: assistantId,
        doctor_id: docA2Id,
        created_by: managerAId,
      });
    expect(insertion.error).not.toBeNull();

    const { data } = await service
      .from("assistant_doctor_assignments")
      .select("doctor_id")
      .eq("assistant_id", assistantId);
    expect((data ?? []).map((row) => row.doctor_id)).toEqual([docA1Id]);
  });

  it("denies non-primary direct page/report customization", async () => {
    const page = await managerA.from("user_page_permissions").upsert({
      user_id: assistantId,
      clinic_id: clinicA,
      page_slug: "reports",
      is_visible: false,
    });
    const report = await managerA.from("user_report_permissions").upsert({
      user_id: assistantId,
      clinic_id: clinicA,
      report_id: "cancellations",
      is_visible: false,
    });
    expect(page.error).not.toBeNull();
    expect(report.error).not.toBeNull();
  });

  it("allows the primary admin to customize non-primary staff but not itself", async () => {
    const staffPage = await adminA.from("user_page_permissions").upsert({
      user_id: assistantId,
      clinic_id: clinicA,
      page_slug: "reports",
      is_visible: false,
    });
    expect(staffPage.error).toBeNull();

    const ownPage = await adminA.from("user_page_permissions").upsert({
      user_id: adminAId,
      clinic_id: clinicA,
      page_slug: "reports",
      is_visible: false,
    });
    expect(ownPage.error).not.toBeNull();

    await service
      .from("user_page_permissions")
      .delete()
      .eq("user_id", assistantId)
      .eq("page_slug", "reports");
  });

  it("patient-binds assistant conversations to the supervised-doctor scope", async () => {
    const allowedId = randomUUID();
    const allowed = await assistant.from("agent_conversations").insert({
      id: allowedId,
      clinic_id: clinicA,
      user_id: assistantId,
      patient_id: patientA1,
      persona: "doctor",
      locale: "en",
    });
    expect(allowed.error).toBeNull();

    const denied = await assistant.from("agent_conversations").insert({
      id: randomUUID(),
      clinic_id: clinicA,
      user_id: assistantId,
      patient_id: patientA2,
      persona: "doctor",
      locale: "en",
    });
    expect(denied.error).not.toBeNull();

    await service.from("agent_conversations").delete().eq("id", allowedId);
  });
});

describe("assistant scope — union of multiple assigned doctors", () => {
  beforeAll(async () => {
    const assign = await service.from("assistant_doctor_assignments").insert({
      clinic_id: clinicA,
      assistant_id: assistantId,
      doctor_id: docA2Id,
      created_by: adminAId,
    });
    if (assign.error) throw assign.error;
  });

  it("unions the two assigned doctors' patients", async () => {
    const { data, error } = await assistant.from("patients").select("id");
    expect(error).toBeNull();
    expect(new Set((data ?? []).map((p) => p.id))).toEqual(
      new Set([patientA1, patientA2]),
    );
  });

  it("aggregates reports across the union only (never clinic-wide)", async () => {
    const cancel = await assistant.rpc("get_cancellation_report", RANGE);
    expect(cancel.error).toBeNull();
    const c = cancel.data as { totalAppointments: number; cancelledCount: number };
    // apptA1 (cancelled) + apptA2 (no_show) = 2 appts, 1 cancelled. apptB excluded.
    expect(c.totalAppointments).toBe(2);
    expect(c.cancelledCount).toBe(1);

    const noShow = await assistant.rpc("get_no_show_report", RANGE);
    expect(noShow.error).toBeNull();
    const n = noShow.data as { totalAppointments: number; noShowCount: number };
    expect(n.totalAppointments).toBe(2);
    expect(n.noShowCount).toBe(1);
  });

  it("re-scopes immediately when a doctor is unassigned", async () => {
    const remove = await service
      .from("assistant_doctor_assignments")
      .delete()
      .eq("assistant_id", assistantId)
      .eq("doctor_id", docA2Id);
    expect(remove.error).toBeNull();

    const { data } = await assistant.from("patients").select("id");
    expect(new Set((data ?? []).map((p) => p.id))).toEqual(new Set([patientA1]));

    // Restore for any later assertions / stable teardown ordering.
    await service.from("assistant_doctor_assignments").insert({
      clinic_id: clinicA,
      assistant_id: assistantId,
      doctor_id: docA2Id,
      created_by: adminAId,
    });
  });
});

describe("doctor scope — self only (report deny removed, RLS enforces)", () => {
  it("scopes the cancellation report to the doctor's own appointments", async () => {
    const { data, error } = await doctorA1.rpc("get_cancellation_report", RANGE);
    expect(error).toBeNull();
    const report = data as { totalAppointments: number; cancelledCount: number };
    expect(report.totalAppointments).toBe(1);
    expect(report.cancelledCount).toBe(1);
  });
});

describe("manager operational authorization (Appointments & Follow-ups)", () => {
  it("lets a manager read the clinic-wide follow-ups dashboard (deny removed)", async () => {
    const { error } = await managerA.rpc("get_followups_dashboard", {
      p_start: RANGE.p_start,
      p_end: RANGE.p_end,
    });
    expect(error).toBeNull();
  });

  it("lets a manager insert and update an appointment (RLS admits manager)", async () => {
    const newId = randomUUID();
    const insert = await managerA.from("appointments").insert({
      id: newId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      duration_minutes: 30,
      created_by: adminAId,
      status: "pending",
    });
    expect(insert.error).toBeNull();

    const update = await managerA
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", newId);
    expect(update.error).toBeNull();

    await service.from("appointments").delete().eq("id", newId);
  });

});

describe("assistant operational writes — scoped to assigned doctors", () => {
  // These run after the union block, where the assistant is assigned to A1 + A2.
  it("can create and update an appointment for an assigned doctor", async () => {
    const newId = randomUUID();
    const insert = await assistant.from("appointments").insert({
      id: newId,
      clinic_id: clinicA,
      patient_id: patientA1,
      doctor_id: docA1Id,
      scheduled_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      duration_minutes: 30,
      created_by: assistantId,
      status: "pending",
    });
    expect(insert.error).toBeNull();

    const update = await assistant
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", newId);
    expect(update.error).toBeNull();
    // Verify it actually changed (RLS could silently affect 0 rows).
    const { data } = await service
      .from("appointments")
      .select("status")
      .eq("id", newId)
      .single();
    expect(data?.status).toBe("confirmed");

    await service.from("appointments").delete().eq("id", newId);
  });

  it("cannot create an appointment for an UNassigned doctor (anti-spoof)", async () => {
    const insert = await assistant.from("appointments").insert({
      id: randomUUID(),
      clinic_id: clinicB, // wrong clinic + unassigned doctor
      patient_id: patientB,
      doctor_id: docBId,
      scheduled_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      duration_minutes: 30,
      created_by: assistantId,
      status: "pending",
    });
    expect(insert.error).not.toBeNull();
  });

  it("cannot modify an appointment belonging to an unrelated doctor", async () => {
    // apptB (clinic B, doctor B) was seeded 'cancelled'. Try to flip it.
    await assistant
      .from("appointments")
      .update({ status: "no_show" })
      .eq("id", apptB);
    const { data } = await service
      .from("appointments")
      .select("status")
      .eq("id", apptB)
      .single();
    // RLS scoped the row out → unchanged.
    expect(data?.status).toBe("cancelled");
  });

  it("can create and update a follow-up for an assigned doctor", async () => {
    const fuId = randomUUID();
    const insert = await assistant.from("follow_ups").insert({
      id: fuId,
      clinic_id: clinicA,
      appointment_id: apptA1,
      patient_id: patientA1,
      outcome: "all_fine",
      recorded_by: assistantId,
    });
    expect(insert.error).toBeNull();

    const update = await assistant
      .from("follow_ups")
      .update({ outcome: "has_problem" })
      .eq("id", fuId);
    expect(update.error).toBeNull();
    const { data } = await service
      .from("follow_ups")
      .select("outcome")
      .eq("id", fuId)
      .single();
    expect(data?.outcome).toBe("has_problem");

    await service.from("follow_ups").delete().eq("id", fuId);
  });

  it("cannot create a follow-up for an unrelated doctor's record", async () => {
    const insert = await assistant.from("follow_ups").insert({
      id: randomUUID(),
      clinic_id: clinicB,
      appointment_id: apptB,
      patient_id: patientB,
      outcome: "all_fine",
      recorded_by: assistantId,
    });
    expect(insert.error).not.toBeNull();
  });

  it("cannot delete appointments (destructive action denied)", async () => {
    await assistant.from("appointments").delete().eq("id", apptA1);
    const { data } = await service
      .from("appointments")
      .select("id")
      .eq("id", apptA1)
      .maybeSingle();
    // Delete is admin-only; the row survives.
    expect(data?.id).toBe(apptA1);
  });

  it("loses write access to a doctor immediately after unassignment", async () => {
    // Unassign A2, then a write targeting A2's appointment must fail-closed.
    await service
      .from("assistant_doctor_assignments")
      .delete()
      .eq("assistant_id", assistantId)
      .eq("doctor_id", docA2Id);

    const update = await assistant
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", apptA2);
    const { data } = await service
      .from("appointments")
      .select("status")
      .eq("id", apptA2)
      .single();
    expect(update.error).toBeNull();
    expect(data?.status).toBe("no_show"); // unchanged from its seeded value

    // Restore assignment for teardown stability.
    await service.from("assistant_doctor_assignments").insert({
      clinic_id: clinicA,
      assistant_id: assistantId,
      doctor_id: docA2Id,
      created_by: adminAId,
    });
  });
});
