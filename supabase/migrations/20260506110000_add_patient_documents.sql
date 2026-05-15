-- Phase 10A: patient document records and private storage policies.
-- This migration is intentionally not applied automatically.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'patient_document_category'
      and n.nspname = 'public'
  ) then
    create type public.patient_document_category as enum (
      'national_id',
      'insurance',
      'other'
    );
  end if;
end;
$$;
grant usage on type public.patient_document_category to authenticated;
grant usage on type public.patient_document_category to service_role;
revoke all on type public.patient_document_category from anon;
create table if not exists public.patient_documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  category public.patient_document_category not null,
  label text,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_path text not null unique,
  uploaded_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_documents_file_name_present check (
    length(btrim(file_name)) between 1 and 255
  ),
  constraint patient_documents_label_length check (
    label is null or length(btrim(label)) between 1 and 120
  ),
  constraint patient_documents_size_positive check (
    size_bytes > 0 and size_bytes <= 10485760
  ),
  constraint patient_documents_allowed_mime check (
    mime_type = any (
      array[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp'
      ]
    )
  ),
  constraint patient_documents_storage_path_scoped check (
    storage_path ~* (
      '^documents/' ||
      clinic_id::text ||
      '/' ||
      patient_id::text ||
      '/' ||
      category::text ||
      '/' ||
      id::text ||
      '\.[a-z0-9]+$'
    )
  )
);
create index if not exists patient_documents_patient_category_created_idx
on public.patient_documents (
  clinic_id,
  patient_id,
  category,
  created_at desc
)
where deleted_at is null;
create index if not exists patient_documents_uploaded_by_idx
on public.patient_documents (clinic_id, uploaded_by, created_at desc)
where uploaded_by is not null;
create unique index if not exists patient_documents_active_national_id_unique
on public.patient_documents (clinic_id, patient_id)
where category = 'national_id'::public.patient_document_category
  and deleted_at is null;
create unique index if not exists patient_documents_active_insurance_unique
on public.patient_documents (clinic_id, patient_id)
where category = 'insurance'::public.patient_document_category
  and deleted_at is null;
alter table public.patient_documents enable row level security;
create or replace function public.prevent_patient_document_identity_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.clinic_id is distinct from old.clinic_id
    or new.patient_id is distinct from old.patient_id
    or new.category is distinct from old.category
    or new.file_name is distinct from old.file_name
    or new.mime_type is distinct from old.mime_type
    or new.size_bytes is distinct from old.size_bytes
    or new.storage_path is distinct from old.storage_path
    or new.uploaded_by is distinct from old.uploaded_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Patient document identity fields cannot be updated'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke all on function public.prevent_patient_document_identity_update() from public;
drop policy if exists "patient_documents_select_staff" on public.patient_documents;
drop policy if exists "patient_documents_insert_staff" on public.patient_documents;
drop policy if exists "patient_documents_update_staff" on public.patient_documents;
drop policy if exists "patient_documents_delete_staff" on public.patient_documents;
create policy "patient_documents_select_staff"
on public.patient_documents
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and deleted_at is null
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
create policy "patient_documents_insert_staff"
on public.patient_documents
for insert
to authenticated
with check (
  clinic_id = public.auth_clinic_id()
  and deleted_at is null
  and (
    uploaded_by is null
    or uploaded_by = auth.uid()
  )
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
create policy "patient_documents_update_staff"
on public.patient_documents
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and deleted_at is null
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
drop trigger if exists trg_patient_documents_immutable on public.patient_documents;
create trigger trg_patient_documents_immutable
before update on public.patient_documents
for each row
execute function public.prevent_patient_document_identity_update();
drop trigger if exists trg_patient_documents_updated_at on public.patient_documents;
create trigger trg_patient_documents_updated_at
before update on public.patient_documents
for each row
execute function public.set_updated_at();
drop trigger if exists trg_audit_patient_documents on public.patient_documents;
create trigger trg_audit_patient_documents
after insert or delete or update on public.patient_documents
for each row
execute function public.write_audit_log();
grant all on table public.patient_documents to authenticated;
grant all on table public.patient_documents to service_role;
revoke all on table public.patient_documents from anon;
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
drop policy if exists "patient_assets_documents_select_staff" on storage.objects;
drop policy if exists "patient_assets_documents_insert_staff" on storage.objects;
drop policy if exists "patient_assets_documents_update_staff" on storage.objects;
drop policy if exists "patient_assets_documents_delete_staff" on storage.objects;
create policy "patient_assets_documents_select_staff"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(national_id|insurance|other)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patient_documents d
    join public.patients p on p.id = d.patient_id
    where d.storage_path = name
      and d.clinic_id = public.auth_clinic_id()
      and d.deleted_at is null
      and p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);
create policy "patient_assets_documents_insert_staff"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'patient-assets'
  and name ~* '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(national_id|insurance|other)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patient_documents d
    join public.patients p on p.id = d.patient_id
    where d.storage_path = name
      and d.clinic_id = public.auth_clinic_id()
      and d.deleted_at is null
      and p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);
create policy "patient_assets_documents_update_staff"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(national_id|insurance|other)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patient_documents d
    join public.patients p on p.id = d.patient_id
    where d.storage_path = name
      and d.clinic_id = public.auth_clinic_id()
      and d.deleted_at is null
      and p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
)
with check (
  bucket_id = 'patient-assets'
  and name ~* '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(national_id|insurance|other)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patient_documents d
    join public.patients p on p.id = d.patient_id
    where d.storage_path = name
      and d.clinic_id = public.auth_clinic_id()
      and d.deleted_at is null
      and p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);
create policy "patient_assets_documents_delete_staff"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'patient-assets'
  and name ~* '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(national_id|insurance|other)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
  and exists (
    select 1
    from public.patient_documents d
    join public.patients p on p.id = d.patient_id
    where d.storage_path = name
      and d.clinic_id = public.auth_clinic_id()
      and p.id = ((storage.foldername(name))[3])::uuid
      and p.clinic_id = public.auth_clinic_id()
      and not p.is_deleted
  )
);
