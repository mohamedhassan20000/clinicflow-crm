-- Phase 5D follow-up: managers manage staff, not roles or visibility.
-- This migration is intentionally not applied automatically.

create or replace function public.prevent_manager_profile_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if old.clinic_id <> public.auth_clinic_id()
      or new.id is distinct from old.id
      or new.clinic_id is distinct from old.clinic_id
      or new.role is distinct from old.role
      or new.is_deleted is distinct from old.is_deleted
      or (new.must_change_password = false and old.must_change_password = true)
      or new.created_at is distinct from old.created_at
      or new.last_login_at is distinct from old.last_login_at
    then
      raise exception 'Managers cannot update protected staff profile fields'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;
drop policy if exists "profiles_update_manager_staff" on public.profiles;
create policy "profiles_update_manager_staff"
on public.profiles
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'manager'::public.user_role
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'manager'::public.user_role
);
drop policy if exists "Admins and managers can manage clinic page permissions"
  on public.user_page_permissions;
drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Admins can manage clinic page permissions"
on public.user_page_permissions
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.clinic_id = user_page_permissions.clinic_id
      and p.role = 'admin'::public.user_role
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.clinic_id = user_page_permissions.clinic_id
      and p.role = 'admin'::public.user_role
  )
);
