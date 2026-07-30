-- Record appointment reversals as reversals, never as ordinary status changes
-- or delete/recreate noise. Existing activity rows and action identifiers stay
-- unchanged; undo operations append a new semantic event that points back to
-- the action it reverses when that event is available.

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

  -- Only the validated SECURITY DEFINER undo RPCs set this transaction-local
  -- context. It permits their otherwise reverse-only state transition while
  -- leaving the normal transition graph unchanged.
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

create or replace function public.record_activity_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_is_system boolean := (auth.uid() is null);
  v_role public.user_role;
  v_entity_type text;
  v_clinic uuid;
  v_entity_id uuid;
  v_patient uuid;
  v_doctor uuid;
  v_action text;
  v_prev jsonb;
  v_new jsonb;
  v_metadata jsonb := '{}'::jsonb;
  v_undo_action text :=
    nullif(current_setting('clinic_crm.activity_undo_action', true), '');
  v_original_action text;
  v_original_event_id uuid;
begin
  if not v_is_system then
    select p.role into v_role from public.profiles p where p.id = v_actor;
  end if;

  if tg_table_name = 'appointments' then
    v_entity_type := 'appointment';
    v_entity_id := coalesce(new.id, old.id);
    v_clinic := coalesce(new.clinic_id, old.clinic_id);
    v_patient := coalesce(new.patient_id, old.patient_id);
    v_doctor := coalesce(new.doctor_id, old.doctor_id);

    if tg_op = 'INSERT' then
      v_action := 'appointment.created';
    elsif tg_op = 'DELETE' then
      v_action := 'appointment.deleted';
    elsif v_undo_action is not null then
      v_action := v_undo_action;
      v_original_action := case old.status
        when 'confirmed' then 'appointment.confirmed'
        when 'arrived' then 'appointment.checked_in'
        when 'in_session' then 'appointment.session_started'
        when 'completed' then 'appointment.completed'
        when 'cancelled' then 'appointment.cancelled'
        when 'no_show' then 'appointment.no_show'
        when 'replaced' then 'appointment.replaced'
        else 'appointment.status_changed'
      end;

      select event.id
      into v_original_event_id
      from public.activity_events event
      where event.clinic_id = v_clinic
        and event.entity_type = 'appointment'
        and event.entity_id = v_entity_id
        and event.action = v_original_action
      order by event.occurred_at desc, event.id desc
      limit 1;

      v_metadata := jsonb_strip_nulls(jsonb_build_object(
        'operation', 'undo',
        'original_event_id', v_original_event_id,
        'original_action', v_original_action,
        'target_status', new.status
      ));
    elsif new.status is distinct from old.status then
      v_action := case new.status
        when 'confirmed' then 'appointment.confirmed'
        when 'arrived' then 'appointment.checked_in'
        when 'in_session' then 'appointment.session_started'
        when 'completed' then 'appointment.completed'
        when 'cancelled' then 'appointment.cancelled'
        when 'no_show' then 'appointment.no_show'
        when 'replaced' then 'appointment.replaced'
        else 'appointment.status_changed'
      end;
    elsif new.scheduled_at is distinct from old.scheduled_at then
      v_action := 'appointment.rescheduled';
    elsif (new.deleted_at is not null) and (old.deleted_at is null) then
      v_action := 'appointment.trashed';
    elsif (new.deleted_at is null) and (old.deleted_at is not null) then
      v_action := 'appointment.restored';
    else
      v_action := 'appointment.updated';
    end if;

    v_prev := case when tg_op = 'INSERT' then null else jsonb_build_object(
      'status', old.status,
      'scheduled_at', old.scheduled_at,
      'doctor_id', old.doctor_id,
      'duration_minutes', old.duration_minutes,
      'total_amount', old.total_amount,
      'paid_amount', old.paid_amount,
      'outstanding_amount', old.outstanding_amount,
      'deleted_at', old.deleted_at
    ) end;
    v_new := case when tg_op = 'DELETE' then null else jsonb_build_object(
      'status', new.status,
      'scheduled_at', new.scheduled_at,
      'doctor_id', new.doctor_id,
      'duration_minutes', new.duration_minutes,
      'total_amount', new.total_amount,
      'paid_amount', new.paid_amount,
      'outstanding_amount', new.outstanding_amount,
      'deleted_at', new.deleted_at
    ) end;

  elsif tg_table_name = 'follow_ups' then
    v_entity_type := 'follow_up';
    v_entity_id := coalesce(new.id, old.id);
    v_clinic := coalesce(new.clinic_id, old.clinic_id);
    v_patient := coalesce(new.patient_id, old.patient_id);

    select a.doctor_id into v_doctor from public.appointments a
      where a.id = coalesce(new.appointment_id, old.appointment_id);
    if v_doctor is null then
      select p.assigned_doctor_id into v_doctor from public.patients p
        where p.id = v_patient;
    end if;

    if tg_op = 'INSERT' then
      v_action := 'follow_up.recorded';
    elsif tg_op = 'DELETE' then
      v_action := 'follow_up.deleted';
    elsif new.outcome is distinct from old.outcome then
      v_action := 'follow_up.outcome_changed';
    else
      v_action := 'follow_up.updated';
    end if;

    v_prev := case when tg_op = 'INSERT' then null else jsonb_build_object(
      'outcome', old.outcome,
      'appointment_id', old.appointment_id,
      'recorded_at', old.recorded_at
    ) end;
    v_new := case when tg_op = 'DELETE' then null else jsonb_build_object(
      'outcome', new.outcome,
      'appointment_id', new.appointment_id,
      'recorded_at', new.recorded_at
    ) end;
  else
    return coalesce(new, old);
  end if;

  insert into public.activity_events (
    clinic_id, actor_id, actor_role, is_system, action,
    entity_type, entity_id, patient_id, doctor_id,
    previous_state, new_state, metadata
  ) values (
    v_clinic, v_actor, v_role, v_is_system, v_action,
    v_entity_type, v_entity_id, v_patient, v_doctor,
    v_prev, v_new, v_metadata
  );

  return coalesce(new, old);
end;
$$;

alter function public.record_activity_event() owner to postgres;
revoke all on function public.record_activity_event() from public, anon, authenticated;
grant execute on function public.record_activity_event() to service_role;

create or replace function public.undo_appointment_status(
  p_appointment_id uuid,
  p_target_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_appt public.appointments%rowtype;
  v_undo_action text;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array[
    'admin'::public.user_role,
    'receptionist'::public.user_role,
    'manager'::public.user_role
  ]) then
    raise exception 'Not authorized to undo appointment status'
      using errcode = '42501';
  end if;

  if p_target_status <> all (array['pending', 'confirmed', 'arrived', 'in_session']) then
    raise exception 'Target status must be pending, confirmed, arrived, or in_session'
      using errcode = '23514';
  end if;

  select * into v_appt
  from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_appt.status = 'completed'::public.appointment_status then
    raise exception 'Use undo_appointment_billing to undo a completed appointment'
      using errcode = '23514';
  end if;

  if v_appt.status = 'arrived'::public.appointment_status
    and p_target_status <> 'confirmed'
  then
    raise exception 'Arrived appointments can only be undone to confirmed'
      using errcode = '23514';
  end if;

  if v_appt.status = 'in_session'::public.appointment_status
    and p_target_status <> 'arrived'
  then
    raise exception 'In-session appointments can only be undone to arrived'
      using errcode = '23514';
  end if;

  if v_appt.status in (
      'pending'::public.appointment_status,
      'confirmed'::public.appointment_status
    )
    and p_target_status <> all (array['pending', 'confirmed'])
  then
    raise exception 'Pending or confirmed appointments can only be undone to pending or confirmed'
      using errcode = '23514';
  end if;

  v_undo_action := case v_appt.status
    when 'confirmed' then 'appointment.confirmation_undone'
    when 'arrived' then 'appointment.check_in_undone'
    when 'in_session' then 'appointment.session_start_undone'
    when 'cancelled' then 'appointment.cancellation_undone'
    when 'no_show' then 'appointment.no_show_undone'
    when 'replaced' then 'appointment.replacement_undone'
    else 'appointment.status_undone'
  end;
  perform set_config('clinic_crm.activity_undo_action', v_undo_action, true);

  delete from public.appointment_services
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.follow_ups
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.outstanding_settlements
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.appointments
  set status = p_target_status::public.appointment_status,
      updated_by = v_actor_id,
      updated_at = now(),
      cancellation_reason = null,
      cancelled_at = null,
      cancelled_by = null,
      no_show_reason = null,
      no_showed_at = null,
      no_showed_by = null,
      payment_method = null,
      secondary_payment_method = null,
      payment_note = null,
      paid_at = null,
      total_amount = null,
      paid_amount = null,
      insurance_amount = null,
      secondary_amount = 0,
      deposit_amount = 0,
      outstanding_amount = null
  where id = p_appointment_id
    and clinic_id = v_clinic_id;
end;
$$;

create or replace function public.apply_appointment_billing_undo(
  p_appointment_id uuid,
  p_target_status text,
  p_reverse_previous_settlements boolean
)
returns table (
  reversed_amount numeric,
  affected_prior_appointment_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_appt public.appointments%rowtype;
  v_settlement record;
  v_reversed numeric := 0;
  v_affected uuid[] := array[]::uuid[];
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array[
    'admin'::public.user_role,
    'receptionist'::public.user_role,
    'manager'::public.user_role
  ]) then
    raise exception 'Only admins, receptionists, and managers can undo appointment billing'
      using errcode = '42501';
  end if;

  if p_target_status <> all (array['pending', 'confirmed', 'arrived', 'in_session']) then
    raise exception 'Billing can only be undone to pending, confirmed, arrived, or in_session'
      using errcode = '23514';
  end if;

  select * into v_appt
  from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id
  for update;

  if not found then
    raise exception 'Appointment not found' using errcode = '23514';
  end if;

  if v_appt.status <> 'completed'::public.appointment_status then
    raise exception 'Only completed appointments can have billing undone'
      using errcode = '23514';
  end if;

  if p_reverse_previous_settlements then
    for v_settlement in
      select id, appointment_id, amount
      from public.outstanding_settlements
      where clinic_id = v_clinic_id
        and source_appointment_id = p_appointment_id
      order by settled_at asc, id asc
      for update
    loop
      if v_settlement.appointment_id is null then
        raise exception 'Cannot reverse settlement without appointment link'
          using errcode = '23514';
      end if;

      perform 1
      from public.appointments
      where id = v_settlement.appointment_id
        and clinic_id = v_clinic_id
      for update;

      if not found then
        raise exception 'Prior appointment not found for settlement reversal'
          using errcode = '23514';
      end if;

      update public.appointments
      set outstanding_amount = round(
            coalesce(outstanding_amount, 0) + round(v_settlement.amount, 2),
            2
          ),
          updated_at = now()
      where id = v_settlement.appointment_id
        and clinic_id = v_clinic_id;

      v_reversed := round(v_reversed + round(v_settlement.amount, 2), 2);
      if not v_settlement.appointment_id = any(v_affected) then
        v_affected := array_append(v_affected, v_settlement.appointment_id);
      end if;
    end loop;

    delete from public.outstanding_settlements
    where clinic_id = v_clinic_id
      and source_appointment_id = p_appointment_id;
  end if;

  delete from public.appointment_services
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.follow_ups
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  update public.outstanding_settlements
  set appointment_id = null
  where appointment_id = p_appointment_id
    and clinic_id = v_clinic_id;

  perform set_config(
    'clinic_crm.activity_undo_action',
    'appointment.billing_completion_undone',
    true
  );

  update public.appointments
  set status = p_target_status::public.appointment_status,
      updated_by = v_actor_id,
      updated_at = now(),
      payment_method = null,
      secondary_payment_method = null,
      payment_note = null,
      paid_at = null,
      total_amount = null,
      paid_amount = null,
      insurance_amount = null,
      secondary_amount = 0,
      deposit_amount = 0,
      outstanding_amount = null
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  reversed_amount := v_reversed;
  affected_prior_appointment_ids := v_affected;
  return next;
end;
$$;

revoke all on function public.apply_appointment_billing_undo(
  uuid, text, boolean
) from public, anon, authenticated;

create or replace function public.undo_appointment_billing(
  p_appointment_id uuid,
  p_target_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform *
  from public.apply_appointment_billing_undo(
    p_appointment_id,
    p_target_status,
    false
  );
end;
$$;

create or replace function public.undo_appointment_billing_with_previous_settlement(
  p_appointment_id uuid,
  p_target_status text
)
returns table (
  reversed_amount numeric,
  affected_prior_appointment_ids uuid[]
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.apply_appointment_billing_undo(
    p_appointment_id,
    p_target_status,
    true
  );
$$;

revoke all on function public.undo_appointment_status(uuid, text)
  from public, anon;
revoke all on function public.undo_appointment_billing(uuid, text)
  from public, anon;
revoke all on function public.undo_appointment_billing_with_previous_settlement(uuid, text)
  from public, anon;

grant execute on function public.undo_appointment_status(uuid, text)
  to authenticated, service_role;
grant execute on function public.undo_appointment_billing(uuid, text)
  to authenticated, service_role;
grant execute on function public.undo_appointment_billing_with_previous_settlement(uuid, text)
  to authenticated, service_role;
