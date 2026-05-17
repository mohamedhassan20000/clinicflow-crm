-- Phase 7: allow receptionists to read and print medical notes for active
-- patients in their clinic. Mutation policies remain admin/doctor scoped.

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
        public.auth_role() = any (
          array['admin'::public.user_role, 'receptionist'::public.user_role]
        )
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

drop policy if exists "medical_note_attachments_select_role_scoped" on public.medical_note_attachments;
create policy "medical_note_attachments_select_role_scoped"
on public.medical_note_attachments
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and deleted_at is null
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
        public.auth_role() = any (
          array['admin'::public.user_role, 'receptionist'::public.user_role]
        )
        or (
          public.auth_role() = 'doctor'::public.user_role
          and (
            mn.doctor_id = auth.uid()
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

drop policy if exists "patient_assets_medical_note_attachments_select" on storage.objects;
create policy "patient_assets_medical_note_attachments_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^medical-notes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'medical-notes'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and exists (
    select 1
    from public.medical_note_attachments a
    join public.medical_notes mn on mn.id = a.note_id
    join public.patients p on p.id = a.patient_id
    where a.storage_path = name
      and a.clinic_id = public.auth_clinic_id()
      and a.deleted_at is null
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = any (
          array['admin'::public.user_role, 'receptionist'::public.user_role]
        )
        or (
          public.auth_role() = 'doctor'::public.user_role
          and (
            mn.doctor_id = auth.uid()
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
