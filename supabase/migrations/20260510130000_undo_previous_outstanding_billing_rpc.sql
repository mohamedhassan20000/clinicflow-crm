create or replace function public.undo_appointment_billing_with_previous_settlement(
  p_appointment_id uuid,
  p_target_status text
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
  v_replacement public.appointments%rowtype;
  v_settlement record;
  v_reversed numeric := 0;
  v_affected uuid[] := array[]::uuid[];
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Only admins and receptionists can undo appointment billing'
      using errcode = '42501';
  end if;

  if p_target_status <> all (array['pending', 'confirmed']) then
    raise exception 'Billing can only be undone to pending or confirmed'
      using errcode = '23514';
  end if;

  select *
  into v_appt
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

  v_replacement := v_appt;
  v_replacement.status := p_target_status::public.appointment_status;
  v_replacement.updated_by := v_actor_id;
  v_replacement.updated_at := now();
  v_replacement.payment_method := null;
  v_replacement.secondary_payment_method := null;
  v_replacement.payment_note := null;
  v_replacement.paid_at := null;
  v_replacement.total_amount := null;
  v_replacement.paid_amount := null;
  v_replacement.insurance_amount := null;
  v_replacement.secondary_amount := 0;
  v_replacement.deposit_amount := 0;
  v_replacement.outstanding_amount := null;

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
    set outstanding_amount = round(coalesce(outstanding_amount, 0) + round(v_settlement.amount, 2), 2),
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

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments
  select (v_replacement).*;

  reversed_amount := v_reversed;
  affected_prior_appointment_ids := v_affected;
  return next;
end;
$$;

revoke all on function public.undo_appointment_billing_with_previous_settlement(uuid, text) from public;
grant execute on function public.undo_appointment_billing_with_previous_settlement(uuid, text) to authenticated;
