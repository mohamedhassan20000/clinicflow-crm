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
const tenant = createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P45cTest12345!";
const periodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
const clinicIds = {
  basic: randomUUID(),
  pro: randomUUID(),
  commercial: randomUUID(),
  hardCap: randomUUID(),
  concurrency: randomUUID(),
  correction: randomUUID(),
};
const actorIds = {
  basic: randomUUID(),
  pro: randomUUID(),
  commercial: randomUUID(),
  hardCap: randomUUID(),
  concurrency: randomUUID(),
  correction: randomUUID(),
};

type ClinicKey = keyof typeof clinicIds;

function reserve(clinicKey: ClinicKey, reservedCostMicros = 1_000) {
  return service.rpc("reserve_ai_budget", {
    p_request_id: randomUUID(),
    p_lease_token: randomUUID(),
    p_clinic_id: clinicIds[clinicKey],
    p_actor_id: actorIds[clinicKey],
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
    p_policy_version: "p45c-staff-policy-v1",
    p_certification_version: "p4-bootstrap-2026-07-18",
    p_privacy_policy_version: "clinical-zdr-no-training-v1",
    p_reserved_cost_micros: reservedCostMicros,
    p_budget_limit_micros: 1,
    p_lease_seconds: 600,
  });
}

async function reconcile(
  reservation: { reservation_id: string; returned_lease_token: string },
  finalCostMicros: number,
) {
  return service.rpc("reconcile_ai_budget", {
    p_reservation_id: reservation.reservation_id,
    p_lease_token: reservation.returned_lease_token,
    p_outcome: "success",
    p_attempts: [
      {
        attempt_id: randomUUID(),
        attempt_sequence: 0,
        fallback_parent_attempt_id: null,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4.5",
        model_alias: "staff-sonnet-bootstrap-v1",
        input_tokens: 10,
        output_tokens: 2,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        latency_ms: 10,
        status: "success",
        error_class: null,
        estimated_cost_micros: finalCostMicros,
        final_cost_micros: finalCostMicros,
      },
    ] as Json,
    p_actual_cost_micros: finalCostMicros,
    p_managed_cost_micros: finalCostMicros,
    p_error_class: null,
  });
}

async function cleanup() {
  const clinics = Object.values(clinicIds);
  const actors = Object.values(actorIds);
  await service.from("ai_commercial_terms").delete().in("clinic_id", clinics);
  await service.from("clinic_feature_overrides").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("id", actors);
  await service.from("usage_counters").delete().in("clinic_id", clinics);
  await service.from("subscriptions").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);
  await Promise.all(actors.map((actorId) => service.auth.admin.deleteUser(actorId)));
}

beforeAll(async () => {
  await cleanup();
  const plans = await service.from("plans").select("id, slug").in("slug", ["basic", "pro", "pro_ai"]);
  if (plans.error) throw plans.error;
  const planBySlug = Object.fromEntries(plans.data.map((plan) => [plan.slug, plan.id]));

  const clinics = await service.from("clinics").insert(
    Object.entries(clinicIds).map(([key, id]) => ({ id, name: `P45C ${key} ${suffix}` })),
  );
  if (clinics.error) throw clinics.error;

  const planForClinic: Record<ClinicKey, "basic" | "pro" | "pro_ai"> = {
    basic: "basic",
    pro: "pro",
    commercial: "pro_ai",
    hardCap: "pro_ai",
    concurrency: "pro_ai",
    correction: "pro_ai",
  };
  const subscriptions = await service.from("subscriptions").insert(
    (Object.keys(clinicIds) as ClinicKey[]).map((key) => ({
      clinic_id: clinicIds[key],
      plan_id: planBySlug[planForClinic[key]],
      status: "trialing" as const,
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    })),
  );
  if (subscriptions.error) throw subscriptions.error;

  for (const key of Object.keys(actorIds) as ClinicKey[]) {
    const auth = await service.auth.admin.createUser({
      id: actorIds[key],
      email: `p45c-${suffix}-${key}@example.com`,
      password,
      email_confirm: true,
    });
    if (auth.error) throw auth.error;
    const profile = await service.from("profiles").insert({
      id: actorIds[key],
      clinic_id: clinicIds[key],
      full_name: `P45C ${key}`,
      role: "admin",
    });
    if (profile.error) throw profile.error;
  }

  const overrides = await service.from("clinic_feature_overrides").insert(
    (["basic", "pro"] as const).flatMap((key) =>
      ["ai_assistant", "ai.staff_assistant", "ai.managed"].map((featureKey) => ({
        clinic_id: clinicIds[key],
        feature_key: featureKey,
        enabled: true,
        updated_by: actorIds[key],
      })),
    ),
  );
  if (overrides.error) throw overrides.error;

  const terms = await service.from("ai_commercial_terms").insert([
    {
      clinic_id: clinicIds.commercial,
      included_budget_override_micros: 1_000,
      addon_budget_micros: 1_000,
      overage_mode: "contracted",
      overage_budget_micros: 1_000,
      change_reason: "contracted_overage",
      updated_by: actorIds.commercial,
    },
    {
      clinic_id: clinicIds.hardCap,
      included_budget_override_micros: 1_000,
      addon_budget_micros: 1_000,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      change_reason: "prepaid_addon",
      updated_by: actorIds.hardCap,
    },
    {
      clinic_id: clinicIds.concurrency,
      included_budget_override_micros: 10_000,
      addon_budget_micros: 0,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      change_reason: "pilot",
      updated_by: actorIds.concurrency,
    },
    {
      // Included 1,000; add-on 2,000. Two 800-micros reservations both fit the
      // included allowance once their real cost is known, but the second one is
      // stamped managed_addon at reserve time because worst-case reserved cost
      // pushes committed spend past the included ceiling.
      clinic_id: clinicIds.correction,
      included_budget_override_micros: 1_000,
      addon_budget_micros: 2_000,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      change_reason: "prepaid_addon",
      updated_by: actorIds.correction,
    },
  ]);
  if (terms.error) throw terms.error;

  const login = await tenant.auth.signInWithPassword({
    email: `p45c-${suffix}-basic@example.com`,
    password,
  });
  if (login.error) throw login.error;
});

afterAll(cleanup);

describe("P4.5C commercial AI entitlements and limits", () => {
  it("keeps stable slugs while exposing the namespaced Pro + AI catalog", async () => {
    const plans = await service.from("plans").select("slug, name_en, features, limits").in("slug", ["basic", "pro", "pro_ai"]);
    if (plans.error) throw plans.error;
    const bySlug = Object.fromEntries(plans.data.map((plan) => [plan.slug, plan]));
    expect(bySlug.basic.name_en).toBe("Basic");
    expect(bySlug.pro.name_en).toBe("Professional");
    expect(bySlug.pro_ai.name_en).toBe("Pro + AI");
    expect((bySlug.basic.features as Record<string, boolean>)["ai.staff_assistant"]).toBe(false);
    expect((bySlug.pro.features as Record<string, boolean>)["ai.staff_assistant"]).toBe(false);
    expect((bySlug.pro_ai.features as Record<string, boolean>)).toMatchObject({
      ai_assistant: true,
      "ai.staff_assistant": true,
      "ai.managed": true,
      "ai.byok": true,
      "ai.hybrid_fallback": false,
    });
    expect((bySlug.pro_ai.limits as Record<string, number>)).toMatchObject({
      ai_requests_month: 1_000,
      ai_concurrent_requests: 4,
    });
  });

  it("denies AI on Basic and Professional even when legacy and namespaced overrides are present", async () => {
    const [basic, pro] = await Promise.all([reserve("basic"), reserve("pro")]);
    expect(basic.error?.message).toContain("NOT_ENTITLED");
    expect(pro.error?.message).toContain("NOT_ENTITLED");
  });

  it("classifies included, prepaid add-on, and contracted overage spend and enforces the ceiling", async () => {
    const dispositions: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const reserved = await reserve("commercial");
      expect(reserved.error).toBeNull();
      const row = reserved.data![0];
      const reservation = await service.from("ai_budget_reservations")
        .select("managed_billing_disposition")
        .eq("id", row.reservation_id)
        .single();
      if (reservation.error) throw reservation.error;
      dispositions.push(reservation.data.managed_billing_disposition);
      const reconciled = await reconcile(row, 1_000);
      expect(reconciled.error).toBeNull();
    }
    expect(dispositions).toEqual(["managed_included", "managed_addon", "managed_overage"]);
    const denied = await reserve("commercial");
    expect(denied.error?.message).toContain("AI_BUDGET_EXCEEDED");
  });

  it("corrects the immutable event bucket from actual cost at reconciliation", async () => {
    // Two overlapping reservations, worst-case 800 micros each, before either
    // reconciles. The second is stamped managed_addon at reserve time because
    // committed spend (0 spent + 1,600 reserved) exceeds the 1,000 included
    // ceiling.
    const first = await reserve("correction", 800);
    expect(first.error).toBeNull();
    const second = await reserve("correction", 800);
    expect(second.error).toBeNull();
    const secondId = second.data![0].reservation_id;

    const reserveTimeBucket = await service
      .from("ai_budget_reservations")
      .select("managed_billing_disposition")
      .eq("id", secondId)
      .single();
    if (reserveTimeBucket.error) throw reserveTimeBucket.error;
    expect(reserveTimeBucket.data.managed_billing_disposition).toBe("managed_addon");

    // Real cost is only 100 micros each, so both belong entirely in the included
    // allowance. Reconciliation re-derives the bucket from actual managed spend.
    expect((await reconcile(first.data![0], 100)).error).toBeNull();
    expect((await reconcile(second.data![0], 100)).error).toBeNull();

    const correctedReservation = await service
      .from("ai_budget_reservations")
      .select("managed_billing_disposition")
      .eq("id", secondId)
      .single();
    if (correctedReservation.error) throw correctedReservation.error;
    expect(correctedReservation.data.managed_billing_disposition).toBe("managed_included");

    const events = await service
      .from("ai_usage_events")
      .select("billing_disposition")
      .eq("reservation_id", secondId);
    if (events.error) throw events.error;
    expect(events.data.map((event) => event.billing_disposition)).toEqual(["managed_included"]);

    // Period aggregate remains the exact invoicing source of truth: 200 managed
    // micros, fully inside the included allowance.
    const period = await service
      .from("ai_budget_periods")
      .select("spent_micros, included_limit_micros")
      .eq("clinic_id", clinicIds.correction)
      .eq("period_start", periodStart)
      .single();
    if (period.error) throw period.error;
    expect(period.data.spent_micros).toBe(200);
    expect(period.data.spent_micros).toBeLessThanOrEqual(period.data.included_limit_micros);
  });

  it("enforces a prepaid add-on hard cap without silently creating overage", async () => {
    for (let index = 0; index < 2; index += 1) {
      const reserved = await reserve("hardCap");
      expect(reserved.error).toBeNull();
      const reconciled = await reconcile(reserved.data![0], 1_000);
      expect(reconciled.error).toBeNull();
    }
    const denied = await reserve("hardCap");
    expect(denied.error?.message).toContain("AI_BUDGET_EXCEEDED");
  });

  it("enforces the database concurrency cap independently of the monthly allowance", async () => {
    const active = await Promise.all(Array.from({ length: 4 }, () => reserve("concurrency")));
    expect(active.every((result) => result.error === null)).toBe(true);
    const denied = await reserve("concurrency");
    expect(denied.error?.message).toContain("AI_BUDGET_CONCURRENCY_EXCEEDED");
  });

  it("returns content-free operator aggregates reconciled to the immutable ledger", async () => {
    const report = await service.rpc("operator_ai_usage_report", {
      p_period_from: periodStart,
      p_period_to: periodStart,
      p_clinic_id: clinicIds.commercial,
    });
    expect(report.error).toBeNull();
    expect(report.data).toEqual([
      expect.objectContaining({
        clinic_id: clinicIds.commercial,
        budget_limit_micros: 3_000,
        reserved_micros: 0,
        managed_spent_micros: 3_000,
        provider_cost_micros: 3_000,
        request_used: 3,
      }),
    ]);
    expect(Object.keys(report.data![0])).not.toEqual(expect.arrayContaining([
      "actor_id",
      "prompt",
      "completion",
      "patient_id",
      "message_body",
    ]));
  });

  it("denies clinic users direct commercial data and operator-report access", async () => {
    const ownTerms = await tenant.from("ai_commercial_terms").select("clinic_id");
    const crossPeriod = await tenant.from("ai_budget_periods")
      .select("clinic_id")
      .eq("clinic_id", clinicIds.commercial);
    const report = await tenant.rpc("operator_ai_usage_report", {
      p_period_from: periodStart,
      p_period_to: periodStart,
      p_clinic_id: clinicIds.commercial,
    });
    expect(ownTerms.data).toEqual([]);
    expect(crossPeriod.error).not.toBeNull();
    expect(report.error?.message).toContain("PLATFORM_ADMIN_REQUIRED");
  });
});
