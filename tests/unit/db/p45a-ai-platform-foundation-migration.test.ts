import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260719120000_p45a_ai_platform_foundation.sql",
  "utf8",
).toLowerCase();
const reviewMigration = readFileSync(
  "supabase/migrations/20260719123000_p45a_review_fixes.sql",
  "utf8",
).toLowerCase();

describe("P4.5A AI platform migration", () => {
  it("creates a durable cost pool, reservation lease, and content-free ledger", () => {
    expect(migration).toContain("create table public.ai_budget_periods");
    expect(migration).toContain("create table public.ai_budget_reservations");
    expect(migration).toContain("create table public.ai_usage_events");
    expect(migration).toContain("unique (clinic_id, request_id)");
    expect(migration).toContain("unique (reservation_id, attempt_sequence)");
    expect(migration).not.toMatch(/\b(prompt|completion|message_body|tool_payload|patient_id|credential_secret)\s+(text|jsonb)/);
  });

  it("fails closed under RLS and exposes service-role RPCs only", () => {
    for (const table of ["ai_budget_periods", "ai_budget_reservations", "ai_usage_events"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
    }
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration).toMatch(/revoke all on function public\.reserve_ai_budget\([\s\S]*?from public, anon, authenticated;/);
    expect(migration).toMatch(/revoke all on function public\.reconcile_ai_budget\([\s\S]*?from public, anon, authenticated;/);
  });

  it("reserves cost and the legacy request unit in one transaction", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("spent_micros + v_period.reserved_micros + p_reserved_cost_micros");
    expect(migration).toContain("public.increment_usage(");
    expect(migration).toContain("reserved_micros = reserved_micros + p_reserved_cost_micros");
    expect(migration).toContain("raise exception 'ai_budget_exceeded'");
    expect(migration).toContain("actual_cost_micros <= reserved_cost_micros");
    expect(migration).toContain("v_authoritative_budget_limit");
    expect(migration).toContain("plan.limits ->> 'ai_messages_month'");
  });

  it("reclaims expired leases and reconciles actual provider cost atomically", () => {
    expect(migration).toContain("and expires_at <= clock_timestamp()");
    expect(migration).toContain("'reservation_expired'");
    expect(migration).toContain("insert into public.ai_usage_events");
    expect(migration).toContain("trg_ai_budget_reservations_clamp_actual");
    expect(migration).toContain("new.actual_cost_micros := least(");
    expect(migration).toContain("spent_micros = spent_micros + p_actual_cost_micros");
    expect(migration).toContain("perform public.release_usage(");
    expect(reviewMigration).toContain("reserve_ai_budget_p45a_limit_v1");
    expect(reviewMigration).toContain("v_authoritative_budget_limit");
    expect(reviewMigration).toContain("trg_ai_budget_reservations_clamp_actual");
  });

  it("rejects ledger mutation and any unapproved attempt field", () => {
    expect(migration).toContain("create trigger trg_ai_usage_events_immutable");
    expect(migration).toContain("before update or delete on public.ai_usage_events");
    expect(migration).toContain("raise exception 'ai_usage_events_immutable'");
    expect(migration).toContain("raise exception 'ai_budget_attempt_content_forbidden'");
    expect(migration).toContain("cross join lateral jsonb_object_keys(element) key");
  });
});
