import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260801120000_p70_document_foundations.sql",
  ),
  "utf8",
);

describe("P7-0 document foundation migration", () => {
  it("creates all type-agnostic tables with RLS", () => {
    for (const table of [
      "documents",
      "document_events",
      "document_counters",
      "document_settings",
    ]) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("keeps numbering and issuance writes behind service-only RPCs", () => {
    expect(sql).toContain("create or replace function public.allocate_document_number");
    expect(sql).toContain("create or replace function public.reserve_document_issue");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(sql).toContain("unique (clinic_id, idempotency_key)");
    expect(sql).toMatch(/revoke all on function public\.reserve_document_issue[\s\S]*from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.reserve_document_issue[\s\S]*to service_role/);
  });

  it("hides partial issues and creates a private PDF bucket", () => {
    expect(sql).toContain("and status = any (array['issued', 'void', 'cancelled'])");
    expect(sql).toContain("'clinic-documents'");
    expect(sql).toContain("false,\n  26214400");
    expect(sql).not.toContain('for insert\nto authenticated');
  });

  it("adds and manager-protects every approved branding field", () => {
    for (const field of [
      "email",
      "website",
      "license_no",
      "tax_id",
      "document_footer",
      "branding_metadata",
    ]) {
      expect(sql).toContain(`new.${field} is distinct from old.${field}`);
    }
  });
});

