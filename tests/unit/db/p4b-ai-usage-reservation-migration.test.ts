import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260718170000_p4b_ai_usage_reservation.sql",
  ),
  "utf8",
);

describe("P4B AI usage reservation compensation migration", () => {
  it("atomically releases reserved usage without allowing underflow", () => {
    expect(migration).toContain("create or replace function public.release_usage");
    expect(migration).toContain("set used = greatest(used - p_amount, 0)");
    expect(migration).toContain("return coalesce(v_used, 0)");
  });

  it("keeps the compensation boundary service-role only", () => {
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
