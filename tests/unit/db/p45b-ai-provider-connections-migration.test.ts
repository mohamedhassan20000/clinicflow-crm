import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260719130000_p45b_ai_provider_connections.sql",
  "utf8",
);

describe("P4.5B provider connection migration", () => {
  it("keeps credential-bearing tables service-only", () => {
    expect(migration).toContain("alter table public.ai_provider_connections enable row level security");
    expect(migration).toContain("revoke all on table public.ai_provider_connections from public, anon, authenticated");
    expect(migration).not.toMatch(/create policy[\s\S]{0,120}ai_provider_connections/i);
    expect(migration).toContain("credential_encrypted bytea");
  });

  it("enforces primary-admin lifecycle operations and destroys retired ciphertext", () => {
    expect(migration).toContain("assert_primary_ai_provider_admin");
    expect(migration).toMatch(/lifecycle_status = 'retired'[\s\S]{0,180}credential_encrypted = null|credential_encrypted = null[\s\S]{0,180}lifecycle_status = 'retired'/);
    expect(migration).toMatch(/lifecycle_status = 'revoked'[\s\S]{0,180}credential_encrypted = null|credential_encrypted = null[\s\S]{0,180}lifecycle_status = 'revoked'/);
    expect(migration).toContain("AI_PROVIDER_CONNECTION_ROTATED");
    expect(migration).toContain("AI_PROVIDER_CONNECTION_REVOKED");
  });

  it("requires persisted hybrid consent before a managed fallback audit", () => {
    expect(migration).toContain("hybrid_disclosure_version = 'p45b-hybrid-disclosure-v1'");
    expect(migration).toContain("reservation.credential_mode = 'hybrid'");
    expect(migration).toContain("AI_PROVIDER_HYBRID_POLICY_REQUIRED");
    expect(migration).toContain("AI_PROVIDER_HYBRID_FALLBACK");
  });

  it("prevents strict BYOK from charging managed credits", () => {
    expect(migration).toContain("AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN");
    expect(migration).toContain("p_managed_cost_micros");
    expect(migration).toContain("v_should_adjust := v_reservation.status = 'reserved'");
    expect(migration).toContain("byok_provider_direct");
  });

  it("re-derives the hybrid managed split in SQL instead of trusting the caller (L2)", () => {
    expect(migration).toContain("coalesce(sum(final_cost_micros), 0)");
    expect(migration).toContain("billing_disposition = 'managed_included'");
    expect(migration).toMatch(
      /v_reservation\.credential_mode = 'hybrid'[\s\S]{0,400}from public\.ai_usage_events/,
    );
    expect(migration).toContain("v_direct_cost_micros := p_actual_cost_micros - v_managed_cost_micros");
  });

  it("guards the P4.5B reserve/reconcile wrappers with their own service-role check (L3)", () => {
    const guardCount = (migration.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/g) ?? []).length;
    // assert_primary_ai_provider_admin, log_ai_provider_fallback, and both the
    // reserve and reconcile wrappers each carry a leading service-role check.
    expect(guardCount).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("AI_BUDGET_NOT_AUTHORIZED");
  });
});
