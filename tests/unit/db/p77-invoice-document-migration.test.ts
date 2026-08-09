import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260802140000_p77_invoice_document.sql"),
  "utf8",
);

describe("P7-7 Invoice document migration", () => {
  it("keeps reprint Invoice-only, clinic-scoped, canonical, and append-only", () => {
    const reprint = sql.slice(
      sql.indexOf("create or replace function public.record_invoice_document_reprint"),
    );

    expect(reprint).toContain("v_clinic_id uuid := public.auth_clinic_id()");
    expect(reprint).toContain("d.clinic_id = v_clinic_id");
    expect(reprint).toContain("d.doc_type = 'INVOICE'");
    expect(reprint).toContain("set print_count = d.print_count + 1");
    expect(reprint).toContain("'reprinted'");
    expect(reprint).toContain("v_document.pdf_storage_path");
    expect(reprint).not.toContain("update storage.objects");
    expect(reprint).not.toContain("delete from");
  });

  it("restricts reprint to the operational roles and authenticated callers only", () => {
    expect(sql).toContain("DOCUMENT_REPRINT_NOT_AUTHENTICATED");
    expect(sql).toContain("'admin'::public.user_role");
    expect(sql).toContain("'manager'::public.user_role");
    expect(sql).toContain("'receptionist'::public.user_role");
    expect(sql).toContain("grant execute on function public.record_invoice_document_reprint(uuid) to authenticated");
    expect(sql).toContain("revoke all on function public.record_invoice_document_reprint(uuid) from public, anon");
  });

  it("does not redefine the shared public verification boundary", () => {
    expect(sql).not.toContain("create or replace function public.verify_document_token");
  });
});
