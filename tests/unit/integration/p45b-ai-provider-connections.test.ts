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
const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clinicCaller = createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const clinicA = randomUUID();
const clinicB = randomUUID();
const primaryA = randomUUID();
const secondaryA = randomUUID();
const primaryB = randomUUID();
const connectionOne = randomUUID();
const connectionTwo = randomUUID();
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P45bTest12345!";
const periodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
let planId = "";

function connectionArgs(connectionId: string, clinicId = clinicA, actorId = primaryA) {
  return {
    p_connection_id: connectionId,
    p_clinic_id: clinicId,
    p_actor_id: actorId,
    p_provider: "anthropic",
    p_credential_encrypted: `\\x${"ab".repeat(48)}`,
    p_encryption_key_version: 1,
    p_masked_fingerprint: "sha256:1234abcd…9876",
  };
}

function reserve(input: {
  requestId: string;
  leaseToken: string;
  mode: "byok_strict" | "hybrid";
}) {
  return service.rpc("reserve_ai_budget", {
    p_request_id: input.requestId,
    p_lease_token: input.leaseToken,
    p_clinic_id: clinicA,
    p_actor_id: primaryA,
    p_period_start: periodStart,
    p_surface: "staff_assistant",
    p_persona: "doctor",
    p_task: "staff_clinical_summary",
    p_transport: input.mode === "byok_strict" ? "anthropic_direct" : "anthropic_direct_hybrid",
    p_credential_mode: input.mode,
    p_expected_provider: "anthropic",
    p_expected_model: "anthropic/claude-sonnet-4.5",
    p_model_alias: "staff-sonnet-bootstrap-v1",
    p_fallback_model_aliases: [],
    p_policy_version: "p45b-staff-policy-v1",
    p_certification_version: "p4-bootstrap-2026-07-18",
    p_privacy_policy_version: "clinical-zdr-no-training-v1",
    p_reserved_cost_micros: 1_000,
    p_budget_limit_micros: 10_000,
    p_lease_seconds: 600,
  });
}

async function cleanup() {
  await service.from("clinic_feature_overrides").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("ai_commercial_terms").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("id", [primaryA, secondaryA, primaryB]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await service.auth.admin.deleteUser(primaryA);
  await service.auth.admin.deleteUser(secondaryA);
  await service.auth.admin.deleteUser(primaryB);
}

beforeAll(async () => {
  await cleanup();
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  planId = plan.data.id;
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P45B Clinic A ${suffix}` },
    { id: clinicB, name: `P45B Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const subscriptions = await service.from("subscriptions").insert([
    { clinic_id: clinicA, plan_id: planId, status: "trialing", trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() },
    { clinic_id: clinicB, plan_id: planId, status: "trialing", trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() },
  ]);
  if (subscriptions.error) throw subscriptions.error;

  for (const [id, label] of [
    [primaryA, "primary-a"],
    [secondaryA, "secondary-a"],
    [primaryB, "primary-b"],
  ] as const) {
    const auth = await service.auth.admin.createUser({
      id,
      email: `p45b-${suffix}-${label}@example.com`,
      password,
      email_confirm: true,
    });
    if (auth.error) throw auth.error;
  }
  const profiles = await service.from("profiles").insert([
    { id: primaryA, clinic_id: clinicA, full_name: "Primary A", role: "admin", created_at: "2026-01-01T00:00:00Z" },
    { id: secondaryA, clinic_id: clinicA, full_name: "Secondary A", role: "admin", created_at: "2026-01-02T00:00:00Z" },
    { id: primaryB, clinic_id: clinicB, full_name: "Primary B", role: "admin", created_at: "2026-01-01T00:00:00Z" },
  ]);
  if (profiles.error) throw profiles.error;
  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinicA, change_reason: "pilot", updated_by: primaryA, accepted_at: new Date().toISOString() },
    { clinic_id: clinicB, change_reason: "pilot", updated_by: primaryB, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;
  const login = await clinicCaller.auth.signInWithPassword({
    email: `p45b-${suffix}-primary-a@example.com`,
    password,
  });
  if (login.error) throw login.error;
});

afterAll(cleanup);

describe("P4.5B provider connection isolation and accounting", () => {
  it("denies authenticated reads plus non-primary and cross-clinic lifecycle calls", async () => {
    const ownRead = await clinicCaller.from("ai_provider_connections").select("id");
    const policyRead = await clinicCaller.from("ai_clinic_provider_policies").select("clinic_id");
    expect(ownRead.error).not.toBeNull();
    expect(policyRead.error).not.toBeNull();

    const nonPrimary = await service.rpc(
      "activate_ai_provider_connection",
      connectionArgs(randomUUID(), clinicA, secondaryA),
    );
    const crossClinic = await service.rpc(
      "activate_ai_provider_connection",
      connectionArgs(randomUUID(), clinicB, primaryA),
    );
    expect(nonPrimary.error?.message).toContain("AI_PROVIDER_PRIMARY_ADMIN_REQUIRED");
    expect(crossClinic.error?.message).toContain("AI_PROVIDER_PRIMARY_ADMIN_REQUIRED");
  });

  it("atomically rotates credentials, and strict BYOK spends no managed credit and no funded request unit", async () => {
    const first = await service.rpc("activate_ai_provider_connection", connectionArgs(connectionOne));
    const second = await service.rpc("activate_ai_provider_connection", connectionArgs(connectionTwo));
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const connections = await service.from("ai_provider_connections")
      .select("id, credential_encrypted, lifecycle_status")
      .eq("clinic_id", clinicA)
      .order("created_at");
    expect(connections.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionOne, credential_encrypted: null, lifecycle_status: "retired" }),
      expect.objectContaining({ id: connectionTwo, lifecycle_status: "active" }),
    ]));

    const policy = await service.rpc("set_ai_provider_policy", {
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
      p_credential_mode: "byok_strict",
      p_hybrid_disclosure_version: null,
    });
    expect(policy.error).toBeNull();
    const requestId = randomUUID();
    const reserved = await reserve({ requestId, leaseToken: randomUUID(), mode: "byok_strict" });
    expect(reserved.error).toBeNull();
    const row = reserved.data![0];
    // P12 / audit finding G3 — this expectation is INVERTED from P4.5B, on
    // purpose, and the inversion is the fix rather than a relaxation.
    //
    // `ai_messages` counts ClinicFlow-FUNDED requests: its limit is sized to the
    // funded credit pool and it is what `increment_usage` enforces. Charging a
    // BYOK turn against it meant a clinic paying Anthropic directly was still cut
    // off by a number describing money ClinicFlow was not spending. So a strict
    // BYOK reservation now claims no funded request unit.
    //
    // BYOK is not thereby unmetered. It keeps concurrency
    // (`ai_concurrent_requests`, asserted below), the platform fair-use ceiling
    // (`ai_byok_requests_month`, enforced in reserve_ai_budget_v2_internal),
    // authorization, safety gates, credential security and this ledger. See
    // `lib/ai/allowance.ts` for the invariant in full.
    expect(row.legacy_used).toBe(0);
    const strictUsage = await service.from("usage_counters")
      .select("used")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).eq("metric", "ai_messages")
      .maybeSingle();
    expect(strictUsage.data?.used ?? 0).toBe(0);
    // Recorded as not drawing on the managed pool, which is what makes the
    // zero-managed-spend reconciliation below enforceable rather than trusted.
    const reservationRow = await service.from("ai_budget_reservations")
      .select("consumes_managed_budget, resolution_reason, credential_mode")
      .eq("clinic_id", clinicA).eq("request_id", requestId).single();
    expect(reservationRow.data).toEqual({
      consumes_managed_budget: false,
      resolution_reason: "policy",
      credential_mode: "byok_strict",
    });
    // The managed pool is untouched while the reservation is still open: a BYOK
    // turn reserves no cost ceiling at all.
    const openPeriod = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).single();
    expect(openPeriod.data).toEqual({ reserved_micros: 0, spent_micros: 0 });
    const reconciliation = {
      p_reservation_id: row.reservation_id,
      p_lease_token: row.returned_lease_token,
      p_outcome: "success",
      p_attempts: [{
        attempt_id: randomUUID(), attempt_sequence: 0, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "claude-sonnet-4-5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 10, output_tokens: 2,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 10, status: "success", error_class: null,
        estimated_cost_micros: 10, final_cost_micros: 10,
      }] as Json,
      p_actual_cost_micros: 10,
      p_managed_cost_micros: 0,
      p_error_class: null,
    };
    const reconciled = await service.rpc("reconcile_ai_budget", reconciliation);
    const idempotentRetry = await service.rpc("reconcile_ai_budget", reconciliation);
    expect(reconciled.error).toBeNull();
    expect(idempotentRetry.error).toBeNull();
    const period = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros, byok_spent_micros")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).single();
    // Managed books untouched; the clinic's own provider cost is recorded
    // separately for observability and never compared against any allowance.
    expect(period.data).toEqual({
      reserved_micros: 0,
      spent_micros: 0,
      byok_spent_micros: 10,
    });
    const event = await service.from("ai_usage_events")
      .select("credential_mode, billing_disposition")
      .eq("request_id", requestId).single();
    expect(event.data).toEqual({ credential_mode: "byok_strict", billing_disposition: "byok_provider_direct" });
  });

  it("requires persisted hybrid consent and an active hybrid reservation before fallback", async () => {
    const hybridEntitlement = await service.from("clinic_feature_overrides").upsert(
      {
        clinic_id: clinicA,
        feature_key: "ai.hybrid_fallback",
        enabled: true,
        updated_by: primaryA,
      },
      { onConflict: "clinic_id,feature_key" },
    );
    if (hybridEntitlement.error) throw hybridEntitlement.error;
    const deniedPolicy = await service.rpc("set_ai_provider_policy", {
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
      p_credential_mode: "hybrid",
      p_hybrid_disclosure_version: null,
    });
    expect(deniedPolicy.error?.message).toContain("AI_PROVIDER_HYBRID_ACCEPTANCE_REQUIRED");
    const policy = await service.rpc("set_ai_provider_policy", {
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
      p_credential_mode: "hybrid",
      p_hybrid_disclosure_version: "p45b-hybrid-disclosure-v1",
    });
    expect(policy.error).toBeNull();
    const missingReservation = await service.rpc("log_ai_provider_fallback", {
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
      p_request_id: randomUUID(),
      p_provider: "anthropic",
      p_error_class: "provider_unavailable",
    });
    expect(missingReservation.error?.message).toContain("AI_PROVIDER_HYBRID_POLICY_REQUIRED");

    const requestId = randomUUID();
    const reserved = await reserve({ requestId, leaseToken: randomUUID(), mode: "hybrid" });
    expect(reserved.error).toBeNull();
    const fallback = await service.rpc("log_ai_provider_fallback", {
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
      p_request_id: requestId,
      p_provider: "anthropic",
      p_error_class: "provider_unavailable",
    });
    expect(fallback.error).toBeNull();
    const audit = await service.from("audit_logs")
      .select("action, new_data")
      .eq("clinic_id", clinicA)
      .eq("action", "AI_PROVIDER_HYBRID_FALLBACK")
      .single();
    expect(audit.data?.action).toBe("AI_PROVIDER_HYBRID_FALLBACK");
    expect(JSON.stringify(audit.data?.new_data)).not.toContain("credential_encrypted");
  });

  it("reconciles a hybrid fallback so spent equals the DB-derived managed cost (L5/L2)", async () => {
    // Policy is already hybrid with a healthy connection from the previous test.
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const reserved = await reserve({ requestId, leaseToken, mode: "hybrid" });
    expect(reserved.error).toBeNull();
    const row = reserved.data![0];

    const before = await service.from("ai_budget_periods")
      .select("spent_micros")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).single();
    const spentBefore = before.data!.spent_micros;

    // A realistic mixed hybrid turn: one pre-fallback direct step succeeds and
    // is billed to the tenant (byok_provider_direct), the next direct step fails
    // and triggers the fallback marker (nonbillable_failed), and the post-fallback
    // managed step succeeds (managed_included).
    const directAttemptId = randomUUID();
    const fallbackMarkerId = randomUUID();
    const managedAttemptId = randomUUID();
    const attempts = [
      {
        attempt_id: directAttemptId, attempt_sequence: 0, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "claude-sonnet-4-5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 20, output_tokens: 4,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 12, status: "success", error_class: null,
        estimated_cost_micros: 40, final_cost_micros: 40,
      },
      {
        attempt_id: fallbackMarkerId, attempt_sequence: 1, fallback_parent_attempt_id: null,
        provider: "anthropic", model: "claude-sonnet-4-5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 0, output_tokens: 0,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 5, status: "failed", error_class: "provider_unavailable",
        estimated_cost_micros: 0, final_cost_micros: 0,
      },
      {
        attempt_id: managedAttemptId, attempt_sequence: 2, fallback_parent_attempt_id: fallbackMarkerId,
        provider: "anthropic", model: "claude-sonnet-4-5",
        model_alias: "staff-sonnet-bootstrap-v1", input_tokens: 30, output_tokens: 6,
        cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        latency_ms: 18, status: "success", error_class: null,
        estimated_cost_micros: 100, final_cost_micros: 100,
      },
    ] as Json;
    const reconciliation = {
      p_reservation_id: row.reservation_id,
      p_lease_token: row.returned_lease_token,
      p_outcome: "success",
      p_attempts: attempts,
      p_actual_cost_micros: 140,
      p_managed_cost_micros: 100,
      p_error_class: null,
    };

    // Fail-closed: an application-supplied managed split that disagrees with the
    // DB-derived managed_included sum rolls the whole reconciliation back.
    const tampered = await service.rpc("reconcile_ai_budget", { ...reconciliation, p_managed_cost_micros: 60 });
    expect(tampered.error?.message).toContain("AI_BUDGET_INVALID_MANAGED_COST");
    const stillReserved = await service.from("ai_budget_reservations")
      .select("status").eq("id", row.reservation_id).single();
    expect(stillReserved.data?.status).toBe("reserved");

    const reconciled = await service.rpc("reconcile_ai_budget", reconciliation);
    expect(reconciled.error).toBeNull();

    const after = await service.from("ai_budget_periods")
      .select("spent_micros")
      .eq("clinic_id", clinicA).eq("period_start", periodStart).single();
    // Only the managed portion (100) reaches ClinicFlow's included-credit pool;
    // the 40 micros of direct BYOK spend is removed in the same transaction.
    expect(after.data!.spent_micros - spentBefore).toBe(100);

    const events = await service.from("ai_usage_events")
      .select("attempt_sequence, billing_disposition, final_cost_micros")
      .eq("request_id", requestId).order("attempt_sequence");
    expect(events.data).toEqual([
      { attempt_sequence: 0, billing_disposition: "byok_provider_direct", final_cost_micros: 40 },
      { attempt_sequence: 1, billing_disposition: "nonbillable_failed", final_cost_micros: 0 },
      { attempt_sequence: 2, billing_disposition: "managed_included", final_cost_micros: 100 },
    ]);
  });

  it("revocation destroys ciphertext and returns routing to managed", async () => {
    const revoked = await service.rpc("revoke_ai_provider_connection", {
      p_connection_id: connectionTwo,
      p_clinic_id: clinicA,
      p_actor_id: primaryA,
    });
    expect(revoked.error).toBeNull();
    const connection = await service.from("ai_provider_connections")
      .select("credential_encrypted, lifecycle_status, revoked_at")
      .eq("id", connectionTwo).single();
    expect(connection.data).toMatchObject({ credential_encrypted: null, lifecycle_status: "revoked" });
    expect(connection.data?.revoked_at).not.toBeNull();
    const policy = await service.from("ai_clinic_provider_policies")
      .select("credential_mode, provider, hybrid_disclosure_version")
      .eq("clinic_id", clinicA).single();
    expect(policy.data).toEqual({
      credential_mode: "managed",
      provider: null,
      hybrid_disclosure_version: null,
    });
  });
});
