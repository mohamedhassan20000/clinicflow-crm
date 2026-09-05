/**
 * P12 — the allowance split and the ordered handover, exercised against a real
 * database.
 *
 * The unit suites prove the application asks for the right thing. This proves
 * the database would refuse the wrong thing even if the application asked.
 */
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

const managedClinic = randomUUID();
const byokClinic = randomUUID();
const managedAdmin = randomUUID();
const byokAdmin = randomUUID();
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const now = new Date();
const periodStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
const RESERVED = 1_000_000;

function connectionArgs(clinicId: string, actorId: string) {
  return {
    p_connection_id: randomUUID(),
    p_clinic_id: clinicId,
    p_actor_id: actorId,
    p_provider: "anthropic",
    p_credential_encrypted: `\\x${"cd".repeat(48)}`,
    p_encryption_key_version: 1,
    p_masked_fingerprint: "sha256:abcd1234…5678",
  };
}

function reserve(input: {
  clinicId: string;
  actorId: string;
  mode: "managed" | "byok_strict" | "hybrid";
  requestId?: string;
  reservedCostMicros?: number;
}) {
  return service.rpc("reserve_ai_budget", {
    p_request_id: input.requestId ?? randomUUID(),
    p_lease_token: randomUUID(),
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_period_start: periodStart,
    p_surface: "staff_assistant",
    p_persona: "doctor",
    p_task: "staff_clinical_summary",
    p_transport: input.mode === "hybrid" ? "anthropic_direct_hybrid" : "anthropic_direct",
    p_credential_mode: input.mode,
    p_expected_provider: "anthropic",
    p_expected_model: "anthropic/claude-sonnet-4.5",
    p_model_alias: "staff-sonnet-bootstrap-v1",
    p_fallback_model_aliases: [],
    p_policy_version: "p12-staff-policy-v1",
    p_certification_version: "p4-bootstrap-2026-07-18",
    p_privacy_policy_version: "clinical-direct-anthropic-no-training-v2",
    p_reserved_cost_micros: input.reservedCostMicros ?? RESERVED,
    p_budget_limit_micros: 1_620_000_000,
    p_lease_seconds: 600,
  });
}

function attempts(costMicros: number): Json {
  return [
    {
      attempt_id: randomUUID(),
      attempt_sequence: 0,
      fallback_parent_attempt_id: null,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      model_alias: "staff-sonnet-bootstrap-v1",
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      latency_ms: 12,
      status: "success",
      error_class: null,
      estimated_cost_micros: costMicros,
      final_cost_micros: costMicros,
    },
  ] as unknown as Json;
}

async function cleanup() {
  const clinics = [managedClinic, byokClinic];
  await service.from("ai_usage_threshold_notifications").delete().in("clinic_id", clinics);
  await service.from("ai_commercial_terms").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("id", [managedAdmin, byokAdmin]);
  await service.from("subscriptions").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);
  await service.auth.admin.deleteUser(managedAdmin);
  await service.auth.admin.deleteUser(byokAdmin);
}

beforeAll(async () => {
  await cleanup();
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  const clinics = await service.from("clinics").insert([
    { id: managedClinic, name: `P12 Managed ${suffix}` },
    { id: byokClinic, name: `P12 BYOK ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const trialEndsAt = new Date(Date.now() + 86_400_000).toISOString();
  const subscriptions = await service.from("subscriptions").insert([
    { clinic_id: managedClinic, plan_id: plan.data.id, status: "trialing", trial_ends_at: trialEndsAt },
    { clinic_id: byokClinic, plan_id: plan.data.id, status: "trialing", trial_ends_at: trialEndsAt },
  ]);
  if (subscriptions.error) throw subscriptions.error;
  for (const [id, label] of [
    [managedAdmin, "managed"],
    [byokAdmin, "byok"],
  ] as const) {
    const auth = await service.auth.admin.createUser({
      id,
      email: `p12-${suffix}-${label}@example.com`,
      password: "P12Test12345!",
      email_confirm: true,
    });
    if (auth.error) throw auth.error;
  }
  const profiles = await service.from("profiles").insert([
    { id: managedAdmin, clinic_id: managedClinic, full_name: "Managed Admin", role: "admin", created_at: "2026-01-01T00:00:00Z" },
    { id: byokAdmin, clinic_id: byokClinic, full_name: "BYOK Admin", role: "admin", created_at: "2026-01-01T00:00:00Z" },
  ]);
  if (profiles.error) throw profiles.error;
  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: managedClinic, change_reason: "pilot", updated_by: managedAdmin, accepted_at: new Date().toISOString() },
    { clinic_id: byokClinic, change_reason: "pilot", updated_by: byokAdmin, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;
  // The BYOK clinic connects a healthy credential and selects strict BYOK.
  const connection = await service.rpc(
    "activate_ai_provider_connection",
    connectionArgs(byokClinic, byokAdmin),
  );
  if (connection.error) throw connection.error;
  const policy = await service.rpc("set_ai_provider_policy", {
    p_clinic_id: byokClinic,
    p_actor_id: byokAdmin,
    p_credential_mode: "byok_strict",
    p_hybrid_disclosure_version: null,
  });
  if (policy.error) throw policy.error;
});

afterAll(cleanup);

describe("G2/G3 — a BYOK clinic is not bounded by ClinicFlow's money", () => {
  it("reserves with no managed allowance override at all, and books nothing to the managed pool", async () => {
    // Zero the funded allowance for this clinic entirely: the state that used to
    // make BYOK unusable.
    const zeroed = await service.from("ai_commercial_terms")
      .update({ included_budget_override_micros: 1 })
      .eq("clinic_id", byokClinic);
    expect(zeroed.error).toBeNull();

    const requestId = randomUUID();
    const reserved = await reserve({
      clinicId: byokClinic,
      actorId: byokAdmin,
      mode: "byok_strict",
      requestId,
      // Far beyond any funded allowance this clinic has.
      reservedCostMicros: 5_000_000_000,
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data?.[0]?.acquired).toBe(true);

    const period = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros, byok_spent_micros")
      .eq("clinic_id", byokClinic).eq("period_start", periodStart).single();
    expect(period.data).toEqual({ reserved_micros: 0, spent_micros: 0, byok_spent_micros: 0 });

    const reconciled = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: reserved.data![0].reservation_id!,
      p_lease_token: reserved.data![0].returned_lease_token!,
      p_outcome: "success",
      p_attempts: attempts(4_242),
      p_actual_cost_micros: 4_242,
      p_managed_cost_micros: 0,
      p_error_class: null,
    });
    expect(reconciled.error).toBeNull();

    const after = await service.from("ai_budget_periods")
      .select("reserved_micros, spent_micros, byok_spent_micros")
      .eq("clinic_id", byokClinic).eq("period_start", periodStart).single();
    expect(after.data).toEqual({
      reserved_micros: 0,
      spent_micros: 0,
      byok_spent_micros: 4_242,
    });
  });

  it("refuses to book managed spend against a BYOK reservation", async () => {
    const reserved = await reserve({
      clinicId: byokClinic,
      actorId: byokAdmin,
      mode: "byok_strict",
    });
    expect(reserved.error).toBeNull();
    const attempted = await service.rpc("reconcile_ai_budget", {
      p_reservation_id: reserved.data![0].reservation_id!,
      p_lease_token: reserved.data![0].returned_lease_token!,
      p_outcome: "success",
      p_attempts: attempts(500),
      p_actual_cost_micros: 500,
      // The application would have to be broken to send this. The database is
      // the thing that makes it impossible.
      p_managed_cost_micros: 500,
      p_error_class: null,
    });
    expect(attempted.error?.message).toContain(
      "AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN",
    );
  });
});

describe("G1 — the automatic managed→BYOK handover", () => {
  it("refuses a BYOK credential for a managed clinic with no connection", async () => {
    const attempted = await reserve({
      clinicId: managedClinic,
      actorId: managedAdmin,
      mode: "byok_strict",
    });
    expect(attempted.error?.message).toContain("AI_PROVIDER_CONNECTION_NOT_HEALTHY");
  });

  it("admits the handover once the managed clinic has a healthy key, and records why", async () => {
    const connection = await service.rpc(
      "activate_ai_provider_connection",
      connectionArgs(managedClinic, managedAdmin),
    );
    expect(connection.error).toBeNull();

    const requestId = randomUUID();
    const reserved = await reserve({
      clinicId: managedClinic,
      actorId: managedAdmin,
      mode: "byok_strict",
      requestId,
    });
    expect(reserved.error).toBeNull();
    const row = await service.from("ai_budget_reservations")
      .select("credential_mode, resolution_reason, consumes_managed_budget")
      .eq("clinic_id", managedClinic).eq("request_id", requestId).single();
    // The clinic's configured policy is still `managed`; the turn ran on its own
    // key, and the ledger says so.
    expect(row.data).toEqual({
      credential_mode: "byok_strict",
      resolution_reason: "auto_byok_fallback",
      consumes_managed_budget: false,
    });
  });

  it("does not admit it when the clinic switched the handover off", async () => {
    const disabled = await service.rpc("set_ai_auto_byok_fallback", {
      p_clinic_id: managedClinic,
      p_actor_id: managedAdmin,
      p_enabled: false,
    });
    expect(disabled.error).toBeNull();
    const attempted = await reserve({
      clinicId: managedClinic,
      actorId: managedAdmin,
      mode: "byok_strict",
    });
    expect(attempted.error?.message).toContain("AI_PROVIDER_POLICY_MISMATCH");
    const restored = await service.rpc("set_ai_auto_byok_fallback", {
      p_clinic_id: managedClinic,
      p_actor_id: managedAdmin,
      p_enabled: true,
    });
    expect(restored.error).toBeNull();
  });

  it("never admits the reverse — a managed credential under a BYOK policy", async () => {
    const attempted = await reserve({
      clinicId: byokClinic,
      actorId: byokAdmin,
      mode: "managed",
    });
    expect(attempted.error?.message).toContain("AI_PROVIDER_POLICY_MISMATCH");
  });

  it("keeps the managed clinic's own managed turns on the managed books", async () => {
    const requestId = randomUUID();
    const reserved = await reserve({
      clinicId: managedClinic,
      actorId: managedAdmin,
      mode: "managed",
      requestId,
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data?.[0]?.legacy_used).toBeGreaterThanOrEqual(1);
    const row = await service.from("ai_budget_reservations")
      .select("consumes_managed_budget, resolution_reason")
      .eq("clinic_id", managedClinic).eq("request_id", requestId).single();
    expect(row.data).toEqual({ consumes_managed_budget: true, resolution_reason: "policy" });
    const period = await service.from("ai_budget_periods")
      .select("reserved_micros")
      .eq("clinic_id", managedClinic).eq("period_start", periodStart).single();
    expect(period.data?.reserved_micros).toBeGreaterThanOrEqual(RESERVED);
  });
});

describe("threshold notice claims", () => {
  it("is granted exactly once per clinic, period, and threshold", async () => {
    const first = await service.rpc("claim_ai_usage_threshold_notice", {
      p_clinic_id: managedClinic,
      p_period_start: periodStart,
      p_threshold: 75,
      p_used_percent: 76,
    });
    const second = await service.rpc("claim_ai_usage_threshold_notice", {
      p_clinic_id: managedClinic,
      p_period_start: periodStart,
      p_threshold: 75,
      p_used_percent: 80,
    });
    const other = await service.rpc("claim_ai_usage_threshold_notice", {
      p_clinic_id: managedClinic,
      p_period_start: periodStart,
      p_threshold: 90,
      p_used_percent: 91,
    });
    expect(first.data).toBe(true);
    expect(second.data).toBe(false);
    expect(other.data).toBe(true);
  });

  it("rejects a threshold outside the declared bands", async () => {
    const invalid = await service.rpc("claim_ai_usage_threshold_notice", {
      p_clinic_id: managedClinic,
      p_period_start: periodStart,
      p_threshold: 50,
      p_used_percent: 50,
    });
    expect(invalid.error?.message).toContain("AI_USAGE_INVALID_THRESHOLD");
  });
});

describe("owner allowance console", () => {
  it("reports plan default, override, usage, remaining, reset and BYOK state", async () => {
    const report = await service.rpc("operator_ai_allowance_report", {
      p_period_start: periodStart,
      p_clinic_id: managedClinic,
    });
    expect(report.error).toBeNull();
    const row = report.data?.[0];
    expect(row).toBeDefined();
    expect(row!.clinic_id).toBe(managedClinic);
    expect(row!.plan_slug).toBe("pro_ai");
    expect(row!.plan_included_micros).toBeGreaterThan(0);
    expect(row!.effective_included_micros).toBe(row!.plan_included_micros);
    expect(row!.override_included_micros).toBeNull();
    expect(row!.byok_configured).toBe(true);
    expect(row!.credential_mode).toBe("managed");
    expect(row!.period_start).toBe(periodStart);
    expect(row!.period_reset_at).not.toBe(periodStart);
    expect(row!.used_percent).toBeGreaterThanOrEqual(0);
    expect(row!.remaining_micros).toBeLessThanOrEqual(row!.total_allowance_micros);
    expect(["healthy", "warning", "critical", "exhausted"]).toContain(row!.status);
  });

  it("prefers a per-clinic override over the plan default", async () => {
    const overridden = await service.from("ai_commercial_terms")
      .update({ included_budget_override_micros: 12_345_678 })
      .eq("clinic_id", managedClinic);
    expect(overridden.error).toBeNull();
    const report = await service.rpc("operator_ai_allowance_report", {
      p_period_start: periodStart,
      p_clinic_id: managedClinic,
    });
    const row = report.data?.[0];
    expect(row!.override_included_micros).toBe(12_345_678);
    expect(row!.effective_included_micros).toBe(12_345_678);
  });

  it("shows a BYOK clinic as BYOK rather than as an exhausted managed clinic", async () => {
    const report = await service.rpc("operator_ai_allowance_report", {
      p_period_start: periodStart,
      p_clinic_id: byokClinic,
    });
    const row = report.data?.[0];
    expect(row!.credential_mode).toBe("byok_strict");
    expect(row!.status).toBe("byok");
    expect(row!.byok_spent_micros).toBeGreaterThan(0);
  });
});
