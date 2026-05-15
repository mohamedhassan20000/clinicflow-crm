-- Allow the forced password-change RPC to clear must_change_password for managers.
-- The direct manager profile guard still blocks manager-initiated flag clears.

create or replace function public.prevent_manager_profile_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if coalesce(current_setting('app.allow_profile_password_flag_clear', true), '') = 'on'
      and old.id = auth.uid()
      and old.must_change_password = true
      and new.must_change_password = false
      and new.id is not distinct from old.id
      and new.clinic_id is not distinct from old.clinic_id
      and new.department_id is not distinct from old.department_id
      and new.role is not distinct from old.role
      and new.is_active is not distinct from old.is_active
      and new.is_deleted is not distinct from old.is_deleted
      and new.deleted_at is not distinct from old.deleted_at
      and new.created_at is not distinct from old.created_at
      and new.last_login_at is not distinct from old.last_login_at
    then
      return new;
    end if;

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
revoke all on function public.prevent_manager_profile_privilege_update() from public;
