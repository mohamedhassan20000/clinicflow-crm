-- Phase 5G: additive transactional RPCs for billing and settlement.
-- These functions are intentionally not wired by app code in this phase.
-- This migration is intentionally not applied automatically.

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
    array['pending'::public.appointment_status, 'confirmed'::public.appointment_status]
  ) then
    raise exception 'Only pending or confirmed appointments can be completed'
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
end;
$$;
create or replace function public.settle_patient_outstanding(
  p_patient_id uuid,
  p_appointment_id uuid default null,
  p_amount numeric default 0,
  p_payment_method text default null,
  p_secondary_amount numeric default 0,
  p_secondary_payment_method text default null,
  p_note text default null
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
  v_primary numeric := round(coalesce(p_amount, 0), 2);
  v_secondary numeric := round(coalesce(p_secondary_amount, 0), 2);
  v_total_payment numeric;
  v_total_outstanding numeric;
  v_remaining numeric;
  v_linked_appointment_id uuid := p_appointment_id;
  v_debt record;
begin
  if v_actor_id is null or v_role is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'receptionist'::public.user_role]) then
    raise exception 'Only admins and receptionists can settle outstanding balances'
      using errcode = '42501';
  end if;

  if v_primary <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '23514';
  end if;

  if v_secondary < 0 then
    raise exception 'Secondary amount cannot be negative' using errcode = '23514';
  end if;

  if p_payment_method is null
    or p_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
  then
    raise exception 'Select a valid payment method' using errcode = '23514';
  end if;

  if v_secondary > 0 then
    if p_secondary_payment_method is null
      or p_secondary_payment_method <> all (array['cash', 'credit_card', 'paypal', 'bank_transfer', 'insurance'])
    then
      raise exception 'Select a valid secondary payment method'
        using errcode = '23514';
    end if;
    if p_secondary_payment_method = p_payment_method then
      raise exception 'Split methods must differ from the primary method'
        using errcode = '23514';
    end if;
  end if;

  perform 1
  from public.patients
  where id = p_patient_id
    and clinic_id = v_clinic_id
    and is_deleted = false
  for update;

  if not found then
    raise exception 'Patient not found' using errcode = '23514';
  end if;

  if v_linked_appointment_id is not null then
    perform 1
    from public.appointments
    where id = v_linked_appointment_id
      and patient_id = p_patient_id
      and clinic_id = v_clinic_id
    for update;

    if not found then
      raise exception 'Appointment not found for this patient'
        using errcode = '23514';
    end if;
  end if;

  perform 1
  from public.appointments
  where patient_id = p_patient_id
    and clinic_id = v_clinic_id
    and outstanding_amount > 0
  for update;

  select coalesce(round(sum(outstanding_amount), 2), 0)
  into v_total_outstanding
  from public.appointments
  where patient_id = p_patient_id
    and clinic_id = v_clinic_id
    and outstanding_amount > 0;

  v_total_payment := round(v_primary + v_secondary, 2);
  if v_total_outstanding <= 0 then
    raise exception 'No outstanding balance to settle' using errcode = '23514';
  end if;
  if v_total_payment > v_total_outstanding + 0.001 then
    raise exception 'Payment exceeds outstanding balance' using errcode = '23514';
  end if;

  if v_linked_appointment_id is null then
    select id
    into v_linked_appointment_id
    from public.appointments
    where patient_id = p_patient_id
      and clinic_id = v_clinic_id
      and outstanding_amount > 0
    order by scheduled_at asc
    limit 1;
  end if;

  insert into public.outstanding_settlements (
    patient_id,
    appointment_id,
    clinic_id,
    amount,
    payment_method,
    note,
    created_by
  )
  values (
    p_patient_id,
    v_linked_appointment_id,
    v_clinic_id,
    v_primary,
    p_payment_method::public.payment_method,
    nullif(trim(coalesce(p_note, '')), ''),
    v_actor_id
  );

  if v_secondary > 0 then
    insert into public.outstanding_settlements (
      patient_id,
      appointment_id,
      clinic_id,
      amount,
      payment_method,
      note,
      created_by
    )
    values (
      p_patient_id,
      v_linked_appointment_id,
      v_clinic_id,
      v_secondary,
      p_secondary_payment_method::public.payment_method,
      nullif(trim(coalesce(p_note, '')), ''),
      v_actor_id
    );
  end if;

  v_remaining := v_total_payment;
  for v_debt in
    select id, outstanding_amount
    from public.appointments
    where patient_id = p_patient_id
      and clinic_id = v_clinic_id
      and outstanding_amount > 0
    order by scheduled_at asc
    for update
  loop
    exit when v_remaining <= 0;

    update public.appointments
    set outstanding_amount = round(greatest(0, v_debt.outstanding_amount - v_remaining), 2)
    where id = v_debt.id
      and clinic_id = v_clinic_id;

    v_remaining := round(v_remaining - least(v_debt.outstanding_amount, v_remaining), 2);
  end loop;
end;
$$;
revoke all on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text
) from public;
revoke all on function public.undo_appointment_billing(uuid, text) from public;
revoke all on function public.settle_patient_outstanding(
  uuid, uuid, numeric, text, numeric, text, text
) from public;
grant execute on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text
) to authenticated;
grant execute on function public.undo_appointment_billing(uuid, text) to authenticated;
grant execute on function public.settle_patient_outstanding(
  uuid, uuid, numeric, text, numeric, text, text
) to authenticated;
