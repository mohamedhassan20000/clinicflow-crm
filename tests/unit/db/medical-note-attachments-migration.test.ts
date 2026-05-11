import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511130000_add_medical_note_attachments.sql",
  ),
  "utf8",
);

describe("medical note attachments migration", () => {
  it("creates a private note-scoped attachment table with file validation", () => {
    expect(migration).toContain("create table if not exists public.medical_note_attachments");
    expect(migration).toContain("note_id uuid not null references public.medical_notes(id)");
    expect(migration).toContain("storage_path text not null unique");
    expect(migration).toContain("size_bytes > 0 and size_bytes <= 10485760");
    expect(migration).toContain("'application/pdf'");
    expect(migration).toContain("'image/jpeg'");
    expect(migration).toContain("'image/png'");
    expect(migration).toContain("'image/webp'");
    expect(migration).toContain("^medical-notes/");
  });

  it("enables RLS and mirrors medical note visibility for reads", () => {
    expect(migration).toContain(
      "alter table public.medical_note_attachments enable row level security",
    );
    expect(migration).toContain("medical_note_attachments_select_role_scoped");
    expect(migration).toContain("public.auth_role() = 'admin'::public.user_role");
    expect(migration).toContain("public.auth_role() = 'doctor'::public.user_role");
    expect(migration).toContain("p.assigned_doctor_id = auth.uid()");
    expect(migration).toContain("p.department_id = public.auth_department_id()");
  });

  it("adds private storage policies for medical note attachment paths", () => {
    expect(migration).toContain("public = false");
    expect(migration).toContain(
      "patient_assets_medical_note_attachments_select",
    );
    expect(migration).toContain(
      "patient_assets_medical_note_attachments_insert",
    );
    expect(migration).toContain(
      "patient_assets_medical_note_attachments_delete",
    );
    expect(migration).not.toContain("create policy \"patient_assets_medical_note_attachments_public");
  });
});
