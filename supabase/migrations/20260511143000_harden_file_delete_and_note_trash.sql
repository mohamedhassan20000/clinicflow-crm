-- Harden document/attachment delete flows and add medical note trash support.
-- Logical deletes keep private storage objects available for restore/trash flows.

alter table public.medical_notes
add column if not exists deleted_at timestamptz;

create index if not exists medical_notes_active_patient_created_idx
on public.medical_notes (patient_id, created_at desc)
where deleted_at is null;

drop policy if exists "medical_notes_select_role_scoped" on public.medical_notes;
create policy "medical_notes_select_role_scoped"
on public.medical_notes
for select
to authenticated
using (
  deleted_at is null
  and exists (
    select 1
    from public.patients p
    where p.id = medical_notes.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or (
          public.auth_role() = 'doctor'::public.user_role
          and (
            medical_notes.doctor_id = auth.uid()
            or p.assigned_doctor_id = auth.uid()
            or (
              public.auth_department_id() is not null
              and p.department_id = public.auth_department_id()
            )
          )
        )
      )
  )
);

drop policy if exists "patient_documents_update_staff" on public.patient_documents;
create policy "patient_documents_update_staff"
on public.patient_documents
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = patient_documents.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = patient_documents.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);

drop policy if exists "medical_note_attachments_update_role_scoped" on public.medical_note_attachments;
create policy "medical_note_attachments_update_role_scoped"
on public.medical_note_attachments
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1
    from public.medical_notes mn
    join public.patients p on p.id = mn.patient_id
    where mn.id = medical_note_attachments.note_id
      and mn.patient_id = medical_note_attachments.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and p.id = medical_note_attachments.patient_id
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or uploaded_by = auth.uid()
        or (
          public.auth_role() = 'doctor'::public.user_role
          and mn.created_by = auth.uid()
        )
      )
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1
    from public.medical_notes mn
    join public.patients p on p.id = mn.patient_id
    where mn.id = medical_note_attachments.note_id
      and mn.patient_id = medical_note_attachments.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and p.id = medical_note_attachments.patient_id
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or uploaded_by = auth.uid()
        or (
          public.auth_role() = 'doctor'::public.user_role
          and mn.created_by = auth.uid()
        )
      )
  )
);
