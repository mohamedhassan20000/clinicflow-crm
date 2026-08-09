import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(),
  "supabase/migrations/20260801150000_p75_roster_profile_document_batch.sql"), "utf8");

describe("P7-5 roster/profile document migration", () => {
  it("limits canonical reprints to the four P7-5 types and appends history", () => {
    for (const type of ["PATIENT_LIST_REPORT", "PATIENT_FILE", "SYSTEM_MEMBERS_REPORT", "STAFF_FILE"]) {
      expect(sql).toContain(`'${type}'`);
    }
    expect(sql).not.toContain("'PRESCRIPTION'");
    expect(sql).not.toContain("'INVOICE'");
    expect(sql).toContain("d.clinic_id = v_clinic_id");
    expect(sql).toContain("set print_count = d.print_count + 1");
    expect(sql).toContain("'reprinted'");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).not.toContain("delete from");
  });

  it("keeps staff documents manager-only while patient documents reuse scoped operational roles", () => {
    expect(sql).toContain("v_document.doc_type in ('SYSTEM_MEMBERS_REPORT', 'STAFF_FILE')");
    expect(sql).toContain("'admin'::public.user_role, 'manager'::public.user_role");
    expect(sql).toContain("v_document.doc_type in ('PATIENT_LIST_REPORT', 'PATIENT_FILE')");
    expect(sql).toContain("'assistant'::public.user_role");
  });
});
