/**
 * P12 migration invariants.
 *
 * These are text assertions over the SQL because the enforcement they describe
 * lives in the database, not in the application. A behavioural test that mocked
 * the RPC would prove nothing about the guarantee that actually matters: that a
 * BYOK reservation CANNOT book managed spend even if some future caller asks it
 * to.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "supabase/migrations/20260831120000_p12_direct_anthropic_allowance.sql";
const migration = readFileSync(PATH, "utf8");

function functionBody(signature: string): string {
  const start = migration.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = migration.indexOf("\n$$;", start);
  return migration.slice(start, end === -1 ? undefined : end);
}

describe("additive only", () => {
  it("never drops or truncates an existing table or column", () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/drop\s+column/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });

  it("adds columns idempotently so a partially-applied database converges", () => {
    expect(migration).toContain("add column if not exists auto_byok_fallback_enabled");
    expect(migration).toContain("add column if not exists byok_spent_micros");
    expect(migration).toContain("add column if not exists consumes_managed_budget");
    expect(migration).toContain("add column if not exists resolution_reason");
    expect(migration).toContain("create table if not exists public.ai_usage_threshold_notifications");
  });

  it("touches no clinic, patient, or credential data", () => {
    expect(migration).not.toMatch(/credential_encrypted\s*=/);
    expect(migration).not.toMatch(/update\s+public\.(clinics|patients|profiles|ai_provider_connections)/i);
  });
});

describe("G2/G3 — the allowance split", () => {
  it("marks strict BYOK as not consuming the managed budget", () => {
    expect(migration).toContain("v_consumes := p_credential_mode <> 'byok_strict';");
  });

  it("forbids a managed turn from escaping the managed allowance", () => {
    expect(migration).toContain("ai_budget_reservations_managed_consumes_check");
    expect(migration).toContain("check (credential_mode <> 'managed' or consumes_managed_budget)");
  });

  it("skips the cost ceiling and the funded request unit for a BYOK reservation", () => {
    const reserve = functionBody("create or replace function public.reserve_ai_budget_v2_internal");
    // Both the money check and increment_usage sit inside the consuming branch.
    expect(reserve).toMatch(
      /if p_consumes_managed_budget then[\s\S]*?AI_BUDGET_EXCEEDED[\s\S]*?increment_usage[\s\S]*?else/,
    );
    // And the reserved balance is only moved for a consuming reservation.
    expect(reserve).toMatch(
      /if p_consumes_managed_budget then\s+update public\.ai_budget_periods\s+set reserved_micros = reserved_micros \+ p_reserved_cost_micros/,
    );
  });

  it("still enforces concurrency in every mode", () => {
    const reserve = functionBody("create or replace function public.reserve_ai_budget_v2_internal");
    const concurrencyIndex = reserve.indexOf("AI_BUDGET_CONCURRENCY_EXCEEDED");
    const consumingBranchIndex = reserve.indexOf("if p_consumes_managed_budget then");
    expect(concurrencyIndex).toBeGreaterThan(-1);
    // The concurrency check precedes — and is therefore outside — the branch.
    expect(concurrencyIndex).toBeLessThan(consumingBranchIndex);
  });

  it("bounds BYOK with a fair-use ceiling that is not a price", () => {
    expect(migration).toContain("AI_FAIR_USE_LIMIT_EXCEEDED");
    expect(migration).toContain("ai_byok_requests_month");
    expect(migration).toContain("'ai_byok_requests_month', 20000");
  });

  it("lets a BYOK-only clinic resolve limits without a funded allowance", () => {
    const resolve = functionBody(
      "create or replace function public.resolve_ai_commercial_limits_v2",
    );
    // Concurrency is unconditional; the monetary/funded-request checks are not.
    expect(resolve).toContain("if concurrency_limit <= 0 then");
    expect(resolve).toMatch(
      /if p_require_managed_budget\s+and \(total_limit_micros <= 0 or request_limit <= 0\) then/,
    );
    // And the plan-owned-allowance entitlement check is likewise managed-only.
    expect(resolve).toMatch(/if p_require_managed_budget then[\s\S]*?ai_credits_month/);
    // Every other entitlement rule from the plan-decoupled resolver is intact.
    expect(resolve).toContain("public.effective_ai_feature(p_clinic_id, 'ai_assistant')");
    expect(resolve).toContain("accepted_at is not null");
    expect(resolve).toContain("when no_data_found then");
    expect(resolve).not.toMatch(/plan\.slug\s*=\s*'pro_ai'/);
  });

  it("refuses managed spend on a reservation that never claimed any", () => {
    expect(migration).toContain(
      "if not v_reservation.consumes_managed_budget and p_managed_cost_micros <> 0 then",
    );
    expect(migration).toContain("AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN");
  });

  it("books direct provider cost to its own column, never to the managed pool", () => {
    expect(migration).toContain(
      "set byok_spent_micros = byok_spent_micros + p_actual_cost_micros",
    );
    expect(migration).toContain(
      "set spent_micros = spent_micros - v_direct_cost_micros,\n        byok_spent_micros = byok_spent_micros + v_direct_cost_micros",
    );
  });

  it("releases the funded request unit only for a funded reservation", () => {
    expect(migration).toContain(
      "if p_outcome <> 'success' and v_reservation.consumes_managed_budget then",
    );
  });
});

describe("G1 — ordered resolution", () => {
  it("permits ONLY the managed→BYOK direction, never the reverse", () => {
    const reserve = functionBody("create or replace function public.reserve_ai_budget(");
    expect(reserve).toContain("if p_credential_mode = 'byok_strict'");
    expect(reserve).toContain("and v_policy_mode in ('managed', 'hybrid')");
    expect(reserve).toContain("and v_auto_fallback then");
    expect(reserve).toContain("AI_PROVIDER_POLICY_MISMATCH");
    // There is no branch admitting a managed credential under a BYOK policy.
    expect(reserve).not.toMatch(/p_credential_mode = 'managed'\s+and v_policy_mode = 'byok_strict'/);
  });

  it("still requires a healthy clinic connection and the BYOK entitlement", () => {
    const reserve = functionBody("create or replace function public.reserve_ai_budget(");
    expect(reserve).toContain("AI_PROVIDER_MODE_NOT_ENTITLED");
    expect(reserve).toContain("AI_PROVIDER_CONNECTION_NOT_HEALTHY");
    expect(reserve).toContain("connection.health_status = 'valid'");
  });

  it("records why a turn ran on the credential it ran on", () => {
    expect(migration).toContain(
      "check (resolution_reason in ('policy', 'auto_byok_fallback', 'hybrid_degraded_to_byok'))",
    );
  });

  it("gives the clinic an audited way to refuse the handover", () => {
    expect(migration).toContain("create or replace function public.set_ai_auto_byok_fallback");
    expect(migration).toContain("'AI_PROVIDER_AUTO_FALLBACK_CHANGED'");
    expect(migration).toContain("auto_byok_fallback_enabled boolean not null default true");
  });
});

describe("security invariants are preserved", () => {
  it("keeps every budget mutation service-role only", () => {
    for (const fn of [
      "public.reserve_ai_budget_v2_internal",
      "public.reserve_ai_budget(",
      "public.reconcile_ai_budget(",
      "public.claim_ai_usage_threshold_notice",
      "public.set_ai_auto_byok_fallback",
    ]) {
      expect(functionBody(`create or replace function ${fn}`)).toContain(
        "if coalesce(auth.role(), '') <> 'service_role' then",
      );
    }
  });

  it("revokes the new tables and functions from anon/authenticated", () => {
    expect(migration).toContain(
      "revoke all on table public.ai_usage_threshold_notifications from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "alter table public.ai_usage_threshold_notifications enable row level security;",
    );
    expect(migration).toContain(
      "revoke all on function public.resolve_ai_commercial_limits_v2(uuid, date, boolean)\n  from public, anon, authenticated, service_role;",
    );
  });

  it("keeps the usage ledger append-only and content-free", () => {
    // No UPDATE of ai_usage_events anywhere, and the attempt allow-list is intact.
    expect(migration).not.toMatch(/update\s+public\.ai_usage_events/i);
    expect(migration).toContain("AI_BUDGET_ATTEMPT_CONTENT_FORBIDDEN");
    // No content-bearing identifier is written anywhere in the ledger path.
    // Scanned over statements only: the prose comments legitimately use the
    // words "content-free" and "prompts" to say the opposite of what a naive
    // whole-file match would read them as.
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(
      /\b(prompt_text|completion_text|message_body|patient_name|conversation_text)\b/i,
    );
  });

  it("keeps the notification dedupe row content-free", () => {
    const table = migration.slice(
      migration.indexOf("create table if not exists public.ai_usage_threshold_notifications"),
      migration.indexOf("alter table public.ai_usage_threshold_notifications"),
    );
    expect(table).toContain("threshold smallint");
    expect(table).toContain("used_percent smallint");
    expect(table).not.toMatch(/text|jsonb/);
  });
});

describe("owner allowance console", () => {
  it("is platform-admin gated and reports one effective allowance", () => {
    const report = functionBody(
      "create or replace function public.operator_ai_allowance_report",
    );
    expect(report).toContain("PLATFORM_ADMIN_REQUIRED");
    expect(report).toContain("coalesce(base.override_included, base.plan_included)");
    expect(report).toContain("'ai_credits_month'");
    expect(report).toContain("byok_configured");
    expect(report).toContain("period_reset_at");
  });

  it("uses the same 75/90 bands as the clinic meter and the notifier", () => {
    const report = functionBody(
      "create or replace function public.operator_ai_allowance_report",
    );
    expect(report).toContain(">= 0.90 then 'critical'");
    expect(report).toContain(">= 0.75 then 'warning'");
    expect(report).toContain("'exhausted'");
  });

  it("hardcodes no commercial allowance amount", () => {
    // The only seeded number is the abuse ceiling; the funded allowance stays a
    // plan/override value.
    const seeds = migration.match(/'ai_[a-z_]+',\s*\d+/g) ?? [];
    expect(seeds).toEqual(["'ai_byok_requests_month', 20000"]);
  });
});
