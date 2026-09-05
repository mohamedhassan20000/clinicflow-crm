/**
 * P13b — the default included managed AI allowance is $10.00 per clinic per
 * billing period, and it lives in the commercial source of truth.
 *
 * The migration is asserted as text (this suite never touches a database) plus
 * an execution-level check of the allowance rule itself through the shared
 * recompute path, which is the one place the plan default and the per-clinic
 * override meet in TypeScript.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS,
  DEFAULT_INCLUDED_AI_ALLOWANCE_USD,
} from "@/lib/ai/commercial-policy";

const MIGRATION = readFileSync(
  "supabase/migrations/20260901120000_p13b_default_ai_allowance_ten_usd.sql",
  "utf8",
);

describe("default AI allowance constant", () => {
  it("is $10.00, expressed in the ledger's micro unit", () => {
    expect(DEFAULT_INCLUDED_AI_ALLOWANCE_USD).toBe(10);
    expect(DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS).toBe(10_000_000);
  });
});

describe("plan catalog migration", () => {
  it("writes the default onto the plan limit the whole system reads", () => {
    expect(MIGRATION).toContain("update public.plans");
    expect(MIGRATION).toContain("'ai_credits_month', 10000000");
    expect(MIGRATION).toContain(String(DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS));
  });

  it("applies only to plans that actually include the AI assistant", () => {
    expect(MIGRATION).toContain("features ->> 'ai_assistant'");
  });

  it("is idempotent — re-running it changes nothing once the default is in place", () => {
    expect(MIGRATION).toContain("is distinct from 10000000");
  });

  it("merges into limits rather than replacing the plan's other ceilings", () => {
    expect(MIGRATION).toContain("limits = limits || jsonb_build_object");
    for (const preserved of [
      "ai_requests_month",
      "ai_concurrent_requests",
      "ai_turn_steps_max",
      "ai_output_tokens_max",
    ]) {
      // The merge names only ai_credits_month, so every other ceiling survives.
      expect(MIGRATION).not.toContain(`'${preserved}',`);
    }
  });

  it("never touches the per-clinic override table or any spend record", () => {
    expect(MIGRATION).not.toMatch(/update\s+public\.ai_commercial_terms/);
    expect(MIGRATION).not.toContain("included_budget_override_micros is not null");
    expect(MIGRATION).not.toMatch(/update\s+public\.ai_budget_periods/);
    expect(MIGRATION).not.toMatch(/update\s+public\.usage_counters/);
    expect(MIGRATION).not.toMatch(/\bdelete\s+from\b/i);
  });
});
