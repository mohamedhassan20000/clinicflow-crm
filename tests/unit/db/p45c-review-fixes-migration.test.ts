import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260719150000_p45c_review_fixes.sql",
  "utf8",
);

describe("P4.5C review-fixes migration", () => {
  it("re-derives the managed bucket from actual cost under a period lock", () => {
    // Correct-once at reconcile time from the real managed cost, not the
    // reserve-time worst-case estimate.
    expect(migration).toContain("v_period.spent_micros + p_managed_cost_micros");
    expect(migration).toContain("update public.ai_budget_reservations");
    expect(migration).toContain("set managed_billing_disposition = v_corrected_disposition");
    // Serialized on the clinic period so concurrent reconciliations read a
    // consistent cumulative managed spend.
    expect(migration).toMatch(/from public\.ai_budget_periods[\s\S]+?for update/);
  });

  it("only corrects on the first reconciliation and never updates events", () => {
    expect(migration).toContain("v_should_adjust := v_reservation.status = 'reserved'");
    expect(migration).toMatch(/if v_should_adjust[\s\S]+?p_managed_cost_micros > 0 then/);
    // The immutable ledger is written correct-once; there is no UPDATE against
    // ai_usage_events anywhere in the fix.
    expect(migration).not.toMatch(/update\s+public\.ai_usage_events/i);
  });

  it("documents that invoicing must use period aggregates, not event buckets", () => {
    expect(migration).toContain("ai_budget_periods.spent_micros");
    expect(migration).toMatch(/never the billed quantity|SOLE source of truth/);
  });
});
