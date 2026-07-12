import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20260712150000_p15d_intl_ux_foundations.sql", "utf8");
describe("P1.5D migration contract", () => {
  it("adds preference, FX timestamps/RLS, and preserves invalid legacy phones", () => {
    expect(migration).toContain("display_currency");
    expect(migration).toContain("provider_timestamp timestamptz");
    expect(migration).toContain("fetched_at timestamptz");
    expect(migration).toContain("fx_rates_authenticated_read");
    expect(migration).toContain("fx_rates_platform_admin_write");
    expect(migration).toContain("return value;");
    expect(migration).toContain("phone_e164_valid");
    expect(migration).toContain("else null;");
    expect(migration).toContain("where p.clinic_id is null");
    expect(migration).toContain("p.phone is null or btrim(p.phone) = '' or btrim(p.phone) ~");
  });
});
