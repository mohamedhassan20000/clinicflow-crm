-- AI Assistant Phase 2 — clinical read parity without authorization grants.
--
-- The Assistant follows the application policies that predate this phase:
--   * medical_notes_select_role_scoped remains unchanged from
--     20260519006000_medical_notes_reception_read.sql (admin/receptionist and
--     scoped doctor; manager/assistant remain excluded).
--   * medical_note_attachments_select_role_scoped and
--     patient_assets_medical_note_attachments_select remain unchanged from the
--     same migration and use that identical role/scope matrix.
--   * patient_documents_select_staff and
--     patient_assets_documents_select_staff remain unchanged from
--     20260506110000_add_patient_documents.sql (admin/receptionist only).
--   * clinic_members_read_packages is narrowed below to active patients and
--     the existing clinical row predicate so non-AI patient/package consumers
--     cannot escape the patient scope already required by their entry paths.
--
-- No mutation or storage policy is broadened by this migration.

drop policy if exists "clinic_members_read_packages" on public.patient_packages;
create policy "clinic_members_read_packages"
on public.patient_packages
for select
to authenticated
using (
  exists (
    select 1
    from public.patients p
    where p.id = patient_packages.patient_id
      and p.clinic_id = patient_packages.clinic_id
      and not p.is_deleted
      and public.can_access_clinical_record(
        patient_packages.clinic_id,
        patient_packages.patient_id,
        p.assigned_doctor_id
      )
  )
);
