-- Baseline app-owned storage setup.
-- Supabase local development manages the storage schema internals itself; this
-- migration keeps only project buckets and policies that belong to ClinicFlow.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values
  (
    'clinic-assets',
    'clinic-assets',
    true,
    52428800,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[]
  ),
  (
    'avatars',
    'avatars',
    true,
    52428800,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[]
  )
on conflict (id) do nothing;
drop policy if exists "avatars_owner_delete" on storage.objects;
drop policy if exists "avatars_owner_insert" on storage.objects;
drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_delete"
on storage.objects
for delete
using (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);
create policy "avatars_owner_insert"
on storage.objects
for insert
with check (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);
create policy "avatars_owner_update"
on storage.objects
for update
using (
  bucket_id = 'avatars'
  and auth.uid()::text = (storage.foldername(name))[1]
);
