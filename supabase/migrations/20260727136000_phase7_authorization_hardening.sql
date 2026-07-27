-- Phase 7: final authorization and integrity hardening.
--
-- This migration closes direct-database gaps found during the Phases 1-6
-- regression review. It adds no product capability:
--   * page/report customization remains primary-admin-only at the RLS layer;
--   * denormalized permission rows are bound to the target user's real clinic;
--   * assistant supervision links are same-clinic, role-valid, and replaced
--     transactionally with at least one active doctor;
--   * assistant patient-bound AI conversations are permitted only for patients
--     visible through the assistant's scoped patient RLS.

-- ---------------------------------------------------------------------------
-- Per-user page/report permission tenant integrity + primary-admin-only writes
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_page_permissions_user_clinic_fk'
  ) then
    alter table public.user_page_permissions
      add constraint user_page_permissions_user_clinic_fk
      foreign key (user_id, clinic_id)
      references public.profiles (id, clinic_id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_report_permissions_user_clinic_fk'
  ) then
    alter table public.user_report_permissions
      add constraint user_report_permissions_user_clinic_fk
      foreign key (user_id, clinic_id)
      references public.profiles (id, clinic_id)
      on delete cascade;
  end if;
end;
$$;

drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Primary admin can manage clinic page permissions"
on public.user_page_permissions
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.is_primary_clinic_admin(clinic_id, auth.uid())
  and not public.is_primary_clinic_admin(clinic_id, user_id)
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.is_primary_clinic_admin(clinic_id, auth.uid())
  and not public.is_primary_clinic_admin(clinic_id, user_id)
);

drop policy if exists "Admins can manage clinic report permissions"
  on public.user_report_permissions;
create policy "Primary admin can manage clinic report permissions"
on public.user_report_permissions
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.is_primary_clinic_admin(clinic_id, auth.uid())
  and not public.is_primary_clinic_admin(clinic_id, user_id)
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.is_primary_clinic_admin(clinic_id, auth.uid())
  and not public.is_primary_clinic_admin(clinic_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Assistant supervision link invariants and atomic replacement
-- ---------------------------------------------------------------------------

create or replace function public.validate_assistant_doctor_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id = new.assistant_id
      and p.clinic_id = new.clinic_id
      and p.role = 'assistant'::public.user_role
      and p.is_deleted = false
      and p.deleted_at is null
  ) then
    raise exception 'Invalid assistant assignment target'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = new.doctor_id
      and p.clinic_id = new.clinic_id
      and p.role = 'doctor'::public.user_role
      and p.is_active = true
      and p.is_deleted = false
      and p.deleted_at is null
  ) then
    raise exception 'Invalid supervising doctor'
      using errcode = '23514';
  end if;

  if new.created_by is not null and not exists (
    select 1
    from public.profiles p
    where p.id = new.created_by
      and p.clinic_id = new.clinic_id
  ) then
    raise exception 'Assignment actor is outside the clinic'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_assistant_doctor_assignment()
  from public;

drop trigger if exists validate_assistant_doctor_assignment
  on public.assistant_doctor_assignments;
create trigger validate_assistant_doctor_assignment
before insert or update on public.assistant_doctor_assignments
for each row
execute function public.validate_assistant_doctor_assignment();

-- Assignment writes are deliberately RPC-only. The earlier broad management
-- policy allowed authenticated managers to issue partial deletes/inserts that
-- could bypass the non-empty-set invariant enforced by the replacement RPC.
drop policy if exists "admin_manager_manage_assignments"
  on public.assistant_doctor_assignments;

create or replace function public.replace_assistant_doctor_assignments(
  p_assistant_id uuid,
  p_doctor_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_target_role public.user_role;
  v_doctor_ids uuid[];
  v_valid_count integer;
begin
  if v_actor_id is null or v_clinic_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_role <> all (
    array['admin'::public.user_role, 'manager'::public.user_role]
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select p.role
  into v_target_role
  from public.profiles p
  where p.id = p_assistant_id
    and p.clinic_id = v_clinic_id
    and p.is_deleted = false
    and p.deleted_at is null;

  if v_target_role is null then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct doctor_id), array[]::uuid[])
  into v_doctor_ids
  from unnest(coalesce(p_doctor_ids, array[]::uuid[])) as doctor_id
  where doctor_id is not null;

  if v_target_role <> 'assistant'::public.user_role then
    if cardinality(v_doctor_ids) <> 0 then
      raise exception 'Only assistants can have supervising doctors'
        using errcode = '23514';
    end if;

    delete from public.assistant_doctor_assignments
    where clinic_id = v_clinic_id
      and assistant_id = p_assistant_id;
    return;
  end if;

  if cardinality(v_doctor_ids) = 0 then
    raise exception 'An assistant requires at least one supervising doctor'
      using errcode = '23514';
  end if;

  select count(*)::integer
  into v_valid_count
  from public.profiles p
  where p.id = any (v_doctor_ids)
    and p.clinic_id = v_clinic_id
    and p.role = 'doctor'::public.user_role
    and p.is_active = true
    and p.is_deleted = false
    and p.deleted_at is null;

  if v_valid_count <> cardinality(v_doctor_ids) then
    raise exception 'One or more supervising doctors are invalid'
      using errcode = '23514';
  end if;

  delete from public.assistant_doctor_assignments
  where clinic_id = v_clinic_id
    and assistant_id = p_assistant_id;

  insert into public.assistant_doctor_assignments (
    clinic_id,
    assistant_id,
    doctor_id,
    created_by
  )
  select
    v_clinic_id,
    p_assistant_id,
    doctor_id,
    v_actor_id
  from unnest(v_doctor_ids) as doctor_id;
end;
$$;

revoke all on function public.replace_assistant_doctor_assignments(uuid, uuid[])
  from public;
grant execute on function public.replace_assistant_doctor_assignments(uuid, uuid[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- Reliable last-login tracking through the existing profile privilege guards
-- ---------------------------------------------------------------------------

create or replace function public.prevent_profile_self_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = ''
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
    if coalesce(
      current_setting('app.allow_profile_last_login_touch', true),
      ''
    ) = 'on'
      and new.last_login_at is distinct from old.last_login_at
      and new.id is not distinct from old.id
      and new.clinic_id is not distinct from old.clinic_id
      and new.department_id is not distinct from old.department_id
      and new.role is not distinct from old.role
      and new.is_active is not distinct from old.is_active
      and new.is_deleted is not distinct from old.is_deleted
      and new.deleted_at is not distinct from old.deleted_at
      and new.must_change_password is not distinct from old.must_change_password
      and new.created_at is not distinct from old.created_at
      and new.full_name is not distinct from old.full_name
      and new.phone is not distinct from old.phone
      and new.avatar_url is not distinct from old.avatar_url
      and new.display_currency is not distinct from old.display_currency
    then
      return new;
    end if;

    if coalesce(
      current_setting('app.allow_profile_password_flag_clear', true),
      ''
    ) = 'on'
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

    raise exception
      'Self-service profile updates cannot modify protected account fields'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function public.prevent_manager_profile_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if coalesce(
      current_setting('app.allow_profile_last_login_touch', true),
      ''
    ) = 'on'
      and old.id = auth.uid()
      and new.last_login_at is distinct from old.last_login_at
      and new.id is not distinct from old.id
      and new.clinic_id is not distinct from old.clinic_id
      and new.department_id is not distinct from old.department_id
      and new.role is not distinct from old.role
      and new.is_active is not distinct from old.is_active
      and new.is_deleted is not distinct from old.is_deleted
      and new.deleted_at is not distinct from old.deleted_at
      and new.must_change_password is not distinct from old.must_change_password
      and new.created_at is not distinct from old.created_at
      and new.full_name is not distinct from old.full_name
      and new.phone is not distinct from old.phone
      and new.avatar_url is not distinct from old.avatar_url
      and new.display_currency is not distinct from old.display_currency
    then
      return new;
    end if;

    if coalesce(
      current_setting('app.allow_profile_password_flag_clear', true),
      ''
    ) = 'on'
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
      or (
        new.must_change_password = false
        and old.must_change_password = true
      )
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

revoke all on function public.prevent_profile_self_privilege_update()
  from public;
revoke all on function public.prevent_manager_profile_privilege_update()
  from public;

create or replace function public.record_own_last_login()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  perform set_config('app.allow_profile_last_login_touch', 'on', true);

  update public.profiles
  set last_login_at = now()
  where id = v_actor_id
    and is_active = true
    and is_deleted = false
    and deleted_at is null;

  return found;
end;
$$;

revoke all on function public.record_own_last_login()
  from public;
grant execute on function public.record_own_last_login()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Analytics RPC role allowlist after introducing the assistant enum value
-- ---------------------------------------------------------------------------

create or replace function public.ai_assert_analytics_caller(
  p_scope text default 'operational'
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
begin
  if p_scope not in ('operational', 'clinic_analytics', 'financial') then
    raise exception 'Unsupported analytics scope' using errcode = '22023';
  end if;

  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_scope = 'operational' then
    if v_role <> all (
      array[
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role
      ]
    ) then
      raise exception 'Not authorized for operational analytics'
        using errcode = '42501';
    end if;
  elsif v_role <> all (
    array['admin'::public.user_role, 'manager'::public.user_role]
  ) then
    if p_scope = 'financial' then
      raise exception 'Not authorized for financial analytics'
        using errcode = '42501';
    end if;
    raise exception 'Not authorized for clinic analytics' using errcode = '42501';
  end if;

  if not coalesce(
    public.effective_ai_feature(v_clinic_id, 'ai.staff_analytics'), false
  ) then
    raise exception 'AI analytics not entitled for this clinic'
      using errcode = '42501';
  end if;

  if p_scope = 'financial' then
    if not coalesce(
      public.effective_ai_feature(v_clinic_id, 'ai.financial_insights'), false
    ) then
      raise exception 'Financial AI not entitled for this clinic'
        using errcode = '42501';
    end if;

    if v_role <> 'admin'::public.user_role
       and not exists (
         select 1
         from public.user_ai_permissions as grant_row
         where grant_row.user_id = auth.uid()
           and grant_row.clinic_id = v_clinic_id
           and grant_row.permission_key = 'ai.financial_insights'
           and grant_row.granted
       )
    then
      raise exception 'Financial AI permission not granted for this user'
        using errcode = '42501';
    end if;
  end if;

  return v_clinic_id;
end;
$$;

revoke all on function public.ai_assert_analytics_caller(text) from public;
grant execute on function public.ai_assert_analytics_caller(text)
  to authenticated;

comment on function public.ai_assert_analytics_caller(text) is
  'Shared guard for P4.6 analytics RPCs. Uses explicit role allowlists so newly '
  'introduced roles fail closed; also enforces entitlements and financial grants.';

-- ---------------------------------------------------------------------------
-- Assistant-owned AI conversations, including scoped patient launchers
-- ---------------------------------------------------------------------------

drop policy if exists "agent_owner_all_conversations"
  on public.agent_conversations;
create policy "agent_owner_all_conversations"
on public.agent_conversations
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'doctor'::public.user_role,
      'receptionist'::public.user_role,
      'assistant'::public.user_role
    ]
  )
  and (
    patient_id is null
    or (
      public.auth_role() = any (
        array['doctor'::public.user_role, 'assistant'::public.user_role]
      )
      and exists (
        select 1
        from public.patients p
        where p.id = agent_conversations.patient_id
          and p.clinic_id = agent_conversations.clinic_id
          and p.is_deleted = false
          and p.deleted_at is null
      )
    )
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'doctor'::public.user_role,
      'receptionist'::public.user_role,
      'assistant'::public.user_role
    ]
  )
  and (
    patient_id is null
    or (
      public.auth_role() = any (
        array['doctor'::public.user_role, 'assistant'::public.user_role]
      )
      and exists (
        select 1
        from public.patients p
        where p.id = agent_conversations.patient_id
          and p.clinic_id = agent_conversations.clinic_id
          and p.is_deleted = false
          and p.deleted_at is null
      )
    )
  )
);
