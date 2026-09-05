import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Json } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clinicA = randomUUID();
const clinicB = randomUUID();
const clinicC = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();
const actorC = randomUUID();
const periodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
const requestIds = [randomUUID(), randomUUID(), randomUUID()];
const leaseTokens = [randomUUID(), randomUUID(), randomUUID()];
const password = "P45aTest12345!";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let clinicCaller: ReturnType<typeof createClient<Database>>;
let aiPlanId = "";
let aiMessageLimit = 0;
// Captured by the reservation race below. Null until then, never "": an empty
// string is not a uuid, so a fixture that never ran would otherwise reach the
// RPCs and fail every downstream case with `invalid input syntax for type uuid`
// instead of naming the step that did not happen.
let winningReservationId: string | null = null;
let winningLeaseToken: string | null = null;
let winningRequestId: string | null = null;

function captured(value: string | null, label: string): string {
  if (!value) {
    throw new Error(
      `${label} was never captured: the reservation race did not produce a winner.`,
    );
  }
  return value;
}

function reserve(input: {
  requestId: string;
  leaseToken: string;
  actorId?: string;
  clinicId?: string;
  budgetLimit?: number;
}) {
  return service.rpc("reserve_ai_budget", {
    p_request_id: input.requestId,
    p_lease_token: input.leaseToken,
    p_clinic_id: input.clinicId ?? clinicA,
    p_actor_id: input.actorId ?? actorA,
    p_period_start: periodStart,
    p_surface: "staff_assistant",
    p_persona: "doctor",
    p_task: "staff_clinical_summary",
    p_transport: "vercel_ai_gateway",
    p_credential_mode: "managed",
    p_expected_provider: "anthropic",
    p_expected_model: "anthropic/claude-sonnet-4.5",
    p_model_alias: "staff-sonnet-bootstrap-v1",
    p_fallback_model_aliases: [],
    p_policy_version: "p45a-staff-policy-v1",
    p_certification_version: "p4-bootstrap-2026-07-18",
    p_privacy_policy_version: "clinical-zdr-no-training-v1",
    p_reserved_cost_micros: 1_000,
    p_budget_limit_micros: input.budgetLimit ?? 1_000,
    p_lease_seconds: 600,
  });
}

async function cleanup() {
  await service.from("ai_commercial_terms").delete().in("clinic_id", [clinicA, clinicB, clinicC]);
  await service.from("profiles").delete().in("id", [actorA, actorB, actorC]);
  await service.from("usage_counters").delete().in("clinic_id", [clinicA, clinicB, clinicC]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB, clinicC]);
  // Tenant deletion is the one permitted deletion path for immutable events.
  await service.from("clinics").delete().in("id", [clinicA, clinicB, clinicC]);
  await service.auth.admin.deleteUser(actorA);
  await service.auth.admin.deleteUser(actorB);
  await service.auth.admin.deleteUser(actorC);
}

beforeAll(async () => {
  await cleanup();
  const plan = await service.from("plans").select("id, limits").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  aiPlanId = plan.data.id;
  const planLimits = plan.data.limits as Record<string, unknown>;
  aiMessageLimit = Number(planLimits.ai_messages_month);
  if (!Number.isInteger(aiMessageLimit) || aiMessageLimit < 1) {
    throw new Error("pro_ai must expose a positive ai_messages_month limit");
  }
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P45A Clinic A ${suffix}` },
    { id: clinicB, name: `P45A Clinic B ${suffix}` },
    { id: clinicC, name: `P45A Clinic C ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const subscriptions = await service.from("subscriptions").insert([
    {
      clinic_id: clinicA,
      plan_id: aiPlanId,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
    {
      clinic_id: clinicB,
      plan_id: aiPlanId,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
    {
      clinic_id: clinicC,
      plan_id: aiPlanId,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  ]);
  if (subscriptions.error) throw subscriptions.error;
  for (const [id, clinicId, label] of [
    [actorA, clinicA, "a"],
    [actorB, clinicB, "b"],
    [actorC, clinicC, "c"],
  ] as const) {
    const auth = await service.auth.admin.createUser({
      id,
      email: `p45a-${suffix}-${label}@example.com`,
      password,
      email_confirm: true,
    });
    if (auth.error) throw auth.error;
    const profile = await service.from("profiles").insert({
      id,
      clinic_id: clinicId,
      full_name: `P45A User ${label}`,
      role: "doctor",
    });
    if (profile.error) throw profile.error;
  }
  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinicA, change_reason: "pilot", updated_by: actorA, accepted_at: new Date().toISOString() },
    { clinic_id: clinicB, change_reason: "pilot", updated_by: actorB, accepted_at: new Date().toISOString() },
    { clinic_id: clinicC, change_reason: "pilot", updated_by: actorC, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;
  clinicCaller = createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const login = await clinicCaller.auth.signInWithPassword({
    email: `p45a-${suffix}-a@example.com`,
    password,
  });
  if (login.error) throw login.error;
});

afterAll(cleanup);

describe("P4.5A atomic AI budget and immutable usage ledger", () => {
  it("allows exactly one concurrent request to claim the clinic cost pool", async () => {
    const commercialTerms = await service.from("ai_commercial_terms").upsert({
      clinic_id: clinicC,
      included_budget_override_micros: aiMessageLimit * 1_000,
      addon_budget_micros: 0,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      change_reason: "support_adjustment",
      updated_by: actorC,
      accepted_at: new Date().toISOString(),
    });
    if (commercialTerms.error) throw commercialTerms.error;
    const initialSpentMicros = (aiMessageLimit - 1) * 1_000;
    const seeded = await service.from("ai_budget_periods").insert({
      clinic_id: clinicC,
      period_start: periodStart,
      budget_limit_micros: aiMessageLimit * 1_000,
      reserved_micros: 0,
      spent_micros: initialSpentMicros,
    });
    if (seeded.error) throw seeded.error;
    const results = await Promise.all([
      reserve({ requestId: requestIds[0], leaseToken: leaseTokens[0], clinicId: clinicC, actorId: actorC }),
      reserve({ requestId: requestIds[1], leaseToken: leaseTokens[1], clinicId: clinicC, actorId: actorC }),
    ]);
    const winners = results.filter((result) => result.error === null);
    const losers = results.filter((result) => result.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error?.message).toContain("AI_BUDGET_EXCEEDED");
    winningRequestId = requestIds[results.findIndex((result) => result.error === null)];
    winningReservationId = winners[0].data![0].reservation_id;
    winningLeaseToken = winners[0].data![0].returned_lease_token;
    const period = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros, budget_limit_micros")
      .eq("clinic_id", clinicC).eq("period_start", periodStart).single();
    expect(period.data).toEqual({
      reserved_micros: 1_000,
      spent_micros: initialSpentMicros,
      budget_limit_micros: aiMessageLimit * 1_000,
    });
    const usage = await service.from("usage_counters")
      .select("used").eq("clinic_id", clinicC)
      .eq("period_start", periodStart).eq("metric", "ai_messages").single();
    expect(usage.data?.used).toBe(1);
  });

  it("reconciles an over-reservation provider report without dropping spend or content", async () => {
    const attemptId = randomUUID();
    const attempts = [{
      attempt_id: attemptId,
      attempt_sequence: 0,
      fallback_parent_attempt_id: null,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.5",
      model_alias: "staff-sonnet-bootstrap-v1",
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      latency_ms: 25,
      status: "success",
      error_class: null,
      estimated_cost_micros: 1_001,
      final_cost_micros: 1_001,
    }];
    const result = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: captured(winningReservationId, "winningReservationId"),
      p_lease_token: captured(winningLeaseToken, "winningLeaseToken"),
      p_outcome: "success",
      p_attempts: attempts as Json,
      p_actual_cost_micros: 1_001,
      p_managed_cost_micros: 1_001,
      p_error_class: null,
    });
    expect(result).toMatchObject({ data: true, error: null });
    const period = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros")
      .eq("clinic_id", clinicC).eq("period_start", periodStart).single();
    expect(period.data).toEqual({
      reserved_micros: 0,
      spent_micros: (aiMessageLimit - 1) * 1_000 + 1_001,
    });
    const reservation = await service.from("ai_budget_reservations")
      .select("actual_cost_micros, reserved_cost_micros, status")
      .eq("id", captured(winningReservationId, "winningReservationId")).single();
    expect(reservation.data).toEqual({
      actual_cost_micros: 1_000,
      reserved_cost_micros: 1_000,
      status: "reconciled",
    });
    const event = await service.from("ai_usage_events").select("*").eq("attempt_id", attemptId).single();
    expect(event.error).toBeNull();
    // P4.5C review fix (P45-M2): the managed bucket is re-derived at reconcile
    // time from the actual finalized cost. This provider over-run books 1,001
    // micros when only 1,000 of the included allowance remained, so cumulative
    // spend crosses the included ceiling and the attempt is correctly recorded
    // as managed_overage rather than the reserve-time estimate.
    expect(event.data).toMatchObject({
      request_id: expect.any(String),
      clinic_id: clinicC,
      actor_id: actorC,
      input_tokens: 100,
      output_tokens: 10,
      final_cost_micros: 1_001,
      billing_disposition: "managed_overage",
    });
    expect(Object.keys(event.data!)).not.toEqual(expect.arrayContaining([
      "prompt", "completion", "message_body", "tool_payload", "patient_id", "credential",
    ]));
  });

  it("keeps a finalized request id idempotent and requires a new message id", async () => {
    const duplicate = await reserve({
      requestId: captured(winningRequestId, "winningRequestId"),
      leaseToken: randomUUID(),
      clinicId: clinicC,
      actorId: actorC,
      budgetLimit: 2_000,
    });
    expect(duplicate.error).toBeNull();
    expect(duplicate.data?.[0]).toMatchObject({
      acquired: false,
      reservation_id: captured(winningReservationId, "winningReservationId"),
      reservation_status: "reconciled",
    });
    const usage = await service.from("usage_counters")
      .select("used").eq("clinic_id", clinicC)
      .eq("period_start", periodStart).eq("metric", "ai_messages").single();
    expect(usage.data?.used).toBe(1);
  });

  it("rejects update and direct deletion even for service role", async () => {
    const update = await service.from("ai_usage_events")
      .update({ final_cost_micros: 0 }).eq("reservation_id", captured(winningReservationId, "winningReservationId"));
    expect(update.error?.message).toContain("AI_USAGE_EVENTS_IMMUTABLE");
    const deletion = await service.from("ai_usage_events")
      .delete().eq("reservation_id", captured(winningReservationId, "winningReservationId"));
    expect(deletion.error?.message).toContain("AI_USAGE_EVENTS_IMMUTABLE");
  });

  it("releases the legacy unit on failed reconciliation but retains actual internal cost", async () => {
    const reserved = await reserve({
      requestId: requestIds[2],
      leaseToken: leaseTokens[2],
      budgetLimit: 2_000,
    });
    expect(reserved.error).toBeNull();
    const row = reserved.data![0];
    const result = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: row.reservation_id,
      p_lease_token: row.returned_lease_token,
      p_outcome: "failed",
      p_attempts: [{
        attempt_id: randomUUID(), attempt_sequence: 0, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "anthropic/claude-sonnet-4.5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 25, output_tokens: 0,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 20, status: "failed", error_class: "provider_timeout",
        estimated_cost_micros: 5, final_cost_micros: 5,
      }] as Json,
      p_actual_cost_micros: 5,
      p_managed_cost_micros: 5,
      p_error_class: "provider_timeout",
    });
    expect(result.error).toBeNull();
    const usage = await service.from("usage_counters")
      .select("used").eq("clinic_id", clinicA)
      .eq("period_start", periodStart).eq("metric", "ai_messages").single();
    expect(usage.data?.used).toBe(0);
    const period = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).single();
    expect(period.data).toEqual({ reserved_micros: 0, spent_micros: 5 });
  });

  it("derives the pool ceiling from the database entitlement snapshot", async () => {
    const reserved = await reserve({
      requestId: randomUUID(),
      leaseToken: randomUUID(),
      clinicId: clinicB,
      actorId: actorB,
      budgetLimit: 1,
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data?.[0].budget_limit_micros).toBeGreaterThanOrEqual(1_000);
    const row = reserved.data![0];
    const released = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: row.reservation_id,
      p_lease_token: row.returned_lease_token,
      p_outcome: "failed",
      p_attempts: [{
        attempt_id: randomUUID(), attempt_sequence: 0, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "anthropic/claude-sonnet-4.5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 0, output_tokens: 0,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 0, status: "failed", error_class: "request_failed",
        estimated_cost_micros: 0, final_cost_micros: 0,
      }] as Json,
      p_actual_cost_micros: 0,
      p_managed_cost_micros: 0,
      p_error_class: "request_failed",
    });
    expect(released.error).toBeNull();
  });

  it("denies tenant reads, cross-clinic reads, and both privileged RPCs", async () => {
    const own = await clinicCaller.from("ai_usage_events").select("id").eq("clinic_id", clinicA);
    expect(own.error).not.toBeNull();
    const crossClinic = await clinicCaller.from("ai_budget_periods").select("clinic_id").eq("clinic_id", clinicB);
    expect(crossClinic.error).not.toBeNull();
    const reserveDenied = await clinicCaller.rpc("reserve_ai_budget", {
      p_request_id: randomUUID(), p_lease_token: randomUUID(), p_clinic_id: clinicA,
      p_actor_id: actorA, p_period_start: periodStart, p_surface: "staff_assistant",
      p_persona: "doctor", p_task: "staff_clinical_summary", p_transport: "vercel_ai_gateway",
      p_credential_mode: "managed",
      p_expected_provider: "anthropic", p_expected_model: "anthropic/claude-sonnet-4.5",
      p_model_alias: "staff-sonnet-bootstrap-v1", p_fallback_model_aliases: [],
      p_policy_version: "p45a-staff-policy-v1", p_certification_version: "p4-bootstrap-2026-07-18",
      p_privacy_policy_version: "clinical-zdr-no-training-v1", p_reserved_cost_micros: 1_000,
      p_budget_limit_micros: 2_000, p_lease_seconds: 600,
    });
    expect(reserveDenied.error).not.toBeNull();
    const reconcileDenied = await clinicCaller.rpc("reconcile_ai_budget", {
      p_reservation_id: captured(winningReservationId, "winningReservationId"),
      p_lease_token: captured(winningLeaseToken, "winningLeaseToken"),
      p_outcome: "success",
      p_attempts: [] as Json,
      p_actual_cost_micros: 0,
      p_managed_cost_micros: 0,
      p_error_class: null,
    });
    expect(reconcileDenied.error).not.toBeNull();
  });

  it("allows whole-tenant deletion to cascade through immutable events", async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const reserved = await reserve({
      requestId,
      leaseToken,
      clinicId: clinicB,
      actorId: actorB,
    });
    expect(reserved.error).toBeNull();
    const row = reserved.data![0];
    const reconciled = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: row.reservation_id,
      p_lease_token: row.returned_lease_token,
      p_outcome: "success",
      p_attempts: [{
        attempt_id: randomUUID(), attempt_sequence: 0, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "anthropic/claude-sonnet-4.5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 1, output_tokens: 1,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 1, status: "success", error_class: null,
        estimated_cost_micros: 1, final_cost_micros: 1,
      }] as Json,
      p_actual_cost_micros: 1,
      p_managed_cost_micros: 1,
      p_error_class: null,
    });
    expect(reconciled.error).toBeNull();
    await service.from("profiles").delete().eq("id", actorB);
    await service.from("subscriptions").delete().eq("clinic_id", clinicB);
    const deleted = await service.from("clinics").delete().eq("id", clinicB);
    expect(deleted.error).toBeNull();
    const events = await service.from("ai_usage_events").select("id").eq("clinic_id", clinicB);
    expect(events).toMatchObject({ data: [], error: null });
  });
});
