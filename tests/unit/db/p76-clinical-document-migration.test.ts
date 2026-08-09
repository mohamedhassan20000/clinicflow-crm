import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(),
  "supabase/migrations/20260802130000_p76_clinical_documents.sql"), "utf8");

describe("P7-6 clinical document migration", () => {
  it("limits canonical reprint to the three clinical types and preserves scoped access", () => {
    for (const type of ["PRESCRIPTION", "LAB_REQUEST", "SICK_LEAVE_CERTIFICATE"]) {
      expect(sql).toContain(`'${type}'`);
    }
    expect(sql).not.toContain("'INVOICE'");
    expect(sql).toContain("public.can_access_clinical_record(");
    expect(sql).toContain("d.clinic_id = v_clinic_id");
    expect(sql).toContain("set print_count = d.print_count + 1");
    expect(sql).toContain("'reprinted'");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).not.toContain("delete from");
  });
});
