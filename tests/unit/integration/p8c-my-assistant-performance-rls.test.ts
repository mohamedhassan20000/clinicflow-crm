import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// Phase 8C — "My Assistant Performance" is a database-enforced property: a doctor
// sees factual actor-level activity ONLY for the assistants assigned to them, and
// ONLY for activity performed on their own entities. An assistant who also serves
// another doctor must not leak that other doctor's activity here, and every
// non-doctor role is denied. Only a real signed-in session proves this, so it
// runs against live Postgres.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `asstperf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "AsstPerfScope12345";
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

const inRange = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const RANGE = {
  p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
};

type AssistantRow = {
  assistantId: string;
  assistantName: string;
  totalActions: number;
  appointmentsBooked: number;
  confirmations: number;
  checkIns: number;
  completions: number;
  cancellations: number;
  noShows: number;
  reschedules: number;
  replacements: number;
  statusChanges: number;
  followUpsRecorded: number;
  followUpUpdates: number;
};

let doctorA1: Client;
let doctorA2: Client;
let doctorB: Client;
let adminA: Client;
let receptionistA: Client;
let assistant1Client: Client;
let adminAId = "";
let docA1Id = "";
let docA2Id = "";
let docBId = "";
let assistant1Id = "";
let assistant2Id = "";
let assistant3Id = "";
let adminBId = "";
let assistantBId = "";

function event(args: {
  clinicId: string;
  actorId: string;
  doctorId: string;
  action: string;
  occurredAt?: string;
}) {
  return {
    clinic_id: args.clinicId,
    actor_id: args.actorId,
    actor_role: "assistant" as const,
    is_system: false,
    action: args.action,
    entity_type: args.action.startsWith("follow_up") ? "follow_up" : "appointment",
    entity_id: randomUUID(),
    doctor_id: args.doctorId,
    occurred_at: args.occurredAt ?? inRange(24),
  };
}

async function cleanup() {
  await service.from("activity_events").delete().in("clinic_id", ALL_CLINICS);
  await service.from("assistant_doctor_assignments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [admin, d1, d2, recep, a1, a2, a3, adminB, docB, aB] = await Promise.all([
    createUser("admin-a"),
    createUser("doctor-a1"),
    createUser("doctor-a2"),
    createUser("receptionist-a"),
    createUser("assistant-1"),
    createUser("assistant-2"),
    createUser("assistant-3"),
    createUser("admin-b"),
    createUser("doctor-b"),
    createUser("assistant-b"),
  ]);
  adminA = admin.client;
  adminAId = admin.id;
  doctorA1 = d1.client;
  doctorA2 = d2.client;
  docA1Id = d1.id;
  docA2Id = d2.id;
  receptionistA = recep.client;
  assistant1Client = a1.client;
  assistant1Id = a1.id;
  assistant2Id = a2.id;
  assistant3Id = a3.id;
  doctorB = docB.client;
  docBId = docB.id;
  adminBId = adminB.id;
  assistantBId = aB.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `AsstPerf Clinic A ${suffix}` },
    { id: clinicB, name: `AsstPerf Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const profiles = await service.from("profiles").insert([
    { id: admin.id, clinic_id: clinicA, full_name: "Admin A", role: "admin", is_active: true },
    { id: d1.id, clinic_id: clinicA, full_name: "Doctor A1", role: "doctor", is_active: true },
    { id: d2.id, clinic_id: clinicA, full_name: "Doctor A2", role: "doctor", is_active: true },
    { id: recep.id, clinic_id: clinicA, full_name: "Receptionist A", role: "receptionist", is_active: true },
    { id: a1.id, clinic_id: clinicA, full_name: "Assistant One", role: "assistant", is_active: true },
    { id: a2.id, clinic_id: clinicA, full_name: "Assistant Two", role: "assistant", is_active: true },
    { id: a3.id, clinic_id: clinicA, full_name: "Assistant Three", role: "assistant", is_active: true },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin", is_active: true },
    { id: docB.id, clinic_id: clinicB, full_name: "Doctor B", role: "doctor", is_active: true },
    { id: aB.id, clinic_id: clinicB, full_name: "Assistant B", role: "assistant", is_active: true },
  ]);
  if (profiles.error) throw profiles.error;

  // Assistant 1 → both A1 and A2 (multi-assignment). Assistant 2 → A1 only.
  // Assistant 3 → A2 only (must never appear in A1's report). Assistant B → B.
  const assignments = await service.from("assistant_doctor_assignments").insert([
    { clinic_id: clinicA, assistant_id: assistant1Id, doctor_id: docA1Id, created_by: adminAId },
    { clinic_id: clinicA, assistant_id: assistant1Id, doctor_id: docA2Id, created_by: adminAId },
    { clinic_id: clinicA, assistant_id: assistant2Id, doctor_id: docA1Id, created_by: adminAId },
    { clinic_id: clinicA, assistant_id: assistant3Id, doctor_id: docA2Id, created_by: adminAId },
    { clinic_id: clinicB, assistant_id: assistantBId, doctor_id: docBId, created_by: adminBId },
  ]);
  if (assignments.error) throw assignments.error;

  const events = await service.from("activity_events").insert([
    // Assistant 1 on Doctor A1's entities: 1 booked, 2 confirmed, 1 rescheduled,
    // 1 follow-up recorded = 5 actions (4 are status changes: 2 confirmed +
    // 1 rescheduled is NOT a status change, so statusChanges = 2).
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA1Id, action: "appointment.created" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA1Id, action: "appointment.confirmed" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA1Id, action: "appointment.confirmed" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA1Id, action: "appointment.rescheduled" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA1Id, action: "follow_up.recorded" }),
    // Assistant 1 on Doctor A2's entities — must NOT enter A1's report.
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA2Id, action: "appointment.confirmed" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA2Id, action: "appointment.confirmed" }),
    event({ clinicId: clinicA, actorId: assistant1Id, doctorId: docA2Id, action: "appointment.confirmed" }),
    // Assistant 1 on A1 but OUTSIDE the window — must NOT be counted.
    event({
      clinicId: clinicA,
      actorId: assistant1Id,
      doctorId: docA1Id,
      action: "appointment.completed",
      occurredAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    }),
    // Assistant 2 on Doctor A1's entities: 1 completion.
    event({ clinicId: clinicA, actorId: assistant2Id, doctorId: docA1Id, action: "appointment.completed" }),
    // Assistant 3 on Doctor A2's entities (assigned to A2, not A1).
    event({ clinicId: clinicA, actorId: assistant3Id, doctorId: docA2Id, action: "appointment.confirmed" }),
    // Clinic B — never in any clinic A scope.
    event({ clinicId: clinicB, actorId: assistantBId, doctorId: docBId, action: "appointment.confirmed" }),
  ]);
  if (events.error) throw events.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

function byId(rows: AssistantRow[], id: string) {
  return rows.find((r) => r.assistantId === id);
}

describe("My Assistant Performance — a doctor sees only their assigned assistants", () => {
  it("returns each assistant assigned to the caller, and none that are not", async () => {
    const { data, error } = await doctorA1.rpc("get_my_assistant_performance", RANGE);
    expect(error).toBeNull();
    const rows = (data as unknown as { assistants: AssistantRow[] }).assistants;
    const ids = rows.map((r) => r.assistantId).sort();
    // Assistant 1 and Assistant 2 are assigned to A1; Assistant 3 is not.
    expect(ids).toEqual([assistant1Id, assistant2Id].sort());
    expect(byId(rows, assistant3Id)).toBeUndefined();
  });

  it("counts only activity on the caller's own entities (multi-assignment isolation)", async () => {
    const { data } = await doctorA1.rpc("get_my_assistant_performance", RANGE);
    const rows = (data as unknown as { assistants: AssistantRow[] }).assistants;
    const a1 = byId(rows, assistant1Id)!;
    // A1-scoped, in-window only: 1 booked + 2 confirmed + 1 rescheduled +
    // 1 follow-up = 5. The three A2-scoped confirmations and the out-of-window
    // completion are excluded.
    expect(a1.totalActions).toBe(5);
    expect(a1.appointmentsBooked).toBe(1);
    expect(a1.confirmations).toBe(2);
    expect(a1.reschedules).toBe(1);
    expect(a1.followUpsRecorded).toBe(1);
    expect(a1.completions).toBe(0);
    // statusChanges = confirmed(2); rescheduled is not a status change.
    expect(a1.statusChanges).toBe(2);
  });

  it("shows an assigned assistant with their own scoped activity", async () => {
    const { data } = await doctorA1.rpc("get_my_assistant_performance", RANGE);
    const rows = (data as unknown as { assistants: AssistantRow[] }).assistants;
    const a2 = byId(rows, assistant2Id)!;
    expect(a2.totalActions).toBe(1);
    expect(a2.completions).toBe(1);
  });

  it("gives the other doctor the A2-scoped view of the shared assistant", async () => {
    const { data, error } = await doctorA2.rpc("get_my_assistant_performance", RANGE);
    expect(error).toBeNull();
    const rows = (data as unknown as { assistants: AssistantRow[] }).assistants;
    // A2 is assigned Assistant 1 and Assistant 3.
    expect(rows.map((r) => r.assistantId).sort()).toEqual([assistant1Id, assistant3Id].sort());
    const a1 = byId(rows, assistant1Id)!;
    // The same assistant, but now only their A2-scoped events (3 confirmations).
    expect(a1.confirmations).toBe(3);
    expect(a1.totalActions).toBe(3);
  });
});

describe("My Assistant Performance — cross-clinic isolation & role denial", () => {
  it("never surfaces another clinic's assistant activity", async () => {
    const { data } = await doctorB.rpc("get_my_assistant_performance", RANGE);
    const rows = (data as unknown as { assistants: AssistantRow[] }).assistants;
    expect(rows.map((r) => r.assistantId)).toEqual([assistantBId]);
    expect(byId(rows, assistant1Id)).toBeUndefined();
  });

  it("denies admin (uses clinic-wide staff reports instead)", async () => {
    const { error } = await adminA.rpc("get_my_assistant_performance", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies receptionist", async () => {
    const { error } = await receptionistA.rpc("get_my_assistant_performance", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies an assistant (must not see another assistant's performance)", async () => {
    const { error } = await assistant1Client.rpc("get_my_assistant_performance", RANGE);
    expect(error?.code).toBe("42501");
  });

  it("denies an anonymous caller", async () => {
    const { error } = await anonClient().rpc("get_my_assistant_performance", RANGE);
    expect(error).not.toBeNull();
  });
});
