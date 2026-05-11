import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511200000_allow_receptionist_patient_soft_delete.sql",
  ),
  "utf8",
);

describe("patient soft-delete receptionist RPC migration", () => {
  it("keeps the security-definer patient soft-delete RPC scoped to clinic metadata", () => {
    expect(migration).toContain(
      "create or replace function public.soft_delete_patient",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
    expect(migration).toContain("p.clinic_id = v_clinic_id");
    expect(migration).toContain("is_deleted = true");
  });

  it("allows only admin and receptionist roles to execute the soft-delete", () => {
    expect(migration).toContain("'admin'::public.user_role");
    expect(migration).toContain("'receptionist'::public.user_role");
    expect(migration).not.toContain("'manager'::public.user_role");
    expect(migration).not.toContain("'doctor'::public.user_role");
  });

  it("does not permanently delete related records or storage objects", () => {
    expect(migration).not.toContain("delete from");
    expect(migration).not.toContain("storage.objects");
    expect(migration).not.toContain("patient_documents");
    expect(migration).not.toContain("medical_note_attachments");
  });
});
