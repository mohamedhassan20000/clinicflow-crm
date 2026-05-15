-- Phase 5C: role- and author-scoped medical notes policies.
-- This migration is intentionally not applied automatically.

drop policy if exists "medical_notes_insert_admin" on public.medical_notes;
drop policy if exists "medical_notes_select_admin" on public.medical_notes;
drop policy if exists "medical_notes_select_role_scoped" on public.medical_notes;
drop policy if exists "medical_notes_insert_role_scoped" on public.medical_notes;
drop policy if exists "medical_notes_update_role_scoped" on public.medical_notes;
drop policy if exists "medical_notes_delete_role_scoped" on public.medical_notes;
create policy "medical_notes_select_role_scoped"
on public.medical_notes
for select
to authenticated
using (
  exists (
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
create policy "medical_notes_insert_role_scoped"
on public.medical_notes
for insert
to authenticated
with check (
  doctor_id = auth.uid()
  and created_by = auth.uid()
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
            p.assigned_doctor_id = auth.uid()
            or (
              public.auth_department_id() is not null
              and p.department_id = public.auth_department_id()
            )
          )
        )
      )
  )
);
create policy "medical_notes_update_role_scoped"
on public.medical_notes
for update
to authenticated
using (
  exists (
    select 1
    from public.patients p
    where p.id = medical_notes.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or (
          public.auth_role() = 'doctor'::public.user_role
          and medical_notes.doctor_id = auth.uid()
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.patients p
    where p.id = medical_notes.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or (
          public.auth_role() = 'doctor'::public.user_role
          and medical_notes.doctor_id = auth.uid()
        )
      )
  )
);
create policy "medical_notes_delete_role_scoped"
on public.medical_notes
for delete
to authenticated
using (
  exists (
    select 1
    from public.patients p
    where p.id = medical_notes.patient_id
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or (
          public.auth_role() = 'doctor'::public.user_role
          and medical_notes.doctor_id = auth.uid()
        )
      )
  )
);
