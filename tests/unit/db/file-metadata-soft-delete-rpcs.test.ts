import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511170000_file_metadata_soft_delete_rpcs.sql",
  ),
  "utf8",
);

describe("file metadata soft-delete RPC migration", () => {
  it("adds security-definer RPCs for patient documents and note attachments", () => {
    expect(migration).toContain(
      "create or replace function public.soft_delete_patient_document",
    );
    expect(migration).toContain(
      "create or replace function public.soft_delete_medical_note_attachment",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
  });

  it("validates authenticated clinic and role boundaries", () => {
    expect(migration).toContain("public.auth_clinic_id()");
    expect(migration).toContain("public.auth_role()");
    expect(migration).toContain("'admin'::public.user_role");
    expect(migration).toContain("'receptionist'::public.user_role");
    expect(migration).toContain("'doctor'::public.user_role");
    expect(migration).toContain("if not (v_role = any");
    expect(migration).toContain("p.clinic_id = v_clinic_id");
    expect(migration).toContain("not p.is_deleted");
  });

  it("soft-deletes metadata idempotently without storage deletion", () => {
    expect(migration).toContain("if v_deleted_at is not null then");
    expect(migration).toContain("return true;");
    expect(migration).toContain("set deleted_at = now()");
    expect(migration).not.toContain("storage.objects");
  });

  it("grants execute only to authenticated callers and service role", () => {
    expect(migration).toContain(
      "revoke all on function public.soft_delete_patient_document(uuid, uuid)",
    );
    expect(migration).toContain(
      "grant execute on function public.soft_delete_patient_document(uuid, uuid)",
    );
    expect(migration).toContain("to authenticated, service_role");
  });
});
