import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
const clinicIds = [
  "a1000000-0000-4000-8000-000000000001",
  "a1000000-0000-4000-8000-000000000002",
  "a1000000-0000-4000-8000-000000000003",
  "a1000000-0000-4000-8000-000000000004",
];
let basicPlanId: string;
let aiPlanId: string;
const subscriptionIds: string[] = [];

async function cleanup() {
  await service.from("platform_audit_logs").delete().in("clinic_id", clinicIds);
  await service.from("coupon_redemptions").delete().in("clinic_id", clinicIds);
  await service.from("coupons").delete().like("code", `P1B${suffix}%`);
  await service.from("usage_counters").delete().in("clinic_id", clinicIds);
  await service.from("clinic_feature_overrides").delete().in("clinic_id", clinicIds);
  await service.from("subscriptions").delete().in("clinic_id", clinicIds);
  await service.from("clinics").delete().in("id", clinicIds);
}

async function redeem(clinicId: string, code: string) {
  return service.rpc("redeem_coupon", { p_clinic_id: clinicId, p_code: code });
}

beforeAll(async () => {
  await cleanup();
  const plans = await service.from("plans").select("id, slug").in("slug", ["basic", "pro_ai"]);
  if (plans.error) throw plans.error;
  basicPlanId = plans.data.find((plan) => plan.slug === "basic")!.id;
  aiPlanId = plans.data.find((plan) => plan.slug === "pro_ai")!.id;
  const clinics = await service.from("clinics").insert(
    clinicIds.map((id, index) => ({ id, name: `P1B ${suffix} ${index}` })),
  );
  if (clinics.error) throw clinics.error;
  const subscriptions = await service
    .from("subscriptions")
    .insert(
      clinicIds.map((clinic_id) => ({
        clinic_id,
        plan_id: basicPlanId,
        status: "trialing" as const,
        trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      })),
    )
    .select("id, clinic_id");
  if (subscriptions.error) throw subscriptions.error;
  for (const clinicId of clinicIds) {
    subscriptionIds.push(subscriptions.data.find((row) => row.clinic_id === clinicId)!.id);
  }
});

afterAll(cleanup);

describe("P1B atomic coupon redemption", () => {
  it("does not expose coupon redemption to authenticated clinic callers", async () => {
    const email = `p1b-auth-${suffix}@example.com`;
    const password = "Password123!";
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error;
    const caller = createClient<Database>(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await service.from("profiles").insert({
      id: created.data.user.id, clinic_id: clinicIds[0], full_name: "Coupon Caller", role: "admin",
    });
    await caller.auth.signInWithPassword({ email, password });
    const result = await caller.rpc("redeem_coupon", {
      p_clinic_id: clinicIds[0], p_code: `P1B${suffix}NOPE`,
    });
    expect(result.error).not.toBeNull();
    await service.from("profiles").delete().eq("id", created.data.user.id);
    await service.auth.admin.deleteUser(created.data.user.id);
  });

  it("does not resurrect a cancelled subscription", async () => {
    const code = `P1B${suffix}CANCELLED`;
    await service.from("subscriptions").update({ status: "cancelled" }).eq("clinic_id", clinicIds[0]);
    await service.from("coupons").insert({ code, kind: "lifetime_free" });
    const result = await redeem(clinicIds[0], code);
    expect(result.error?.message).toContain("CANCELLED_SUBSCRIPTION");
    const subscription = await service.from("subscriptions").select("status").eq("clinic_id", clinicIds[0]).single();
    expect(subscription.data?.status).toBe("cancelled");
    await service.from("subscriptions").update({ status: "trialing" }).eq("clinic_id", clinicIds[0]);
  });

  it("applies lifetime, finite months, and percentage effects", async () => {
    const lifetimeCode = `P1B${suffix}LIFE`;
    const monthsCode = `P1B${suffix}MONTHS`;
    const percentCode = `P1B${suffix}PERCENT`;
    const coupons = await service.from("coupons").insert([
      { code: lifetimeCode, kind: "lifetime_free" },
      { code: monthsCode, kind: "months_free", months: 3 },
      { code: percentCode, kind: "percent_discount", percent: 25 },
    ]);
    if (coupons.error) throw coupons.error;

    const [lifetime, months, percent] = await Promise.all([
      redeem(clinicIds[0], lifetimeCode),
      redeem(clinicIds[1], monthsCode),
      redeem(clinicIds[2], percentCode),
    ]);
    expect(lifetime.error).toBeNull();
    expect(lifetime.data).toMatchObject({ kind: "lifetime_free", discountPercent: 100 });
    expect(months.error).toBeNull();
    expect(months.data).toMatchObject({ kind: "months_free", discountPercent: 100 });
    expect(typeof (months.data as { compedUntil: unknown }).compedUntil).toBe("string");
    expect(percent.error).toBeNull();
    expect(percent.data).toMatchObject({ kind: "percent_discount", discountPercent: 25 });

    const subscriptions = await service
      .from("subscriptions")
      .select("clinic_id, status, trial_ends_at, current_period_end")
      .in("clinic_id", clinicIds.slice(0, 3));
    const lifetimeSubscription = subscriptions.data!.find((row) => row.clinic_id === clinicIds[0]);
    const monthsSubscription = subscriptions.data!.find((row) => row.clinic_id === clinicIds[1]);
    const percentSubscription = subscriptions.data!.find((row) => row.clinic_id === clinicIds[2]);
    expect(lifetimeSubscription).toMatchObject({ status: "active", trial_ends_at: null, current_period_end: null });
    expect(monthsSubscription?.status).toBe("active");
    expect(monthsSubscription?.current_period_end).not.toBeNull();
    expect(percentSubscription?.status).toBe("trialing");
    const audit = await service.from("platform_audit_logs").select("action, clinic_id")
      .eq("action", "coupon.redeemed").eq("clinic_id", clinicIds[0]);
    expect(audit.data).toHaveLength(1);
  });

  it("preserves an unbounded active grant when months_free is redeemed", async () => {
    const code = `P1B${suffix}UNBOUNDED`;
    const reset = await service
      .from("subscriptions")
      .update({ status: "active", trial_ends_at: null, current_period_end: null })
      .eq("clinic_id", clinicIds[3]);
    if (reset.error) throw reset.error;
    const coupon = await service.from("coupons").insert({ code, kind: "months_free", months: 6 });
    if (coupon.error) throw coupon.error;

    const result = await redeem(clinicIds[3], code);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ kind: "months_free", compedUntil: null });
    const subscription = await service
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("clinic_id", clinicIds[3])
      .single();
    expect(subscription.data).toEqual({ status: "active", current_period_end: null });
  });

  it("serializes concurrent unlimited redemption without false limit errors", async () => {
    const code = `P1B${suffix}UNLIMITED`;
    const coupon = await service.from("coupons").insert({ code, kind: "percent_discount", percent: 10 });
    if (coupon.error) throw coupon.error;
    const results = await Promise.all([redeem(clinicIds[0], code), redeem(clinicIds[1], code)]);
    expect(results.every((result) => result.error === null)).toBe(true);
    const persisted = await service.from("coupons").select("redemption_count").eq("code", code).single();
    expect(persisted.data?.redemption_count).toBe(2);
  });

  it("allows exactly one concurrent redemption at max_redemptions=1", async () => {
    const code = `P1B${suffix}LIMITED`;
    const coupon = await service.from("coupons").insert({
      code,
      kind: "percent_discount",
      percent: 15,
      max_redemptions: 1,
    });
    if (coupon.error) throw coupon.error;
    const results = await Promise.all([redeem(clinicIds[2], code), redeem(clinicIds[3], code)]);
    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(results.find((result) => result.error)?.error?.message).toContain("COUPON_LIMIT_REACHED");
    const persisted = await service.from("coupons").select("id, redemption_count").eq("code", code).single();
    const redemptions = await service
      .from("coupon_redemptions")
      .select("id")
      .eq("coupon_id", persisted.data!.id);
    expect(persisted.data?.redemption_count).toBe(1);
    expect(redemptions.data).toHaveLength(1);
  });

  it("rolls back every write when invitation assignment validation fails", async () => {
    const code = `P1B${suffix}ASSIGNED`;
    const invitationId = "a2000000-0000-4000-8000-000000000001";
    const invitation = await service.from("clinic_invitations").insert({
      id: invitationId,
      clinic_name: "Assigned",
      owner_name: "Owner",
      phone: "+96550000000",
      email: `p1b-${suffix}@example.com`,
      status: "pending",
    });
    if (invitation.error) throw invitation.error;
    const coupon = await service.from("coupons").insert({
      code,
      kind: "lifetime_free",
      invitation_id: invitationId,
    });
    if (coupon.error) throw coupon.error;

    const result = await service.rpc("redeem_coupon", {
      p_clinic_id: clinicIds[0],
      p_code: code,
      p_invitation_id: invitationId,
    });
    expect(result.error?.message).toContain("COUPON_NOT_ASSIGNED");
    const persisted = await service.from("coupons").select("id, redemption_count").eq("code", code).single();
    const redemptions = await service
      .from("coupon_redemptions")
      .select("id")
      .eq("coupon_id", persisted.data!.id);
    expect(persisted.data?.redemption_count).toBe(0);
    expect(redemptions.data).toEqual([]);
    await service.from("coupons").delete().eq("code", code);
    await service.from("clinic_invitations").delete().eq("id", invitationId);
  });
});

describe("P1B usage limit resolution and atomic reservation", () => {
  it("applies upgrades immediately and preserves the higher snapshot on downgrade", async () => {
    const clinicId = clinicIds[0];
    const periodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
    await service.from("usage_counters").delete().eq("clinic_id", clinicId);
    const counter = await service.from("usage_counters").insert({
      clinic_id: clinicId,
      period_start: periodStart,
      metric: "ai_messages",
      used: 0,
      limit_snapshot: 0,
    });
    if (counter.error) throw counter.error;
    await service.from("subscriptions").update({ plan_id: aiPlanId }).eq("clinic_id", clinicId);

    const { checkUsageLimit } = await import("@/lib/entitlements");
    await expect(checkUsageLimit(clinicId, "ai_messages")).resolves.toMatchObject({
      allowed: true,
      limit: 1000,
    });
    const reserved = await service.rpc("increment_usage", {
      p_clinic_id: clinicId,
      p_metric: "ai_messages",
      p_amount: 1,
    });
    expect(reserved.error).toBeNull();
    const upgraded = await service
      .from("usage_counters")
      .select("limit_snapshot")
      .eq("clinic_id", clinicId)
      .eq("metric", "ai_messages")
      .single();
    expect(upgraded.data?.limit_snapshot).toBe(1000);

    await service.from("subscriptions").update({ plan_id: basicPlanId }).eq("clinic_id", clinicId);
    const afterDowngrade = await service.rpc("increment_usage", {
      p_clinic_id: clinicId,
      p_metric: "ai_messages",
      p_amount: 1,
    });
    expect(afterDowngrade.error).toBeNull();
    const preserved = await service
      .from("usage_counters")
      .select("limit_snapshot")
      .eq("clinic_id", clinicId)
      .eq("metric", "ai_messages")
      .single();
    expect(preserved.data?.limit_snapshot).toBe(1000);
  });

  it("prevents concurrent callers from overshooting the hard cap", async () => {
    const clinicId = clinicIds[1];
    const periodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
    await service.from("usage_counters").delete().eq("clinic_id", clinicId);
    await service.from("subscriptions").update({ plan_id: aiPlanId }).eq("clinic_id", clinicId);
    const counter = await service.from("usage_counters").insert({
      clinic_id: clinicId,
      period_start: periodStart,
      metric: "ai_messages",
      used: 999,
      limit_snapshot: 1000,
    });
    if (counter.error) throw counter.error;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.rpc("increment_usage", {
          p_clinic_id: clinicId,
          p_metric: "ai_messages",
          p_amount: 1,
        }),
      ),
    );
    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(
      results.filter((result) => result.error).every((result) =>
        result.error!.message.includes("USAGE_LIMIT_EXCEEDED"),
      ),
    ).toBe(true);
    const persisted = await service
      .from("usage_counters")
      .select("used, limit_snapshot")
      .eq("clinic_id", clinicId)
      .eq("metric", "ai_messages")
      .single();
    expect(persisted.data).toEqual({ used: 1000, limit_snapshot: 1000 });
  });
});
