import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260813140000_ai_assistant_phase2_clinical_read_parity.sql",
  ),
  "utf8",
);
const medicalNotePolicy = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260519006000_medical_notes_reception_read.sql",
  ),
  "utf8",
);
const patientDocumentPolicy = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260506110000_add_patient_documents.sql",
  ),
  "utf8",
);
const patientDocumentActions = readFileSync(
  join(process.cwd(), "actions/patient-documents.ts"),
  "utf8",
);
const medicalNoteAttachmentActions = readFileSync(
  join(process.cwd(), "actions/medical-note-attachments.ts"),
  "utf8",
);

describe("Phase 2 clinical read parity migration", () => {
  it("does not replace the pre-existing medical-note or patient-document policies", () => {
    expect(migration).not.toContain(
      'drop policy if exists "medical_notes_select_role_scoped"',
    );
    expect(migration).not.toContain(
      'drop policy if exists "patient_documents_select_staff"',
    );
  });

  it("preserves the admin/receptionist patient-document matrix across actions, table RLS, and storage RLS", () => {
    expect(patientDocumentPolicy).toMatch(
      /create policy "patient_documents_select_staff"[\s\S]*?array\['admin'::public\.user_role, 'receptionist'::public\.user_role\]/,
    );
    expect(patientDocumentPolicy).toMatch(
      /create policy "patient_assets_documents_select_staff"[\s\S]*?array\['admin'::public\.user_role, 'receptionist'::public\.user_role\]/,
    );
    expect(patientDocumentActions.match(/PATIENT_DOCUMENT_READ_ROLES/g)).toHaveLength(6);
    expect(migration).toContain(
      "patient_assets_documents_select_staff remain unchanged",
    );
  });

  it("preserves the medical-note matrix for narrative, attachment metadata, storage, and action reads", () => {
    for (const policy of [
      "medical_notes_select_role_scoped",
      "medical_note_attachments_select_role_scoped",
      "patient_assets_medical_note_attachments_select",
    ]) {
      expect(medicalNotePolicy).toContain(`create policy "${policy}"`);
    }
    expect(medicalNotePolicy.match(/'manager'::public\.user_role/g)).toBeNull();
    expect(medicalNotePolicy.match(/'assistant'::public\.user_role/g)).toBeNull();
    expect(medicalNoteAttachmentActions.match(/MEDICAL_NOTE_READ_ROLES/g)).toHaveLength(3);
    expect(migration).toContain(
      "patient_assets_medical_note_attachments_select remain unchanged",
    );
  });

  it("narrows only patient-package SELECT and preserves mutation/business rules", () => {
    expect(migration).toContain(
      'drop policy if exists "clinic_members_read_packages"',
    );
    expect(migration.match(/for select/g)).toHaveLength(1);
    expect(migration.match(/public\.can_access_clinical_record\(/g)).toHaveLength(1);
    expect(migration).toContain("p.assigned_doctor_id");
    expect(migration).not.toMatch(/for (insert|update|delete|all)/i);
    expect(migration).not.toMatch(/create (or replace )?(function|trigger)/i);
    expect(migration).not.toMatch(/disable row level security/i);
  });

  it("keeps active-patient and soft-delete terms", () => {
    expect(migration.match(/not p\.is_deleted/g)).toHaveLength(1);
  });
});
