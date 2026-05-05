-- Phase 5A: critical profile and clinic-assets RLS lockdown.
-- This migration is intentionally not applied automatically.

create or replace function public.prevent_profile_self_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
    and old.id = auth.uid()
    and (
      new.id is distinct from old.id
      or new.clinic_id is distinct from old.clinic_id
      or new.department_id is distinct from old.department_id
      or new.role is distinct from old.role
      or new.is_active is distinct from old.is_active
      or new.is_deleted is distinct from old.is_deleted
      or new.deleted_at is distinct from old.deleted_at
      or new.must_change_password is distinct from old.must_change_password
      or new.last_login_at is distinct from old.last_login_at
      or new.created_at is distinct from old.created_at
    )
  then
    if coalesce(current_setting('app.allow_profile_password_flag_clear', true), '') = 'on'
      and old.must_change_password = true
      and new.must_change_password = false
      and new.id is not distinct from old.id
      and new.clinic_id is not distinct from old.clinic_id
      and new.department_id is not distinct from old.department_id
      and new.role is not distinct from old.role
      and new.is_active is not distinct from old.is_active
      and new.is_deleted is not distinct from old.is_deleted
      and new.deleted_at is not distinct from old.deleted_at
      and new.last_login_at is not distinct from old.last_login_at
      and new.created_at is not distinct from old.created_at
    then
      return new;
    end if;

    raise exception 'Self-service profile updates cannot modify protected account fields'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_profile_self_privilege_update on public.profiles;
create trigger prevent_profile_self_privilege_update
before update on public.profiles
for each row
execute function public.prevent_profile_self_privilege_update();

drop policy if exists "profiles_update_self" on public.profiles;

create policy "profiles_update_self_safe_fields"
on public.profiles
for update
to authenticated
using (
  id = auth.uid()
  and clinic_id = public.auth_clinic_id()
  and is_active = true
  and is_deleted = false
  and deleted_at is null
)
with check (
  id = auth.uid()
  and clinic_id = public.auth_clinic_id()
  and role = public.auth_role()
  and is_active = true
  and is_deleted = false
  and deleted_at is null
);

create or replace function public.clear_own_must_change_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform set_config('app.allow_profile_password_flag_clear', 'on', true);

  update public.profiles
  set
    must_change_password = false,
    updated_at = now()
  where id = auth.uid()
    and is_active = true
    and is_deleted = false
    and deleted_at is null
    and must_change_password = true;
end;
$$;

revoke all on function public.clear_own_must_change_password() from public;
grant execute on function public.clear_own_must_change_password() to authenticated;

drop policy if exists "Admin full access xr6sco_0" on storage.objects;
drop policy if exists "Admin full access xr6sco_1" on storage.objects;
drop policy if exists "Admin full access xr6sco_2" on storage.objects;
drop policy if exists "Admin full access xr6sco_3" on storage.objects;

create policy "clinic_assets_select_scoped"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'clinic-assets'
  and (
    (
      (storage.foldername(name))[1] = 'clinics'
      and (storage.foldername(name))[2] = public.auth_clinic_id()::text
    )
    or (
      (storage.foldername(name))[1] = 'staff'
      and (storage.foldername(name))[2] = public.auth_clinic_id()::text
      and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role])
    )
  )
);

create policy "clinic_assets_insert_admin_manager"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = any (array['clinics', 'staff'])
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role])
);

create policy "clinic_assets_update_admin_manager"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = any (array['clinics', 'staff'])
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role])
)
with check (
  bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = any (array['clinics', 'staff'])
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role])
);

create policy "clinic_assets_delete_admin_manager"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'clinic-assets'
  and (storage.foldername(name))[1] = any (array['clinics', 'staff'])
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and public.auth_role() = any (array['admin'::public.user_role, 'manager'::public.user_role])
);
