-- Medical note attachments: private note-scoped files with RLS mirroring note visibility.

create table if not exists public.medical_note_attachments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  note_id uuid not null references public.medical_notes(id) on delete cascade,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_path text not null unique,
  uploaded_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_note_attachments_file_name_present check (
    length(btrim(file_name)) between 1 and 255
  ),
  constraint medical_note_attachments_size_allowed check (
    size_bytes > 0 and size_bytes <= 10485760
  ),
  constraint medical_note_attachments_allowed_mime check (
    mime_type = any (
      array[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp'
      ]
    )
  ),
  constraint medical_note_attachments_storage_path_scoped check (
    storage_path ~* (
      '^medical-notes/' ||
      clinic_id::text ||
      '/' ||
      patient_id::text ||
      '/' ||
      note_id::text ||
      '/' ||
      id::text ||
      '\.[a-z0-9]+$'
    )
  )
);
create index if not exists medical_note_attachments_note_created_idx
on public.medical_note_attachments (
  clinic_id,
  patient_id,
  note_id,
  created_at desc
)
where deleted_at is null;
create index if not exists medical_note_attachments_uploaded_by_idx
on public.medical_note_attachments (clinic_id, uploaded_by, created_at desc)
where uploaded_by is not null;
alter table public.medical_note_attachments enable row level security;
create or replace function public.prevent_medical_note_attachment_identity_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.clinic_id is distinct from old.clinic_id
    or new.patient_id is distinct from old.patient_id
    or new.note_id is distinct from old.note_id
    or new.file_name is distinct from old.file_name
    or new.mime_type is distinct from old.mime_type
    or new.size_bytes is distinct from old.size_bytes
    or new.storage_path is distinct from old.storage_path
    or new.uploaded_by is distinct from old.uploaded_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Medical note attachment identity fields cannot be updated'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke all on function public.prevent_medical_note_attachment_identity_update()
from public;
drop policy if exists "medical_note_attachments_select_role_scoped" on public.medical_note_attachments;
drop policy if exists "medical_note_attachments_insert_role_scoped" on public.medical_note_attachments;
drop policy if exists "medical_note_attachments_update_role_scoped" on public.medical_note_attachments;
drop policy if exists "medical_note_attachments_delete_role_scoped" on public.medical_note_attachments;
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
        public.auth_role() = 'admin'::public.user_role
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
create policy "medical_note_attachments_insert_role_scoped"
on public.medical_note_attachments
for insert
to authenticated
with check (
  clinic_id = public.auth_clinic_id()
  and deleted_at is null
  and uploaded_by = auth.uid()
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
create policy "medical_note_attachments_update_role_scoped"
on public.medical_note_attachments
for update
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
create policy "medical_note_attachments_delete_role_scoped"
on public.medical_note_attachments
for delete
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
);
drop trigger if exists trg_medical_note_attachments_immutable on public.medical_note_attachments;
create trigger trg_medical_note_attachments_immutable
before update on public.medical_note_attachments
for each row
execute function public.prevent_medical_note_attachment_identity_update();
drop trigger if exists trg_medical_note_attachments_updated_at on public.medical_note_attachments;
create trigger trg_medical_note_attachments_updated_at
before update on public.medical_note_attachments
for each row
execute function public.set_updated_at();
drop trigger if exists trg_audit_medical_note_attachments on public.medical_note_attachments;
create trigger trg_audit_medical_note_attachments
after insert or delete or update on public.medical_note_attachments
for each row
execute function public.write_audit_log();
grant all on table public.medical_note_attachments to authenticated;
grant all on table public.medical_note_attachments to service_role;
revoke all on table public.medical_note_attachments from anon;
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
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "patient_assets_medical_note_attachments_select" on storage.objects;
drop policy if exists "patient_assets_medical_note_attachments_insert" on storage.objects;
drop policy if exists "patient_assets_medical_note_attachments_delete" on storage.objects;
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
        public.auth_role() = 'admin'::public.user_role
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
create policy "patient_assets_medical_note_attachments_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'patient-assets'
  and name ~* '^medical-notes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'medical-notes'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and exists (
    select 1
    from public.medical_note_attachments a
    where a.storage_path = name
      and a.clinic_id = public.auth_clinic_id()
      and a.deleted_at is null
      and a.uploaded_by = auth.uid()
  )
);
create policy "patient_assets_medical_note_attachments_delete"
on storage.objects
for delete
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
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
      and (
        public.auth_role() = 'admin'::public.user_role
        or a.uploaded_by = auth.uid()
        or (
          public.auth_role() = 'doctor'::public.user_role
          and mn.created_by = auth.uid()
        )
      )
  )
);
