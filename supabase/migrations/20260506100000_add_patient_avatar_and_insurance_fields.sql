-- Phase 9A: patient avatar storage and patient insurance reference.
-- This migration is intentionally not applied automatically.

alter table public.patients
  add column if not exists insurance_provider_id uuid,
  add column if not exists avatar_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_insurance_provider_id_fkey'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table only public.patients
      add constraint patients_insurance_provider_id_fkey
      foreign key (insurance_provider_id)
      references public.insurance_providers(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists patients_insurance_provider_id_idx
on public.patients using btree (clinic_id, insurance_provider_id)
where is_deleted = false
  and insurance_provider_id is not null;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'patient-assets',
  'patient-assets',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "patient_assets_avatar_select_scoped" on storage.objects;
drop policy if exists "patient_assets_avatar_insert_staff" on storage.objects;
drop policy if exists "patient_assets_avatar_update_staff" on storage.objects;
drop policy if exists "patient_assets_avatar_delete_staff" on storage.objects;

create policy "patient_assets_avatar_select_scoped"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'avatars'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and exists (
    select 1
    from public.patients p
    where p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = any (
          array[
            'admin'::public.user_role,
            'receptionist'::public.user_role,
            'manager'::public.user_role
          ]
        )
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

create policy "patient_assets_avatar_insert_staff"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'patient-assets'
  and name ~* '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'avatars'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);

create policy "patient_assets_avatar_update_staff"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'avatars'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
)
with check (
  bucket_id = 'patient-assets'
  and name ~* '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'avatars'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);

create policy "patient_assets_avatar_delete_staff"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'avatars'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patients p
    where p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);
