import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260802160000_p712_patient_history_documents.sql",
  ),
  "utf8",
);

describe("P7-12 patient history reprint migration", () => {
  it("restricts the shared RPC to all four History & Financial types", () => {
    for (const code of [
      "APPOINTMENT_HISTORY_REPORT",
      "PACKAGE_HISTORY_REPORT",
      "DEPOSIT_STATEMENT",
      "PATIENT_FINANCIAL_SUMMARY",
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  it("returns the persisted canonical PDF path and rejects a missing path", () => {
    expect(sql).toContain("if v_document.pdf_storage_path is null then");
    expect(sql).toContain("DOCUMENT_PDF_UNAVAILABLE");
    expect(sql).toContain(
      "return query select v_document.pdf_storage_path, v_document.document_number, v_print_count",
    );
  });

  it("only increments print metadata and leaves issued identity/content immutable", () => {
    const update = sql.slice(
      sql.indexOf("update public.documents d"),
      sql.indexOf("insert into public.document_events"),
    );
    expect(update).toContain("set print_count = d.print_count + 1");
    expect(update).not.toContain("snapshot =");
    expect(update).not.toContain("pdf_storage_path =");
    expect(update).not.toContain("page_count =");
    expect(update).not.toContain("verification_token =");
    expect(sql).toContain("'reprinted'");
  });
});
