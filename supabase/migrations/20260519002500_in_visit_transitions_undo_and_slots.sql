create or replace function public.enforce_appointment_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status = 'pending'::public.appointment_status
    and new.status in (
      'confirmed'::public.appointment_status,
      'cancelled'::public.appointment_status
    )
  then
    return new;
  end if;

  if old.status = 'confirmed'::public.appointment_status
    and new.status in (
      'arrived'::public.appointment_status,
      'completed'::public.appointment_status,
      'cancelled'::public.appointment_status,
      'no_show'::public.appointment_status
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
  v_actor_id  uuid               := auth.uid();
  v_clinic_id uuid               := public.auth_clinic_id();
  v_role      public.user_role   := public.auth_role();
  v_appt      public.appointments%rowtype;
  v_rep       public.appointments%rowtype;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
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

  v_rep                       := v_appt;
  v_rep.status                := p_target_status::public.appointment_status;
  v_rep.updated_by            := v_actor_id;
  v_rep.updated_at            := now();
  v_rep.cancellation_reason   := null;
  v_rep.cancelled_at          := null;
  v_rep.cancelled_by          := null;
  v_rep.no_show_reason        := null;
  v_rep.no_showed_at          := null;
  v_rep.no_showed_by          := null;
  v_rep.payment_method        := null;
  v_rep.secondary_payment_method := null;
  v_rep.payment_note          := null;
  v_rep.paid_at               := null;
  v_rep.total_amount          := null;
  v_rep.paid_amount           := null;
  v_rep.insurance_amount      := null;
  v_rep.secondary_amount      := 0;
  v_rep.deposit_amount        := 0;
  v_rep.outstanding_amount    := null;

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

  perform set_config('clinic_crm.allow_appointment_delete_replacement', 'on', true);

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments select (v_rep).*;
end;
$$;

revoke all on function public.undo_appointment_status(uuid, text) from public;
grant execute on function public.undo_appointment_status(uuid, text)
  to authenticated, service_role;

create or replace function public.complete_appointment_billing(
  p_appointment_id uuid,
  p_line_items jsonb,
  p_paid_amount numeric,
  p_payment_method text,
  p_insurance_amount numeric default 0,
  p_secondary_payment_method text default null,
  p_secondary_amount numeric default 0,
  p_deposit_amount numeric default 0,
  p_payment_note text default null
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
  v_replacement public.appointments%rowtype;
  v_item jsonb;
  v_name text;
  v_service_id uuid;
  v_price numeric;
  v_quantity integer;
  v_total numeric := 0;
  v_paid numeric := round(coalesce(p_paid_amount, 0), 2);
  v_insurance numeric := round(coalesce(p_insurance_amount, 0), 2);
  v_secondary numeric := round(coalesce(p_secondary_amount, 0), 2);
  v_deposit numeric := round(coalesce(p_deposit_amount, 0), 2);
  v_collected numeric;
  v_outstanding numeric;
  v_deposit_balance numeric;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Only admins and receptionists can complete appointment billing'
      using errcode = '42501';
  end if;

  if p_payment_method is null
    or p_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
  then
    raise exception 'Select a valid payment method' using errcode = '23514';
  end if;

  if p_secondary_payment_method is not null
    and p_secondary_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
  then
    raise exception 'Select a valid secondary payment method' using errcode = '23514';
  end if;

  if p_secondary_payment_method is not null
    and p_secondary_payment_method = p_payment_method
  then
    raise exception 'Secondary method must differ from primary'
      using errcode = '23514';
  end if;

  if v_paid < 0 or v_insurance < 0 or v_secondary < 0 or v_deposit < 0 then
    raise exception 'Payment amounts cannot be negative' using errcode = '23514';
  end if;

  if v_secondary > 0 and p_secondary_payment_method is null then
    raise exception 'Secondary payment method is required for split payments'
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

  if v_appt.status <> all (
    array[
      'pending'::public.appointment_status,
      'confirmed'::public.appointment_status,
      'arrived'::public.appointment_status,
      'in_session'::public.appointment_status
    ]
  ) then
    raise exception 'Only pending, confirmed, arrived, or in-session appointments can be completed'
      using errcode = '23514';
  end if;

  if p_line_items is null
    or jsonb_typeof(p_line_items) <> 'array'
    or jsonb_array_length(p_line_items) = 0
  then
    raise exception 'Add at least one service to the invoice'
      using errcode = '23514';
  end if;

  perform 1
  from public.patients
  where id = v_appt.patient_id
    and clinic_id = v_clinic_id
    and is_deleted = false
  for update;

  if not found then
    raise exception 'Patient not found' using errcode = '23514';
  end if;

  for v_item in select value from jsonb_array_elements(p_line_items)
  loop
    v_name := nullif(trim(v_item->>'name'), '');
    v_service_id := nullif(v_item->>'service_id', '')::uuid;
    v_price := round(coalesce((v_item->>'price')::numeric, 0), 2);
    v_quantity := coalesce((v_item->>'quantity')::integer, 0);

    if v_name is null or length(v_name) > 120 then
      raise exception 'Service name is required' using errcode = '23514';
    end if;
    if v_price < 0 then
      raise exception 'Line item price cannot be negative' using errcode = '23514';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'Line item quantity must be between 1 and 99'
        using errcode = '23514';
    end if;

    v_total := v_total + round(v_price * v_quantity, 2);
  end loop;

  v_total := round(v_total, 2);
  if v_total <= 0 then
    raise exception 'Invoice total must be greater than zero'
      using errcode = '23514';
  end if;

  select round(
    coalesce((select sum(amount) from public.patient_deposits where patient_id = v_appt.patient_id and clinic_id = v_clinic_id), 0)
    - coalesce((select sum(deposit_amount) from public.appointments where patient_id = v_appt.patient_id and clinic_id = v_clinic_id), 0),
    2
  )
  into v_deposit_balance;

  if v_deposit > v_deposit_balance + 0.001 then
    raise exception 'Deposit applied exceeds patient account balance'
      using errcode = '23514';
  end if;

  if v_deposit > v_total + 0.001 then
    raise exception 'Deposit applied cannot exceed invoice total'
      using errcode = '23514';
  end if;

  v_collected := round(v_paid + v_insurance + v_secondary + v_deposit, 2);
  if v_collected > v_total + 0.001 then
    raise exception 'Collected amount exceeds invoice total'
      using errcode = '23514';
  end if;
  v_outstanding := round(greatest(0, v_total - v_collected), 2);

  v_replacement := v_appt;
  v_replacement.status := 'completed'::public.appointment_status;
  v_replacement.updated_by := v_actor_id;
  v_replacement.updated_at := now();
  v_replacement.payment_method := p_payment_method::public.payment_method;
  v_replacement.secondary_payment_method := p_secondary_payment_method::public.payment_method;
  v_replacement.secondary_amount := v_secondary;
  v_replacement.deposit_amount := v_deposit;
  v_replacement.total_amount := v_total;
  v_replacement.paid_amount := v_paid;
  v_replacement.insurance_amount := v_insurance;
  v_replacement.outstanding_amount := v_outstanding;
  v_replacement.payment_note := nullif(trim(coalesce(p_payment_note, '')), '');
  v_replacement.paid_at := now();

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

  perform set_config('clinic_crm.allow_appointment_delete_replacement', 'on', true);

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments
  select (v_replacement).*;

  for v_item in select value from jsonb_array_elements(p_line_items)
  loop
    insert into public.appointment_services (
      appointment_id,
      clinic_id,
      service_id,
      name,
      price,
      quantity
    )
    values (
      p_appointment_id,
      v_clinic_id,
      nullif(v_item->>'service_id', '')::uuid,
      trim(v_item->>'name'),
      round((v_item->>'price')::numeric, 2),
      (v_item->>'quantity')::integer
    );
  end loop;
end;
$$;

create or replace function public.undo_appointment_billing(
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
  v_replacement public.appointments%rowtype;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Only admins and receptionists can undo appointment billing'
      using errcode = '42501';
  end if;

  if p_target_status <> all (array['pending', 'confirmed', 'arrived', 'in_session']) then
    raise exception 'Billing can only be undone to pending, confirmed, arrived, or in_session'
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

  perform set_config('clinic_crm.allow_appointment_delete_replacement', 'on', true);

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments
  select (v_replacement).*;
end;
$$;

revoke all on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text
) from public;
revoke all on function public.undo_appointment_billing(uuid, text) from public;
grant execute on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text
) to authenticated;
grant execute on function public.undo_appointment_billing(uuid, text) to authenticated;

create or replace function public.complete_appointment_billing_with_previous_settlement(
  p_appointment_id uuid,
  p_line_items jsonb,
  p_paid_amount numeric,
  p_payment_method text,
  p_insurance_amount numeric default 0,
  p_secondary_payment_method text default null,
  p_secondary_amount numeric default 0,
  p_deposit_amount numeric default 0,
  p_payment_note text default null,
  p_previous_settlement_amount numeric default 0,
  p_previous_payment_method text default null,
  p_previous_note text default null
)
returns table (
  current_total numeric,
  current_collected numeric,
  current_outstanding numeric,
  previous_outstanding_before numeric,
  previous_settled_now numeric,
  previous_outstanding_after numeric,
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
  v_item jsonb;
  v_name text;
  v_service_id uuid;
  v_price numeric;
  v_quantity integer;
  v_total numeric := 0;
  v_paid numeric := round(coalesce(p_paid_amount, 0), 2);
  v_insurance numeric := round(coalesce(p_insurance_amount, 0), 2);
  v_secondary numeric := round(coalesce(p_secondary_amount, 0), 2);
  v_deposit numeric := round(coalesce(p_deposit_amount, 0), 2);
  v_previous_payment numeric := round(coalesce(p_previous_settlement_amount, 0), 2);
  v_collected numeric;
  v_outstanding numeric;
  v_deposit_balance numeric;
  v_previous_before numeric := 0;
  v_previous_remaining numeric;
  v_apply numeric;
  v_debt record;
  v_affected uuid[] := array[]::uuid[];
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Only admins and receptionists can complete appointment billing'
      using errcode = '42501';
  end if;

  if p_payment_method is null
    or p_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
  then
    raise exception 'Select a valid payment method' using errcode = '23514';
  end if;

  if p_secondary_payment_method is not null
    and p_secondary_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
  then
    raise exception 'Select a valid secondary payment method' using errcode = '23514';
  end if;

  if p_secondary_payment_method is not null
    and p_secondary_payment_method = p_payment_method
  then
    raise exception 'Secondary method must differ from primary'
      using errcode = '23514';
  end if;

  if v_paid < 0 or v_insurance < 0 or v_secondary < 0 or v_deposit < 0 then
    raise exception 'Payment amounts cannot be negative' using errcode = '23514';
  end if;

  if v_previous_payment < 0 then
    raise exception 'Previous settlement amount cannot be negative'
      using errcode = '23514';
  end if;

  if v_secondary > 0 and p_secondary_payment_method is null then
    raise exception 'Secondary payment method is required for split payments'
      using errcode = '23514';
  end if;

  if v_previous_payment > 0 then
    if p_previous_payment_method is null
      or p_previous_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
    then
      raise exception 'Select a valid payment method for previous balance'
        using errcode = '23514';
    end if;
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

  if v_appt.status <> all (
    array[
      'pending'::public.appointment_status,
      'confirmed'::public.appointment_status,
      'arrived'::public.appointment_status,
      'in_session'::public.appointment_status
    ]
  ) then
    raise exception 'Only pending, confirmed, arrived, or in-session appointments can be completed'
      using errcode = '23514';
  end if;

  if p_line_items is null
    or jsonb_typeof(p_line_items) <> 'array'
    or jsonb_array_length(p_line_items) = 0
  then
    raise exception 'Add at least one service to the invoice'
      using errcode = '23514';
  end if;

  perform 1
  from public.patients
  where id = v_appt.patient_id
    and clinic_id = v_clinic_id
    and is_deleted = false
  for update;

  if not found then
    raise exception 'Patient not found' using errcode = '23514';
  end if;

  for v_item in select value from jsonb_array_elements(p_line_items)
  loop
    v_name := nullif(trim(v_item->>'name'), '');
    v_service_id := nullif(v_item->>'service_id', '')::uuid;
    v_price := round(coalesce((v_item->>'price')::numeric, 0), 2);
    v_quantity := coalesce((v_item->>'quantity')::integer, 0);

    if v_name is null or length(v_name) > 120 then
      raise exception 'Service name is required' using errcode = '23514';
    end if;
    if v_price < 0 then
      raise exception 'Line item price cannot be negative' using errcode = '23514';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'Line item quantity must be between 1 and 99'
        using errcode = '23514';
    end if;

    v_total := v_total + round(v_price * v_quantity, 2);
  end loop;

  v_total := round(v_total, 2);
  if v_total <= 0 then
    raise exception 'Invoice total must be greater than zero'
      using errcode = '23514';
  end if;

  perform 1
  from public.appointments
  where patient_id = v_appt.patient_id
    and clinic_id = v_clinic_id
    and id <> p_appointment_id
    and deleted_at is null
    and outstanding_amount > 0
  order by scheduled_at asc
  for update;

  select coalesce(round(sum(outstanding_amount), 2), 0)
  into v_previous_before
  from public.appointments
  where patient_id = v_appt.patient_id
    and clinic_id = v_clinic_id
    and id <> p_appointment_id
    and deleted_at is null
    and outstanding_amount > 0;

  if v_previous_payment > v_previous_before + 0.001 then
    raise exception 'Previous settlement exceeds previous outstanding balance'
      using errcode = '23514';
  end if;

  select round(
    coalesce((select sum(amount) from public.patient_deposits where patient_id = v_appt.patient_id and clinic_id = v_clinic_id), 0)
    - coalesce((select sum(deposit_amount) from public.appointments where patient_id = v_appt.patient_id and clinic_id = v_clinic_id), 0),
    2
  )
  into v_deposit_balance;

  if v_deposit > v_deposit_balance + 0.001 then
    raise exception 'Deposit applied exceeds patient account balance'
      using errcode = '23514';
  end if;

  if v_deposit > v_total + 0.001 then
    raise exception 'Deposit applied cannot exceed invoice total'
      using errcode = '23514';
  end if;

  v_collected := round(v_paid + v_insurance + v_secondary + v_deposit, 2);
  if v_collected > v_total + 0.001 then
    raise exception 'Collected amount exceeds invoice total'
      using errcode = '23514';
  end if;
  v_outstanding := round(greatest(0, v_total - v_collected), 2);

  v_replacement := v_appt;
  v_replacement.status := 'completed'::public.appointment_status;
  v_replacement.updated_by := v_actor_id;
  v_replacement.updated_at := now();
  v_replacement.payment_method := p_payment_method::public.payment_method;
  v_replacement.secondary_payment_method := p_secondary_payment_method::public.payment_method;
  v_replacement.secondary_amount := v_secondary;
  v_replacement.deposit_amount := v_deposit;
  v_replacement.total_amount := v_total;
  v_replacement.paid_amount := v_paid;
  v_replacement.insurance_amount := v_insurance;
  v_replacement.outstanding_amount := v_outstanding;
  v_replacement.payment_note := nullif(trim(coalesce(p_payment_note, '')), '');
  v_replacement.paid_at := now();

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

  perform set_config('clinic_crm.allow_appointment_delete_replacement', 'on', true);

  delete from public.appointments
  where id = p_appointment_id
    and clinic_id = v_clinic_id;

  insert into public.appointments
  select (v_replacement).*;

  for v_item in select value from jsonb_array_elements(p_line_items)
  loop
    insert into public.appointment_services (
      appointment_id,
      clinic_id,
      service_id,
      name,
      price,
      quantity
    )
    values (
      p_appointment_id,
      v_clinic_id,
      nullif(v_item->>'service_id', '')::uuid,
      trim(v_item->>'name'),
      round((v_item->>'price')::numeric, 2),
      (v_item->>'quantity')::integer
    );
  end loop;

  v_previous_remaining := v_previous_payment;
  for v_debt in
    select id, outstanding_amount
    from public.appointments
    where patient_id = v_appt.patient_id
      and clinic_id = v_clinic_id
      and id <> p_appointment_id
      and deleted_at is null
      and outstanding_amount > 0
    order by scheduled_at asc
    for update
  loop
    exit when v_previous_remaining <= 0;

    v_apply := round(least(v_debt.outstanding_amount, v_previous_remaining), 2);
    if v_apply <= 0 then
      continue;
    end if;

    insert into public.outstanding_settlements (
      patient_id,
      appointment_id,
      source_appointment_id,
      clinic_id,
      amount,
      payment_method,
      note,
      created_by
    )
    values (
      v_appt.patient_id,
      v_debt.id,
      p_appointment_id,
      v_clinic_id,
      v_apply,
      p_previous_payment_method::public.payment_method,
      nullif(trim(coalesce(p_previous_note, '')), ''),
      v_actor_id
    );

    update public.appointments
    set outstanding_amount = round(greatest(0, v_debt.outstanding_amount - v_apply), 2)
    where id = v_debt.id
      and clinic_id = v_clinic_id;

    v_previous_remaining := round(v_previous_remaining - v_apply, 2);

    if not v_debt.id = any(v_affected) then
      v_affected := array_append(v_affected, v_debt.id);
    end if;
  end loop;

  current_total := v_total;
  current_collected := v_collected;
  current_outstanding := v_outstanding;
  previous_outstanding_before := v_previous_before;
  previous_settled_now := v_previous_payment;
  previous_outstanding_after := round(v_previous_before - v_previous_payment, 2);
  affected_prior_appointment_ids := v_affected;
  return next;
end;
$$;

revoke all on function public.complete_appointment_billing_with_previous_settlement(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text, numeric, text, text
) from public;
grant execute on function public.complete_appointment_billing_with_previous_settlement(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text, numeric, text, text
) to authenticated;

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

  if p_target_status <> all (array['pending', 'confirmed', 'arrived', 'in_session']) then
    raise exception 'Billing can only be undone to pending, confirmed, arrived, or in_session'
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

  perform set_config('clinic_crm.allow_appointment_delete_replacement', 'on', true);

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

drop index if exists "appointments_doctor_active_slot_key";
create unique index "appointments_doctor_active_slot_key"
  on public.appointments (doctor_id, scheduled_at)
  where status in (
      'confirmed'::public.appointment_status,
      'arrived'::public.appointment_status,
      'in_session'::public.appointment_status
    )
    and deleted_at is null;
