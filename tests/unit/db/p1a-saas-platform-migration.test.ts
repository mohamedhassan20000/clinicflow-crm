import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260710120000_p1a_saas_platform_schema.sql",
  ),
  "utf8",
);

describe("P1A SaaS platform migration", () => {
  it("creates every P1A table and enables RLS", () => {
    for (const table of [
      "platform_admins",
      "platform_settings",
      "clinic_invitations",
      "plans",
      "subscriptions",
      "usage_counters",
      "coupons",
      "coupon_redemptions",
      "clinic_feature_overrides",
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("keeps provider identifiers generic and feature overrides relational", () => {
    expect(migration).toMatch(/provider text not null default 'manual'/);
    expect(migration).toContain("create table public.clinic_feature_overrides");
    expect(migration).not.toMatch(/alter table public\.clinics[\s\S]*features jsonb/);
  });

  it("defines the platform guard, atomic usage RPC, defaults, and plan seeds", () => {
    expect(migration).toContain("create or replace function public.is_platform_admin");
    expect(migration).toContain("create or replace function public.increment_usage");
    expect(migration).toContain("on conflict (clinic_id, period_start, metric)");
    expect(migration).not.toContain("p_limit_snapshot");
    expect(migration).toContain("plan.limits ->> v_limit_key");
    expect(migration).toContain("percent is not null and percent between 1 and 100");
    expect(migration).toContain("default 'invite_only'");
    expect(migration).toContain("default 20");
    expect(migration).toContain("('basic', 'الأساسية', 'Basic'");
    expect(migration).toContain("('pro', 'الاحترافية', 'Pro'");
    expect(migration).toContain("('pro_ai', 'الاحترافية مع الذكاء الاصطناعي', 'Pro + AI'");
  });
});
