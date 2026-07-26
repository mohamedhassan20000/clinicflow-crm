import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Json } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p411a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P411aWorkflowLedger12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const clinics = [clinicA, clinicB];
const userIds: string[] = [];
const runA = randomUUID();
const runB = randomUUID();
const previewRun = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
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
    throw created.error ?? new Error("No user returned");
  }
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

let ownerA: Client;
let colleagueA: Client;
let ownerB: Client;
let ownerAId = "";
let colleagueAId = "";
let ownerBId = "";

const planSummary = {
  version: 1,
  step_count: 1,
  cost_units: 1,
  steps: [{
    id: "help",
    tool: "search_help",
    depends_on: [],
    params: [{ key: "query", shape: "string", references: [] }],
  }],
} as unknown as Json;

const stepStates = [{
  id: "help",
  tool: "search_help",
  status: "succeeded",
  started_at: "2026-07-26T10:00:00.000Z",
  completed_at: "2026-07-26T10:00:00.010Z",
  duration_ms: 10,
  error_code: null,
}] as unknown as Json;

beforeAll(async () => {
  const [oa, ca, ob] = await Promise.all([
    createUser("owner-a"),
    createUser("colleague-a"),
    createUser("owner-b"),
  ]);
  ownerA = oa.client;
  colleagueA = ca.client;
  ownerB = ob.client;
  ownerAId = oa.id;
  colleagueAId = ca.id;
  ownerBId = ob.id;

  await service.from("ai_workflow_runs").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);

  const clinicInsert = await service.from("clinics").insert([
    { id: clinicA, name: `P411A Clinic A ${suffix}` },
    { id: clinicB, name: `P411A Clinic B ${suffix}` },
  ]);
  if (clinicInsert.error) throw clinicInsert.error;

  const profileInsert = await service.from("profiles").insert([
    {
      id: ownerAId,
      clinic_id: clinicA,
      full_name: "P411A Owner A",
      role: "admin",
    },
    {
      id: colleagueAId,
      clinic_id: clinicA,
      full_name: "P411A Colleague A",
      role: "manager",
    },
    {
      id: ownerBId,
      clinic_id: clinicB,
      full_name: "P411A Owner B",
      role: "admin",
    },
  ]);
  if (profileInsert.error) throw profileInsert.error;

  const runInsert = await service.from("ai_workflow_runs").insert([
    {
      id: runA,
      clinic_id: clinicA,
      user_id: ownerAId,
      mode: "execute",
      state: "succeeded",
      plan: planSummary,
      step_states: stepStates,
      step_count: 1,
      cost_units: 1,
      started_at: "2026-07-26T10:00:00.000Z",
      completed_at: "2026-07-26T10:00:00.010Z",
    },
    {
      id: previewRun,
      clinic_id: clinicA,
      user_id: ownerAId,
      mode: "dry_run",
      state: "previewed",
      plan: planSummary,
      step_states: stepStates,
      step_count: 1,
      cost_units: 1,
      dry_run_snapshot_hash: "a".repeat(64),
      completed_at: "2026-07-26T10:00:00.010Z",
    },
    {
      id: runB,
      clinic_id: clinicB,
      user_id: ownerBId,
      mode: "execute",
      state: "succeeded",
      plan: planSummary,
      step_states: stepStates,
      step_count: 1,
      cost_units: 1,
      started_at: "2026-07-26T10:00:00.000Z",
      completed_at: "2026-07-26T10:00:00.010Z",
    },
  ]);
  if (runInsert.error) throw runInsert.error;
}, 60_000);

afterAll(async () => {
  await service.from("ai_workflow_runs").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P4.11A workflow run RLS and server authority", () => {
  it("lets the requesting user read only their own clinic run", async () => {
    const own = await ownerA
      .from("ai_workflow_runs")
      .select("id, clinic_id, user_id, state")
      .in("id", [runA, runB]);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([
      {
        id: runA,
        clinic_id: clinicA,
        user_id: ownerAId,
        state: "succeeded",
      },
    ]);
  });

  it("hides a run from a same-clinic colleague and another clinic", async () => {
    const [colleague, otherClinic] = await Promise.all([
      colleagueA.from("ai_workflow_runs").select("id").eq("id", runA),
      ownerB.from("ai_workflow_runs").select("id").eq("id", runA),
    ]);
    expect(colleague.error).toBeNull();
    expect(colleague.data).toEqual([]);
    expect(otherClinic.error).toBeNull();
    expect(otherClinic.data).toEqual([]);
  });

  it("denies authenticated inserts, updates, and deletes", async () => {
    const insert = await ownerA.from("ai_workflow_runs").insert({
      clinic_id: clinicA,
      user_id: ownerAId,
      mode: "execute",
      state: "succeeded",
      plan: planSummary,
      step_count: 1,
      cost_units: 1,
      started_at: "2026-07-26T10:00:00.000Z",
      completed_at: "2026-07-26T10:00:00.010Z",
    });
    expect(insert.error).not.toBeNull();

    const update = await ownerA
      .from("ai_workflow_runs")
      .update({ state: "failed", error_code: "forged" })
      .eq("id", runA);
    expect(update.error).not.toBeNull();

    const remove = await ownerA
      .from("ai_workflow_runs")
      .delete()
      .eq("id", runA);
    expect(remove.error).not.toBeNull();
  });

  it("enforces composite tenant integrity on the requesting user", async () => {
    const mismatched = await service.from("ai_workflow_runs").insert({
      clinic_id: clinicB,
      user_id: ownerAId,
      mode: "execute",
      state: "succeeded",
      plan: planSummary,
      step_count: 1,
      cost_units: 1,
      started_at: "2026-07-26T10:00:00.000Z",
      completed_at: "2026-07-26T10:00:00.010Z",
    });
    expect(mismatched.error).not.toBeNull();
  });

  it("permits the service ledger to advance state while preserving owner visibility", async () => {
    const updated = await service
      .from("ai_workflow_runs")
      .update({ error_code: null })
      .eq("id", runA)
      .eq("clinic_id", clinicA)
      .select("id")
      .single();
    expect(updated.error).toBeNull();

    const visible = await ownerA
      .from("ai_workflow_runs")
      .select("id")
      .eq("id", runA)
      .single();
    expect(visible.error).toBeNull();
    expect(visible.data?.id).toBe(runA);
  });

  it("keeps confirmation server-only, non-cross-tenant, and bound to the run owner", async () => {
    const forged = await ownerA
      .from("ai_workflow_runs")
      .update({
        mode: "execute",
        state: "running",
        confirmed_by: ownerAId,
        confirmed_at: "2026-07-26T11:00:00.000Z",
        started_at: "2026-07-26T11:00:00.000Z",
        completed_at: null,
      })
      .eq("id", previewRun);
    expect(forged.error).not.toBeNull();

    const crossTenantActor = await service
      .from("ai_workflow_runs")
      .update({
        mode: "execute",
        state: "running",
        confirmed_by: ownerBId,
        confirmed_at: "2026-07-26T11:00:00.000Z",
        started_at: "2026-07-26T11:00:00.000Z",
        completed_at: null,
      })
      .eq("id", previewRun)
      .eq("clinic_id", clinicA);
    expect(crossTenantActor.error).not.toBeNull();

    const confirmed = await service
      .from("ai_workflow_runs")
      .update({
        mode: "execute",
        state: "running",
        confirmed_by: ownerAId,
        confirmed_at: "2026-07-26T11:00:00.000Z",
        started_at: "2026-07-26T11:00:00.000Z",
        completed_at: null,
      })
      .eq("id", previewRun)
      .eq("clinic_id", clinicA)
      .eq("user_id", ownerAId)
      .is("confirmed_at", null)
      .select("id, confirmed_by")
      .single();
    expect(confirmed.error).toBeNull();
    expect(confirmed.data).toEqual({
      id: previewRun,
      confirmed_by: ownerAId,
    });
  });
});
