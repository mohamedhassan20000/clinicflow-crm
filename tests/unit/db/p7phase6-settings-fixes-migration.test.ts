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
const phase0bMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260813130000_ai_entitlement_plan_decoupling.sql",
  ),
  "utf8",
);
const phase0bPatientAuto = phase0bMigration.slice(
  phase0bMigration.indexOf(
    "-- Re-evaluate the P7 designated patient-auto QA override",
  ),
);

describe("P7 Manual QA polish Phase 6 data migration", () => {
  it("preserves historical SQL and supersedes its tier gate in Phase 0b", () => {
    expect(migration).toContain("insert into public.clinic_feature_overrides");
    expect(migration).toContain("'ai.patient_auto'");
    expect(migration).toContain("caf2711f-97cb-4474-a103-f9505f467087");
    expect(migration).toMatch(/plan\.slug\s*=\s*'pro_ai'/);
    expect(migration).toMatch(/subscription\.status in \('active', 'trialing'\)/);
    expect(phase0bPatientAuto).toContain("public.effective_ai_feature");
    expect(phase0bPatientAuto).not.toMatch(/plan\.slug\s*=\s*'pro_ai'/);
  });

  it("is idempotent and keeps the canonical plan default fail-closed", () => {
    expect(migration).toMatch(/features\s*=\s*coalesce\(features/);
    expect(migration).toContain("'ai.patient_auto', false");
    expect(migration).toMatch(/on conflict \(clinic_id, feature_key\) do update/);
    expect(migration).not.toMatch(/delete\s+from|truncate|drop\s+/i);
  });
});
