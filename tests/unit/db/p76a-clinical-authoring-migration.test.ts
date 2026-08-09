import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql"),
  "utf8",
);

describe("P7-6A clinical authoring migration", () => {
  it("creates every approved clinical and catalog table with RLS", () => {
    for (const table of [
      "drug_catalog", "drug_catalog_departments", "lab_test_catalog",
      "lab_test_catalog_departments", "prescriptions", "prescription_medications",
      "lab_requests", "lab_request_tests", "sick_leaves",
    ]) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("adds clinician credentials and the medical-note appointment link additively", () => {
    for (const column of ["professional_license_no", "specialty", "professional_title", "signature_path"]) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toContain("add column if not exists appointment_id uuid");
    expect(sql).toContain("medical_notes_appointment_id_fkey");
  });

  it("enforces ownership, tenant references, lifecycle locking, and audit", () => {
    expect(sql).toContain("created_by = auth.uid()");
    expect(sql).toContain("responsible_doctor_id");
    expect(sql).toContain("create or replace function public.validate_document_tenant_references()");
    expect(sql).toContain("FINALIZED_CLINICAL_RECORD_IMMUTABLE");
    expect(sql).toContain("CLINICAL_LINE_ITEMS_LOCKED");
    expect(sql).toContain("trg_audit_prescriptions");
    expect(sql).toContain("trg_audit_lab_requests");
    expect(sql).toContain("trg_audit_sick_leaves");
  });

  it("keeps signature assets private and self/admin scoped", () => {
    expect(sql).toContain("clinic_assets_select_own_signature");
    expect(sql).toContain("clinic_assets_insert_own_signature");
    expect(sql).toContain("public.auth_role() = 'doctor'::public.user_role");
    expect(sql).not.toContain("bucket_id = 'clinic-assets'\n  and public");
  });
});
