import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511190000_patient_soft_delete_rpc.sql",
  ),
  "utf8",
);

describe("patient soft-delete RPC migration", () => {
  it("adds a security-definer RPC for patient trash behavior", () => {
    expect(migration).toContain(
      "create or replace function public.soft_delete_patient",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
  });

  it("validates authenticated admin and clinic boundaries", () => {
    expect(migration).toContain("auth.uid()");
    expect(migration).toContain("public.auth_clinic_id()");
    expect(migration).toContain("public.auth_role()");
    expect(migration).toContain("v_role <> 'admin'::public.user_role");
    expect(migration).toContain("p.clinic_id = v_clinic_id");
  });

  it("soft-deletes only patient metadata and leaves related records intact", () => {
    expect(migration).toContain("set");
    expect(migration).toContain("is_deleted = true");
    expect(migration).toContain("updated_by = v_actor_id");
    expect(migration).not.toContain("delete from");
    expect(migration).not.toContain("storage.objects");
    expect(migration).not.toContain("medical_note_attachments");
    expect(migration).not.toContain("patient_documents");
  });
});
