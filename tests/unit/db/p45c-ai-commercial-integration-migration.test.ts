import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260719140000_p45c_ai_commercial_integration.sql",
  "utf8",
);

describe("P4.5C AI commercial integration migration", () => {
  it("keeps stable slugs and makes pro_ai the only AI catalog tier", () => {
    expect(migration).toContain("where slug in ('basic', 'pro', 'pro_ai')");
    expect(migration).toContain("'ai.staff_assistant', true");
    expect(migration).toContain("'ai.managed', true");
    expect(migration).toContain("'ai.byok', true");
    expect(migration).toMatch(/when 'pro_ai'[\s\S]+else jsonb_build_object\([\s\S]+?'ai_assistant', false/);
    expect(migration).toContain("when 'pro' then 'Professional'");
    expect(migration).toContain("when 'pro_ai' then 'Pro + AI'");
  });

  it("stores manual add-on and contracted-overage terms without payment data", () => {
    expect(migration).toContain("create table public.ai_commercial_terms");
    expect(migration).toContain("overage_mode in ('hard_cap', 'contracted')");
    expect(migration).toContain("ai_commercial_terms_overage_shape");
    expect(migration).not.toMatch(/card_number|payment_method_id|provider_customer_id/i);
  });

  it("enforces subscription, mode, concurrency, and cost pool in SQL", () => {
    expect(migration).toContain("plan.slug = 'pro_ai'");
    expect(migration).toContain("AI_PROVIDER_MODE_NOT_ENTITLED");
    expect(migration).toContain("AI_BUDGET_CONCURRENCY_EXCEEDED");
    expect(migration).toContain("resolve_ai_commercial_limits");
    expect(migration).toContain("ai.hybrid_fallback");
  });

  it("keeps commercial reporting aggregate-only and content-free", () => {
    expect(migration).toContain("operator_ai_usage_report");
    expect(migration).toContain("sum(event.final_cost_micros)");
    expect(migration).not.toMatch(/operator_ai_usage_report[\s\S]+?(prompt|completion|patient_name|message_body)/i);
  });

  it("classifies included, add-on, overage, BYOK, and failed attempts", () => {
    for (const disposition of [
      "managed_included",
      "managed_addon",
      "managed_overage",
      "byok_provider_direct",
      "nonbillable_failed",
    ]) {
      expect(migration).toContain(`'${disposition}'`);
    }
    expect(migration).toContain(
      "billing_disposition in ('managed_included', 'managed_addon', 'managed_overage')",
    );
  });
});
