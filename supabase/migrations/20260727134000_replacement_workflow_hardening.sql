-- Phase 6 hardening: make replacement chains race-safe and internally
-- consistent, and grant doctors the narrowly scoped Replace operation promised
-- by the approved architecture without granting them general appointment writes.

-- One appointment may have exactly one immediate predecessor and one immediate
-- successor. These indexes also close the concurrent A -> B / A -> C race.
create unique index if not exists appointments_replaces_once_idx
  on public.appointments (replaces_appointment_id)
  where replaces_appointment_id is not null;

create unique index if not exists appointments_replaced_by_once_idx
  on public.appointments (replaced_by_appointment_id)
  where replaced_by_appointment_id is not null;

alter table public.appointments
  drop constraint if exists appointments_replacement_not_self,
  add constraint appointments_replacement_not_self check (
    id is distinct from replaces_appointment_id
    and id is distinct from replaced_by_appointment_id
    and id is distinct from original_appointment_id
  );

-- Validate the completed transaction, not the intermediate INSERT-before-UPDATE
-- state inside replace_appointment. This prevents cross-clinic/cross-patient
-- links, half chains, wrong roots, and client-forged terminal `replaced` rows.
create or replace function public.enforce_appointment_replacement_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous public.appointments%rowtype;
  v_next public.appointments%rowtype;
  v_root public.appointments%rowtype;
begin
  if new.status = 'replaced'::public.appointment_status
    and new.replaced_by_appointment_id is null
  then
    raise exception 'A replaced appointment must have a successor'
      using errcode = 'check_violation';
  end if;

  if new.replaces_appointment_id is null then
    if new.original_appointment_id is not null then
      raise exception 'A replacement-chain root cannot point at another root'
        using errcode = 'check_violation';
    end if;
  else
    select *
    into v_previous
    from public.appointments
    where id = new.replaces_appointment_id;

    if not found
      or v_previous.clinic_id <> new.clinic_id
      or v_previous.patient_id <> new.patient_id
      or v_previous.replaced_by_appointment_id is distinct from new.id
      or v_previous.status <> 'replaced'::public.appointment_status
    then
      raise exception 'Invalid replacement predecessor link'
        using errcode = 'check_violation';
    end if;

    if new.original_appointment_id is distinct from
      coalesce(v_previous.original_appointment_id, v_previous.id)
    then
      raise exception 'Invalid replacement chain root'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.replaced_by_appointment_id is not null then
    select *
    into v_next
    from public.appointments
    where id = new.replaced_by_appointment_id;

    if not found
      or v_next.clinic_id <> new.clinic_id
      or v_next.patient_id <> new.patient_id
      or v_next.replaces_appointment_id is distinct from new.id
      or v_next.original_appointment_id is distinct from
        coalesce(new.original_appointment_id, new.id)
    then
      raise exception 'Invalid replacement successor link'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.original_appointment_id is not null then
    select *
    into v_root
    from public.appointments
    where id = new.original_appointment_id;

    if not found
      or v_root.clinic_id <> new.clinic_id
      or v_root.patient_id <> new.patient_id
      or v_root.original_appointment_id is not null
      or v_root.replaces_appointment_id is not null
    then
      raise exception 'Invalid replacement chain root appointment'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_appointment_replacement_chain() from public;

drop trigger if exists trg_appointments_replacement_chain
  on public.appointments;
create constraint trigger trg_appointments_replacement_chain
after insert or update on public.appointments
deferrable initially deferred
for each row execute function public.enforce_appointment_replacement_chain();

-- SECURITY DEFINER is deliberate and narrow. Doctors remain read-only for all
-- general appointment INSERT/UPDATE paths; this function re-derives role,
-- clinic, and doctor scope and exposes only the atomic Replace operation.
create or replace function public.replace_appointment(
  p_original_id uuid,
  p_scheduled_at timestamptz,
  p_doctor_id uuid default null,
  p_duration_minutes integer default null,
  p_department_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_orig public.appointments%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_root uuid;
  v_doctor uuid;
  v_duration integer;
  v_department uuid;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array[
    'admin'::public.user_role,
    'receptionist'::public.user_role,
    'manager'::public.user_role,
    'doctor'::public.user_role,
    'assistant'::public.user_role
  ]) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Serialize competing replacements of the same original.
  select *
  into v_orig
  from public.appointments
  where id = p_original_id
    and clinic_id = v_clinic_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_orig.status not in (
    'pending'::public.appointment_status,
    'confirmed'::public.appointment_status
  ) or v_orig.replaced_by_appointment_id is not null then
    raise exception 'Only a pending or confirmed appointment can be replaced'
      using errcode = 'check_violation';
  end if;

  if v_orig.scheduled_at <= now() or p_scheduled_at <= now() then
    raise exception 'Only a future appointment can be replaced'
      using errcode = 'check_violation';
  end if;

  v_root := coalesce(v_orig.original_appointment_id, v_orig.id);
  v_doctor := coalesce(p_doctor_id, v_orig.doctor_id);
  v_duration := coalesce(p_duration_minutes, v_orig.duration_minutes);
  v_department := coalesce(p_department_id, v_orig.department_id);

  if v_duration <> all (array[15, 30, 45, 60, 90, 120]) then
    raise exception 'Invalid appointment duration' using errcode = '22023';
  end if;

  -- Doctors can replace only their own appointment and cannot transfer it to a
  -- different doctor. Assistants may replace/transfer only inside their active
  -- supervised-doctor union.
  if v_role = 'doctor'::public.user_role
    and (v_orig.doctor_id <> v_actor_id or v_doctor <> v_actor_id)
  then
    raise exception 'Doctor replacement scope denied' using errcode = '42501';
  end if;

  if v_role = 'assistant'::public.user_role
    and (
      v_orig.doctor_id <> all (public.auth_supervised_doctor_ids())
      or v_doctor <> all (public.auth_supervised_doctor_ids())
    )
  then
    raise exception 'Assistant replacement scope denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = v_doctor
      and p.clinic_id = v_clinic_id
      and p.role = 'doctor'::public.user_role
      and p.is_active
      and not p.is_deleted
      and p.deleted_at is null
      and (
        v_department is null
        or p.department_id is null
        or p.department_id = v_department
      )
  ) then
    raise exception 'Replacement doctor is unavailable'
      using errcode = '23514';
  end if;

  -- Re-check the canonical 15-minute availability buffer in the transaction.
  -- The original is excluded because this operation terminalizes it.
  if exists (
    select 1
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.doctor_id = v_doctor
      and a.id <> v_orig.id
      and a.deleted_at is null
      and a.status in (
        'confirmed'::public.appointment_status,
        'arrived'::public.appointment_status,
        'in_session'::public.appointment_status
      )
      and p_scheduled_at <
        a.scheduled_at
        + make_interval(mins => a.duration_minutes + 15)
      and p_scheduled_at + make_interval(mins => v_duration + 15)
        > a.scheduled_at
  ) then
    raise exception 'Replacement slot is unavailable'
      using errcode = 'unique_violation';
  end if;

  insert into public.appointments (
    id, clinic_id, patient_id, doctor_id, scheduled_at, duration_minutes,
    department_id, notes, insurance_provider_id, package_id,
    package_session_number, status, created_by,
    replaces_appointment_id, original_appointment_id
  )
  values (
    v_new_id, v_orig.clinic_id, v_orig.patient_id, v_doctor, p_scheduled_at,
    v_duration, v_department, coalesce(p_notes, v_orig.notes),
    v_orig.insurance_provider_id, v_orig.package_id,
    v_orig.package_session_number, 'confirmed'::public.appointment_status,
    v_actor_id, p_original_id, v_root
  );

  update public.appointments
  set status = 'replaced'::public.appointment_status,
      replaced_by_appointment_id = v_new_id,
      updated_by = v_actor_id,
      updated_at = now()
  where id = p_original_id;

  return v_new_id;
end;
$$;

revoke all on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) from public;
grant execute on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) to authenticated;

-- Follow links, rather than sorting by scheduled_at: a replacement may move an
-- appointment earlier, so schedule order is not chain order.
drop function if exists public.get_appointment_replacement_chain(uuid);
create function public.get_appointment_replacement_chain(p_appointment_id uuid)
returns table (
  id uuid,
  status public.appointment_status,
  scheduled_at timestamptz,
  doctor_id uuid,
  doctor_name text,
  replaces_appointment_id uuid,
  replaced_by_appointment_id uuid,
  chain_position integer
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive target as (
    select coalesce(a.original_appointment_id, a.id) as root
    from public.appointments a
    where a.id = p_appointment_id
  ),
  chain as (
    select a.*, 1 as position
    from public.appointments a, target
    where a.id = target.root

    union all

    select successor.*, chain.position + 1
    from chain
    join public.appointments successor
      on successor.replaces_appointment_id = chain.id
  )
  select
    chain.id,
    chain.status,
    chain.scheduled_at,
    chain.doctor_id,
    doctor.full_name as doctor_name,
    chain.replaces_appointment_id,
    chain.replaced_by_appointment_id,
    chain.position::integer as chain_position
  from chain
  left join public.profiles doctor on doctor.id = chain.doctor_id
  order by chain.position;
$$;

revoke all on function public.get_appointment_replacement_chain(uuid) from public;
grant execute on function public.get_appointment_replacement_chain(uuid)
to authenticated;
