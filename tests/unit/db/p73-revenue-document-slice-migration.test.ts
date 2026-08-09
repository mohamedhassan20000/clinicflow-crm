import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260801130000_p73_revenue_document_slice.sql"),
  "utf8",
);

describe("P7-3 Revenue Report lifecycle migration", () => {
  it("exposes an enumeration-resistant five-field verification projection", () => {
    const verification = sql.slice(
      sql.indexOf("create or replace function public.verify_document_token"),
      sql.indexOf("create or replace function public.record_revenue_document_reprint"),
    );

    expect(verification).toContain("p_token ~ '^[0-9a-f]{32}$'");
    expect(verification).toContain("d.verification_token = p_token");
    expect(verification).toContain("d.status = any (array['issued', 'void', 'cancelled'])");
    expect(verification).toContain("grant execute on function public.verify_document_token(text) to anon, authenticated");
    expect(verification).not.toContain("snapshot");
    expect(verification).not.toContain("params");
    expect(verification).not.toContain("pdf_storage_path");
  });

  it("keeps reprint Revenue-only, clinic-scoped, canonical, and append-only", () => {
    const reprint = sql.slice(sql.indexOf("create or replace function public.record_revenue_document_reprint"));

    expect(reprint).toContain("v_clinic_id uuid := public.auth_clinic_id()");
    expect(reprint).toContain("d.clinic_id = v_clinic_id");
    expect(reprint).toContain("d.doc_type = 'REVENUE_REPORT'");
    expect(reprint).toContain("set print_count = d.print_count + 1");
    expect(reprint).toContain("'reprinted'");
    expect(reprint).toContain("v_document.pdf_storage_path");
    expect(reprint).not.toContain("update storage.objects");
    expect(reprint).not.toContain("delete from");
  });
});
