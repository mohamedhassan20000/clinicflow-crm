-- Phase 5H: tighten generated grants and harden audit/auth helpers.
-- This migration is intentionally not applied automatically.

create or replace function public.auth_profile()
returns table(profile_id uuid, clinic_id uuid, role public.user_role)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.clinic_id, p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active = true
    and p.is_deleted = false
    and p.deleted_at is null
  limit 1;
$$;

create or replace function public.auth_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ap.clinic_id from public.auth_profile() ap;
$$;

create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select ap.role from public.auth_profile() ap;
$$;

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid;
  v_record_id uuid;
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
    v_record_id := old.id;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := new.id;
  else
    v_old := null;
    v_new := to_jsonb(new);
    v_record_id := new.id;
  end if;

  if coalesce(v_new, v_old) ? 'clinic_id' then
    v_clinic_id := nullif(coalesce(v_new->>'clinic_id', v_old->>'clinic_id'), '')::uuid;
  elsif tg_table_name = 'medical_notes' then
    select p.clinic_id
    into v_clinic_id
    from public.patients p
    where p.id = coalesce((v_new->>'patient_id')::uuid, (v_old->>'patient_id')::uuid);
  end if;

  insert into public.audit_logs (
    actor_id,
    clinic_id,
    action,
    table_name,
    record_id,
    old_data,
    new_data
  )
  values (
    v_actor_id,
    v_clinic_id,
    tg_op,
    tg_table_name,
    v_record_id,
    v_old,
    v_new
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public.auth_profile() from public;
revoke all on function public.auth_clinic_id() from public;
revoke all on function public.auth_role() from public;
grant execute on function public.auth_profile() to authenticated, service_role;
grant execute on function public.auth_clinic_id() to authenticated, service_role;
grant execute on function public.auth_role() to authenticated, service_role;

revoke all on function public.write_audit_log() from public;
revoke all on function public.enforce_appointment_transition() from public;
revoke all on function public.set_updated_at() from public;
revoke all on function public.touch_user_page_permissions_updated_at() from public;
revoke all on function public.prevent_profile_self_privilege_update() from public;
revoke all on function public.prevent_manager_clinic_privilege_update() from public;
revoke all on function public.prevent_manager_profile_privilege_update() from public;
revoke all on function public.enforce_appointment_reference_integrity() from public;

revoke all on table public.appointment_services from anon;
revoke all on table public.appointments from anon;
revoke all on table public.audit_logs from anon;
revoke all on table public.clinics from anon;
revoke all on table public.departments from anon;
revoke all on table public.feedback from anon;
revoke all on table public.follow_ups from anon;
revoke all on table public.insurance_providers from anon;
revoke all on table public.medical_notes from anon;
revoke all on table public.outstanding_settlements from anon;
revoke all on table public.patient_deposits from anon;
revoke all on table public.patients from anon;
revoke all on table public.profiles from anon;
revoke all on table public.services from anon;
revoke all on table public.staff_invitations from anon;
revoke all on table public.user_customizations from anon;
revoke all on table public.user_page_permissions from anon;

alter default privileges for role postgres in schema public
revoke all on tables from anon;
alter default privileges for role postgres in schema public
revoke all on functions from anon;
alter default privileges for role postgres in schema public
revoke all on sequences from anon;
