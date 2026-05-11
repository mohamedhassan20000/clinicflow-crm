import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511120000_performance_phase1_indexes.sql",
  ),
  "utf8",
);

describe("performance phase 1 indexes migration", () => {
  it("adds additive indexes for appointment calendar and revenue filters", () => {
    expect(migration).toContain(
      "perf_appointments_clinic_status_paid_at_idx",
    );
    expect(migration).toContain("clinic_id, status, paid_at desc");
    expect(migration).toContain(
      "perf_appointments_clinic_doctor_scheduled_idx",
    );
    expect(migration).toContain("clinic_id, doctor_id, scheduled_at");
    expect(migration).toContain(
      "perf_appointments_clinic_department_scheduled_idx",
    );
    expect(migration).toContain("clinic_id, department_id, scheduled_at");
    expect(migration).toContain("where deleted_at is null");
  });

  it("adds additive indexes for outstanding balances and deposits", () => {
    expect(migration).toContain(
      "perf_outstanding_settlements_clinic_settled_at_idx",
    );
    expect(migration).toContain("clinic_id, settled_at desc");
    expect(migration).toContain(
      "perf_appointments_clinic_patient_outstanding_idx",
    );
    expect(migration).toContain("outstanding_amount > 0");
    expect(migration).toContain("perf_patient_deposits_clinic_patient_idx");
    expect(migration).toContain("patient_deposits (clinic_id, patient_id)");
  });

  it("adds trigram indexes for current patient text search behavior", () => {
    expect(migration).toContain("perf_patients_file_number_trgm_idx");
    expect(migration).toContain("file_number public.gin_trgm_ops");
    expect(migration).toContain("perf_patients_national_id_trgm_idx");
    expect(migration).toContain("national_id public.gin_trgm_ops");
    expect(migration).toContain("perf_patients_phone_trgm_idx");
    expect(migration).toContain("phone public.gin_trgm_ops");
  });
});
