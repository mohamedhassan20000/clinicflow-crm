import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511143000_harden_file_delete_and_note_trash.sql",
  ),
  "utf8",
);

describe("file delete and medical note trash migration", () => {
  it("adds medical note trash support without exposing deleted notes", () => {
    expect(migration).toContain("add column if not exists deleted_at");
    expect(migration).toContain("medical_notes_active_patient_created_idx");
    expect(migration).toContain("medical_notes_select_role_scoped");
    expect(migration).toContain("deleted_at is null");
  });

  it("allows document and attachment restore updates through scoped policies", () => {
    expect(migration).toContain("patient_documents_update_staff");
    expect(migration).toContain("medical_note_attachments_update_role_scoped");
    expect(migration).toContain("clinic_id = public.auth_clinic_id()");
    expect(migration).toContain("not p.is_deleted");
  });
});
