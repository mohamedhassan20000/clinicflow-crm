-- OVERDUE_PENDING remains a derived operational state. This migration only
-- extends the existing audited status transition so staff can explicitly mark
-- an overdue pending appointment as no-show. Future/current pending rows remain
-- protected at the database boundary.

create or replace function public.enforce_appointment_transition()
returns trigger
language plpgsql
as $$
declare
  v_undo_action text :=
    nullif(current_setting('clinic_crm.activity_undo_action', true), '');
begin
  if old.status = new.status then
    return new;
  end if;

  if v_undo_action in (
    'appointment.confirmation_undone',
    'appointment.check_in_undone',
    'appointment.session_start_undone',
    'appointment.billing_completion_undone',
    'appointment.cancellation_undone',
    'appointment.no_show_undone',
    'appointment.replacement_undone',
    'appointment.status_undone'
  ) then
    return new;
  end if;

  if old.status = 'pending'::public.appointment_status
    and new.status in (
      'confirmed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'replaced'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'pending'::public.appointment_status
    and new.status = 'no_show'::public.appointment_status
    and old.deleted_at is null
    and old.displaced_at is null
    and old.replaced_by_appointment_id is null
    and old.scheduled_at + pg_catalog.make_interval(
      mins => greatest(coalesce(old.duration_minutes, 0), 0)
    ) < pg_catalog.now()
  then
    return new;
  end if;

  if old.status = 'confirmed'::public.appointment_status
    and new.status in (
      'arrived'::public.appointment_status,
      'completed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status,
      'replaced'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'arrived'::public.appointment_status
    and new.status in (
      'in_session'::public.appointment_status,
      'completed'::public.appointment_status,
      'confirmed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'in_session'::public.appointment_status
    and new.status in (
      'completed'::public.appointment_status,
      'arrived'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status
    )
  then
    return new;
  end if;

  raise exception 'Invalid appointment status transition: % -> %', old.status, new.status
    using errcode = 'check_violation';
end;
$$;

revoke all on function public.enforce_appointment_transition() from public, anon;

comment on function public.enforce_appointment_transition() is
  'Allows pending -> no_show only after the authoritative scheduled end; OVERDUE_PENDING itself is never persisted.';

-- Keep the existing atomic Replace workflow and authorization model, while
-- allowing its original row to be a derived overdue-pending appointment. The
-- replacement itself must still be in the future. Active (started but not yet
-- ended) pending appointments and past confirmed appointments remain refused.
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
  v_original_overdue_pending boolean;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_role <> all (array[
    'admin'::public.user_role, 'receptionist'::public.user_role,
    'manager'::public.user_role, 'doctor'::public.user_role,
    'assistant'::public.user_role
  ]) then raise exception 'Not authorized' using errcode = '42501'; end if;

  select * into v_orig from public.appointments
  where id = p_original_id and clinic_id = v_clinic_id
    and deleted_at is null and displaced_at is null
  for update;
  if not found then raise exception 'Appointment not found' using errcode = '23514'; end if;
  if v_orig.status not in ('pending'::public.appointment_status,
                           'confirmed'::public.appointment_status)
     or v_orig.replaced_by_appointment_id is not null then
    raise exception 'Only a pending or confirmed appointment can be replaced'
      using errcode = 'check_violation';
  end if;
  v_original_overdue_pending :=
    v_orig.status = 'pending'::public.appointment_status
    and v_orig.scheduled_at + pg_catalog.make_interval(
      mins => greatest(coalesce(v_orig.duration_minutes, 0), 0)
    ) < pg_catalog.now();
  if p_scheduled_at <= pg_catalog.now()
     or (v_orig.scheduled_at <= pg_catalog.now() and not v_original_overdue_pending) then
    raise exception 'Only a future or overdue-pending appointment can be replaced'
      using errcode = 'check_violation';
  end if;

  v_root := coalesce(v_orig.original_appointment_id, v_orig.id);
  v_doctor := coalesce(p_doctor_id, v_orig.doctor_id);
  v_duration := coalesce(p_duration_minutes, v_orig.duration_minutes);
  v_department := coalesce(p_department_id, v_orig.department_id);
  if v_duration <> all (array[15, 30, 45, 60, 90, 120]) then
    raise exception 'Invalid appointment duration' using errcode = '22023';
  end if;
  if v_role = 'doctor'::public.user_role
     and (v_orig.doctor_id <> v_actor_id or v_doctor <> v_actor_id) then
    raise exception 'Doctor replacement scope denied' using errcode = '42501';
  end if;
  if v_role = 'assistant'::public.user_role and (
    v_orig.doctor_id <> all (public.auth_supervised_doctor_ids())
    or v_doctor <> all (public.auth_supervised_doctor_ids())
  ) then raise exception 'Assistant replacement scope denied' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_doctor
      and p.clinic_id = v_clinic_id and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
      and (v_department is null or p.department_id is null or p.department_id = v_department)
  ) then raise exception 'Replacement doctor is unavailable' using errcode = '23514'; end if;
  if exists (
    select 1 from public.appointments a
    where a.clinic_id = v_clinic_id and a.doctor_id = v_doctor and a.id <> v_orig.id
      and a.deleted_at is null
      and a.status in ('confirmed'::public.appointment_status,
                       'arrived'::public.appointment_status,
                       'in_session'::public.appointment_status)
      and p_scheduled_at < a.scheduled_at
        + pg_catalog.make_interval(mins => a.duration_minutes + 15)
      and p_scheduled_at + pg_catalog.make_interval(mins => v_duration + 15) > a.scheduled_at
  ) then raise exception 'Replacement slot is unavailable' using errcode = 'unique_violation'; end if;

  insert into public.appointments (
    id, clinic_id, patient_id, doctor_id, scheduled_at, duration_minutes,
    department_id, notes, insurance_provider_id, package_id,
    package_session_number, status, created_by,
    replaces_appointment_id, original_appointment_id
  ) values (
    v_new_id, v_orig.clinic_id, v_orig.patient_id, v_doctor, p_scheduled_at,
    v_duration, v_department, coalesce(p_notes, v_orig.notes),
    v_orig.insurance_provider_id, v_orig.package_id, v_orig.package_session_number,
    'confirmed'::public.appointment_status, v_actor_id, p_original_id, v_root
  );
  update public.appointments set status = 'replaced'::public.appointment_status,
    replaced_by_appointment_id = v_new_id, updated_by = v_actor_id,
    updated_at = pg_catalog.now() where id = p_original_id;
  return v_new_id;
end;
$$;

revoke all on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) from public;
grant execute on function public.replace_appointment(
  uuid, timestamptz, uuid, integer, uuid, text
) to authenticated;

comment on function public.replace_appointment(uuid, timestamptz, uuid, integer, uuid, text) is
  'Atomic replacement; original may be future-open or derived overdue-pending, replacement must be future.';
