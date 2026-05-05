-- Phase 5D: align settings RLS with manager permissions.
-- This migration is intentionally not applied automatically.

create or replace function public.prevent_manager_clinic_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if old.id <> public.auth_clinic_id()
      or new.id is distinct from old.id
      or new.is_active is distinct from old.is_active
      or new.reminder_lead_hours is distinct from old.reminder_lead_hours
      or new.working_hours_start is distinct from old.working_hours_start
      or new.working_hours_end is distinct from old.working_hours_end
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Managers cannot update protected clinic fields'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_manager_clinic_privilege_update on public.clinics;
create trigger prevent_manager_clinic_privilege_update
before update on public.clinics
for each row
execute function public.prevent_manager_clinic_privilege_update();

create or replace function public.prevent_manager_profile_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if old.clinic_id <> public.auth_clinic_id()
      or old.role = 'admin'::public.user_role
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

drop trigger if exists prevent_manager_profile_privilege_update on public.profiles;
create trigger prevent_manager_profile_privilege_update
before update on public.profiles
for each row
execute function public.prevent_manager_profile_privilege_update();

drop policy if exists "clinics_update_admin" on public.clinics;
drop policy if exists "clinics_update_admin_manager" on public.clinics;
create policy "clinics_update_admin_manager"
on public.clinics
for update
to authenticated
using (
  id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
)
with check (
  id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
);

drop policy if exists "departments_write_admin" on public.departments;
drop policy if exists "departments_write_admin_manager" on public.departments;
create policy "departments_write_admin_manager"
on public.departments
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
);

drop policy if exists "insurance_write_admin" on public.insurance_providers;
drop policy if exists "insurance_write_admin_manager" on public.insurance_providers;
create policy "insurance_write_admin_manager"
on public.insurance_providers
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
);

drop policy if exists "services_admin_write" on public.services;
drop policy if exists "services_write_admin_manager" on public.services;
create policy "services_write_admin_manager"
on public.services
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
);

drop policy if exists "profiles_update_manager_staff" on public.profiles;
drop policy if exists "profiles_insert_admin" on public.profiles;
drop policy if exists "profiles_insert_admin_manager" on public.profiles;
create policy "profiles_insert_admin_manager"
on public.profiles
for insert
to authenticated
with check (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    or (
      public.auth_role() = 'manager'::public.user_role
      and role <> 'admin'::public.user_role
    )
  )
);

create policy "profiles_update_manager_staff"
on public.profiles
for update
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'manager'::public.user_role
  and role <> 'admin'::public.user_role
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'manager'::public.user_role
  and role <> 'admin'::public.user_role
);

drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
drop policy if exists "Admins and managers can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Admins and managers can manage clinic page permissions"
on public.user_page_permissions
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    or (
      public.auth_role() = 'manager'::public.user_role
      and exists (
        select 1
        from public.profiles target
        where target.id = user_page_permissions.user_id
          and target.clinic_id = public.auth_clinic_id()
          and target.role <> 'admin'::public.user_role
      )
    )
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    or (
      public.auth_role() = 'manager'::public.user_role
      and exists (
        select 1
        from public.profiles target
        where target.id = user_page_permissions.user_id
          and target.clinic_id = public.auth_clinic_id()
          and target.role <> 'admin'::public.user_role
      )
    )
  )
);
