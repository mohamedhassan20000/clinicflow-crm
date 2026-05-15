-- Phase 5 follow-up: close RLS gaps found by local security integration tests.
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
drop policy if exists "profiles_update_manager_staff" on public.profiles;
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
drop policy if exists "medical_notes_update_role_scoped" on public.medical_notes;
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
          and medical_notes.created_by = auth.uid()
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
          and medical_notes.created_by = auth.uid()
        )
      )
  )
);
drop policy if exists "medical_notes_delete_role_scoped" on public.medical_notes;
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
          and medical_notes.created_by = auth.uid()
        )
      )
  )
);
revoke all on function public.prevent_manager_profile_privilege_update() from public;
