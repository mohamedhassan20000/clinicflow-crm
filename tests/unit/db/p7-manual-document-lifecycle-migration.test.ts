import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260808130000_p7_manual_qa_document_lifecycle.sql",
  ),
  "utf8",
);
const cancellationFixSql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260809120000_p7_cancel_document_rpc_fix.sql",
  ),
  "utf8",
);
const cancellationFunctionSql = cancellationFixSql.slice(
  cancellationFixSql.indexOf(
    "create or replace function public.cancel_issued_document",
  ),
);

describe("P7 Manual QA document lifecycle migration", () => {
  it("persists mutable Not Issued drafts outside the immutable issued ledger", () => {
    expect(sql).toContain("create table if not exists public.document_drafts");
    expect(sql).toContain("status text not null default 'not_issued'");
    expect(sql).toContain("issued_document_id uuid unique references public.documents");
    expect(sql).toContain("status = any (array['not_issued', 'issued', 'deleted'])");
    expect(sql).not.toMatch(/alter table public\.documents[\s\S]*snapshot\s+jsonb/);
  });

  it("does not backfill, delete, or rewrite issued rows when the migration is applied", () => {
    const migrationSetup = sql.split(
      "create or replace function public.cancel_issued_document",
    )[0];

    expect(migrationSetup).not.toMatch(/update\s+public\.documents/i);
    expect(migrationSetup).not.toMatch(/delete\s+from\s+public\.documents/i);
    expect(migrationSetup).not.toMatch(/insert\s+into\s+public\.documents/i);
  });

  it("allows only Issued → Cancelled and retains the immutable artifact", () => {
    expect(sql).toContain("if v_document.status <> 'issued'");
    expect(sql).toContain("set status = 'cancelled'");
    expect(sql).toContain("voided_by = v_actor_id");
    expect(sql).toContain("'cancelled', v_actor_id");
    expect(sql).toContain("'document.cancelled'");
    expect(sql).not.toMatch(/set[\s\S]{0,180}(snapshot|pdf_storage_path)\s*=/);
  });

  it("keeps cancelled documents visible and auditable through the existing tables", () => {
    expect(sql).toContain("insert into public.document_events");
    expect(sql).toContain("insert into public.activity_events");
    expect(sql).not.toContain("delete from public.documents");
  });

  it("repairs the real activity audit contract in a forward migration", () => {
    expect(cancellationFixSql).toContain(
      "create or replace function public.cancel_issued_document(p_document_id uuid)",
    );
    expect(cancellationFixSql).toContain(
      "returns table (document_id uuid, document_status text, cancelled_at timestamptz)",
    );
    expect(cancellationFixSql).toContain(
      "entity_id, patient_id, doctor_id, previous_state, new_state, metadata",
    );
    expect(cancellationFunctionSql).not.toMatch(/\bold_state\b/);
  });

  it("changes only cancellation lifecycle fields and appends both history events", () => {
    const update = cancellationFixSql.match(
      /update public\.documents d[\s\S]*?returning \* into v_document;/,
    )?.[0];

    expect(update).toBeDefined();
    expect(update).toContain("status = 'cancelled'");
    expect(update).toContain("voided_by = v_actor_id");
    expect(update).toContain("voided_at = now()");
    expect(update).not.toMatch(
      /document_number|snapshot|pdf_storage_path|verification_token|issued_at/,
    );
    expect(cancellationFixSql).toContain("insert into public.document_events");
    expect(cancellationFixSql).toContain("insert into public.activity_events");
  });
});
