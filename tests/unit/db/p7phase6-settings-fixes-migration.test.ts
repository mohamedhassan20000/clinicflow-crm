import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260808120000_p7phase6_patient_ai_auto_entitlement.sql",
  ),
  "utf8",
);

describe("P7 Manual QA polish Phase 6 data migration", () => {
  it("enables patient auto replies only for the designated Pro + AI clinic", () => {
    expect(migration).toContain("insert into public.clinic_feature_overrides");
    expect(migration).toContain("'ai.patient_auto'");
    expect(migration).toContain("caf2711f-97cb-4474-a103-f9505f467087");
    expect(migration).toMatch(/plan\.slug = 'pro_ai'/);
    expect(migration).toMatch(/subscription\.status in \('active', 'trialing'\)/);
  });

  it("is idempotent and keeps the canonical plan default fail-closed", () => {
    expect(migration).toMatch(/features\s*=\s*coalesce\(features/);
    expect(migration).toContain("'ai.patient_auto', false");
    expect(migration).toMatch(/on conflict \(clinic_id, feature_key\) do update/);
    expect(migration).not.toMatch(/delete\s+from|truncate|drop\s+/i);
  });
});
