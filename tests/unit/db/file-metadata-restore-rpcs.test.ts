import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511180000_file_metadata_restore_rpcs.sql",
  ),
  "utf8",
);

describe("file metadata restore RPC migration", () => {
  it("adds security-definer RPCs for patient document and note attachment undo", () => {
    expect(migration).toContain(
      "create or replace function public.restore_patient_document",
    );
    expect(migration).toContain(
      "create or replace function public.restore_medical_note_attachment",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
  });

  it("keeps restore scoped to authenticated clinic roles", () => {
    expect(migration).toContain("public.auth_clinic_id()");
    expect(migration).toContain("public.auth_role()");
    expect(migration).toContain("'admin'::public.user_role");
    expect(migration).toContain("'receptionist'::public.user_role");
    expect(migration).toContain("'doctor'::public.user_role");
    expect(migration).toContain("p.clinic_id = v_clinic_id");
    expect(migration).toContain("not p.is_deleted");
  });

  it("restores metadata idempotently without touching storage", () => {
    expect(migration).toContain("if v_deleted_at is null then");
    expect(migration).toContain("return true;");
    expect(migration).toContain("set deleted_at = null");
    expect(migration).not.toContain("storage.objects");
  });
});
