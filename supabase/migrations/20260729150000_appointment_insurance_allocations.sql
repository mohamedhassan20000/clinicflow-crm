-- Insurance remains a payer allocation on the appointment invoice. The final
-- rounded amount is authoritative; mode/percentage preserve the user's input.

begin;

alter table public.appointments
  add column if not exists insurance_calculation_mode text not null default 'amount',
  add column if not exists insurance_percentage numeric(5, 2),
  add column if not exists patient_responsibility numeric(12, 2);

-- Backfill financial metadata without emitting user-facing appointment.updated
-- activity events for this one-time schema migration. The transaction guarantees
-- the trigger is restored even if the migration fails.
alter table public.appointments disable trigger trg_activity_appointments;

-- Older UI versions allowed "insurance" to be selected as a patient payment
-- method. Move those allocations into the existing canonical insurance_amount
-- without changing the invoice's total allocated/outstanding arithmetic.
update public.appointments
set insurance_amount = round(
      coalesce(insurance_amount, 0)
        + case
            when payment_method = 'insurance'
              then coalesce(paid_amount, 0)
            else 0
          end
        + case
            when secondary_payment_method = 'insurance'
              then coalesce(secondary_amount, 0)
            else 0
          end,
      2
    ),
    paid_amount = case
      when payment_method = 'insurance' then 0
      else paid_amount
    end,
    payment_method = case
      when payment_method = 'insurance' then null
      else payment_method
    end,
    secondary_amount = case
      when secondary_payment_method = 'insurance' then 0
      else secondary_amount
    end,
    secondary_payment_method = case
      when secondary_payment_method = 'insurance' then null
      else secondary_payment_method
    end
where payment_method = 'insurance'
   or secondary_payment_method = 'insurance';

update public.appointments
set insurance_calculation_mode = 'amount',
    insurance_percentage = null,
    patient_responsibility = case
      when total_amount is null then null
      else round(greatest(0, total_amount - coalesce(insurance_amount, 0)), 2)
    end;

-- Appointment replacement-chain checks are deferred constraint triggers.
-- Flush the events raised by the backfill before altering this table again.
set constraints all immediate;
alter table public.appointments enable trigger trg_activity_appointments;

alter table public.appointments
  add constraint appointments_insurance_calculation_mode_check
    check (insurance_calculation_mode in ('amount', 'percentage')),
  add constraint appointments_insurance_percentage_check
    check (
      (insurance_calculation_mode = 'amount' and insurance_percentage is null)
      or
      (
        insurance_calculation_mode = 'percentage'
        and insurance_percentage between 0 and 100
      )
    ),
  add constraint appointments_insurance_not_above_total_check
    check (
      total_amount is null
      or coalesce(insurance_amount, 0) <= total_amount
    ),
  add constraint appointments_patient_responsibility_check
    check (
      total_amount is null
      or patient_responsibility is null
      or patient_responsibility =
        round(greatest(0, total_amount - coalesce(insurance_amount, 0)), 2)
    );

create or replace function public.normalize_appointment_insurance_allocation()
returns trigger
language plpgsql
as $$
declare
  v_context_appointment_id uuid := nullif(
    current_setting('clinic_crm.insurance_appointment_id', true),
    ''
  )::uuid;
  v_context_mode text := nullif(
    current_setting('clinic_crm.insurance_calculation_mode', true),
    ''
  );
  v_context_percentage numeric := nullif(
    current_setting('clinic_crm.insurance_percentage', true),
    ''
  )::numeric;
  v_context_responsibility numeric := nullif(
    current_setting('clinic_crm.patient_responsibility', true),
    ''
  )::numeric;
begin
  if new.total_amount is null then
    new.insurance_calculation_mode := 'amount';
    new.insurance_percentage := null;
    new.patient_responsibility := null;
    return new;
  end if;

  -- The compatibility RPCs set transaction-local context before invoking the
  -- established completion implementation. Applying the metadata here keeps
  -- completion to one appointment UPDATE and therefore one semantic activity
  -- event.
  if new.id = v_context_appointment_id and v_context_mode is not null then
    new.insurance_calculation_mode := v_context_mode;
    new.insurance_percentage := case
      when v_context_mode = 'percentage' then v_context_percentage
      else null
    end;
    new.patient_responsibility := v_context_responsibility;
    return new;
  end if;

  new.insurance_calculation_mode :=
    coalesce(new.insurance_calculation_mode, 'amount');
  if new.insurance_calculation_mode = 'amount' then
    new.insurance_percentage := null;
  end if;
  if new.patient_responsibility is null then
    new.patient_responsibility :=
      round(greatest(0, new.total_amount - coalesce(new.insurance_amount, 0)), 2);
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_normalize_insurance_allocation
  on public.appointments;
create trigger appointments_normalize_insurance_allocation
before insert or update of
  total_amount,
  insurance_amount,
  insurance_calculation_mode,
  insurance_percentage,
  patient_responsibility
on public.appointments
for each row execute function public.normalize_appointment_insurance_allocation();

revoke all on function public.normalize_appointment_insurance_allocation()
  from public, anon, authenticated;

-- Transactional compatibility wrappers extend the existing completion RPCs.
-- Calling the original overload and writing the metadata happen in one database
-- transaction, so a failure rolls the complete invoice operation back.
create or replace function public.complete_appointment_billing(
  p_appointment_id uuid,
  p_line_items jsonb,
  p_paid_amount numeric,
  p_payment_method text,
  p_insurance_amount numeric,
  p_secondary_payment_method text,
  p_secondary_amount numeric,
  p_deposit_amount numeric,
  p_payment_note text,
  p_insurance_calculation_mode text,
  p_insurance_percentage numeric,
  p_patient_responsibility numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
  v_insurance numeric := round(coalesce(p_insurance_amount, 0), 2);
  v_expected_insurance numeric;
  v_expected_responsibility numeric;
begin
  if p_payment_method = 'insurance'
    or p_secondary_payment_method = 'insurance'
  then
    raise exception 'Insurance is not a patient payment method'
      using errcode = '23514';
  end if;

  if p_insurance_calculation_mode is null
    or p_insurance_calculation_mode not in ('amount', 'percentage')
  then
    raise exception 'Invalid insurance calculation mode'
      using errcode = '23514';
  end if;

  select coalesce(round(sum(
    (item ->> 'price')::numeric * (item ->> 'quantity')::numeric
  ), 2), 0)
  into v_total
  from jsonb_array_elements(p_line_items) item;

  if p_insurance_calculation_mode = 'percentage' then
    if p_insurance_percentage is null
      or p_insurance_percentage < 0
      or p_insurance_percentage > 100
    then
      raise exception 'Insurance percentage must be between 0 and 100'
        using errcode = '23514';
    end if;
    v_expected_insurance :=
      round(v_total * p_insurance_percentage / 100, 2);
  else
    if p_insurance_percentage is not null then
      raise exception 'Amount mode cannot store an insurance percentage'
        using errcode = '23514';
    end if;
    v_expected_insurance := v_insurance;
  end if;

  v_expected_responsibility :=
    round(greatest(0, v_total - v_insurance), 2);
  if v_insurance < 0 or v_insurance > v_total then
    raise exception 'Insurance contribution exceeds invoice total'
      using errcode = '23514';
  end if;
  if v_expected_insurance <> v_insurance then
    raise exception 'Insurance amount does not match percentage'
      using errcode = '23514';
  end if;
  if p_patient_responsibility is null
    or round(p_patient_responsibility, 2) <> v_expected_responsibility
  then
    raise exception 'Patient responsibility does not reconcile'
      using errcode = '23514';
  end if;
  if round(
    coalesce(p_paid_amount, 0)
      + coalesce(p_secondary_amount, 0)
      + coalesce(p_deposit_amount, 0),
    2
  ) > v_expected_responsibility then
    raise exception 'Patient payments exceed patient responsibility'
      using errcode = '23514';
  end if;

  perform set_config(
    'clinic_crm.insurance_appointment_id',
    p_appointment_id::text,
    true
  );
  perform set_config(
    'clinic_crm.insurance_calculation_mode',
    p_insurance_calculation_mode,
    true
  );
  perform set_config(
    'clinic_crm.insurance_percentage',
    coalesce(round(p_insurance_percentage, 2)::text, ''),
    true
  );
  perform set_config(
    'clinic_crm.patient_responsibility',
    v_expected_responsibility::text,
    true
  );

  perform public.complete_appointment_billing(
    p_appointment_id,
    p_line_items,
    p_paid_amount,
    p_payment_method,
    v_insurance,
    p_secondary_payment_method,
    p_secondary_amount,
    p_deposit_amount,
    p_payment_note
  );

  perform set_config('clinic_crm.insurance_appointment_id', '', true);
  perform set_config('clinic_crm.insurance_calculation_mode', '', true);
  perform set_config('clinic_crm.insurance_percentage', '', true);
  perform set_config('clinic_crm.patient_responsibility', '', true);
end;
$$;

create or replace function public.complete_appointment_billing_with_previous_settlement(
  p_appointment_id uuid,
  p_line_items jsonb,
  p_paid_amount numeric,
  p_payment_method text,
  p_insurance_amount numeric,
  p_secondary_payment_method text,
  p_secondary_amount numeric,
  p_deposit_amount numeric,
  p_payment_note text,
  p_previous_settlement_amount numeric,
  p_previous_payment_method text,
  p_previous_note text,
  p_insurance_calculation_mode text,
  p_insurance_percentage numeric,
  p_patient_responsibility numeric
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
  v_total numeric;
  v_insurance numeric := round(coalesce(p_insurance_amount, 0), 2);
  v_expected_insurance numeric;
  v_expected_responsibility numeric;
begin
  if p_payment_method = 'insurance'
    or p_secondary_payment_method = 'insurance'
    or p_previous_payment_method = 'insurance'
  then
    raise exception 'Insurance is not a patient payment method'
      using errcode = '23514';
  end if;

  if p_insurance_calculation_mode is null
    or p_insurance_calculation_mode not in ('amount', 'percentage')
  then
    raise exception 'Invalid insurance calculation mode'
      using errcode = '23514';
  end if;

  select coalesce(round(sum(
    (item ->> 'price')::numeric * (item ->> 'quantity')::numeric
  ), 2), 0)
  into v_total
  from jsonb_array_elements(p_line_items) item;

  if p_insurance_calculation_mode = 'percentage' then
    if p_insurance_percentage is null
      or p_insurance_percentage < 0
      or p_insurance_percentage > 100
    then
      raise exception 'Insurance percentage must be between 0 and 100'
        using errcode = '23514';
    end if;
    v_expected_insurance :=
      round(v_total * p_insurance_percentage / 100, 2);
  else
    if p_insurance_percentage is not null then
      raise exception 'Amount mode cannot store an insurance percentage'
        using errcode = '23514';
    end if;
    v_expected_insurance := v_insurance;
  end if;

  v_expected_responsibility :=
    round(greatest(0, v_total - v_insurance), 2);
  if v_insurance < 0 or v_insurance > v_total then
    raise exception 'Insurance contribution exceeds invoice total'
      using errcode = '23514';
  end if;
  if v_expected_insurance <> v_insurance then
    raise exception 'Insurance amount does not match percentage'
      using errcode = '23514';
  end if;
  if p_patient_responsibility is null
    or round(p_patient_responsibility, 2) <> v_expected_responsibility
  then
    raise exception 'Patient responsibility does not reconcile'
      using errcode = '23514';
  end if;
  if round(
    coalesce(p_paid_amount, 0)
      + coalesce(p_secondary_amount, 0)
      + coalesce(p_deposit_amount, 0),
    2
  ) > v_expected_responsibility then
    raise exception 'Patient payments exceed patient responsibility'
      using errcode = '23514';
  end if;

  perform set_config(
    'clinic_crm.insurance_appointment_id',
    p_appointment_id::text,
    true
  );
  perform set_config(
    'clinic_crm.insurance_calculation_mode',
    p_insurance_calculation_mode,
    true
  );
  perform set_config(
    'clinic_crm.insurance_percentage',
    coalesce(round(p_insurance_percentage, 2)::text, ''),
    true
  );
  perform set_config(
    'clinic_crm.patient_responsibility',
    v_expected_responsibility::text,
    true
  );

  return query
  select *
  from public.complete_appointment_billing_with_previous_settlement(
    p_appointment_id,
    p_line_items,
    p_paid_amount,
    p_payment_method,
    v_insurance,
    p_secondary_payment_method,
    p_secondary_amount,
    p_deposit_amount,
    p_payment_note,
    p_previous_settlement_amount,
    p_previous_payment_method,
    p_previous_note
  );

  perform set_config('clinic_crm.insurance_appointment_id', '', true);
  perform set_config('clinic_crm.insurance_calculation_mode', '', true);
  perform set_config('clinic_crm.insurance_percentage', '', true);
  perform set_config('clinic_crm.patient_responsibility', '', true);
end;
$$;

revoke all on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text,
  text, numeric, numeric
) from public, anon;
grant execute on function public.complete_appointment_billing(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text,
  text, numeric, numeric
) to authenticated;

revoke all on function public.complete_appointment_billing_with_previous_settlement(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text,
  numeric, text, text, text, numeric, numeric
) from public, anon;
grant execute on function public.complete_appointment_billing_with_previous_settlement(
  uuid, jsonb, numeric, text, numeric, text, numeric, numeric, text,
  numeric, text, text, text, numeric, numeric
) to authenticated;

-- Preserve the semantic activity action chosen by record_activity_event(), then
-- enrich that same event's before/after snapshot with the complete allocation.
create or replace function public.augment_appointment_activity_financial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_previous jsonb;
  v_new jsonb;
begin
  select event.id
  into v_event_id
  from public.activity_events event
  where event.clinic_id = coalesce(new.clinic_id, old.clinic_id)
    and event.entity_type = 'appointment'
    and event.entity_id = coalesce(new.id, old.id)
  order by event.occurred_at desc, event.id desc
  limit 1;

  if v_event_id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  v_previous := case when tg_op = 'INSERT' then null else jsonb_build_object(
    'total_amount', old.total_amount,
    'insurance_amount', old.insurance_amount,
    'insurance_calculation_mode', old.insurance_calculation_mode,
    'insurance_percentage', old.insurance_percentage,
    'patient_responsibility', old.patient_responsibility,
    'paid_amount', old.paid_amount,
    'payment_method', old.payment_method,
    'secondary_amount', old.secondary_amount,
    'secondary_payment_method', old.secondary_payment_method,
    'deposit_amount', old.deposit_amount,
    'outstanding_amount', old.outstanding_amount
  ) end;
  v_new := case when tg_op = 'DELETE' then null else jsonb_build_object(
    'total_amount', new.total_amount,
    'insurance_amount', new.insurance_amount,
    'insurance_calculation_mode', new.insurance_calculation_mode,
    'insurance_percentage', new.insurance_percentage,
    'patient_responsibility', new.patient_responsibility,
    'paid_amount', new.paid_amount,
    'payment_method', new.payment_method,
    'secondary_amount', new.secondary_amount,
    'secondary_payment_method', new.secondary_payment_method,
    'deposit_amount', new.deposit_amount,
    'outstanding_amount', new.outstanding_amount
  ) end;

  update public.activity_events
  set previous_state = case
        when v_previous is null then previous_state
        else coalesce(previous_state, '{}'::jsonb) || v_previous
      end,
      new_state = case
        when v_new is null then new_state
        else coalesce(new_state, '{}'::jsonb) || v_new
      end
  where id = v_event_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists zz_trg_activity_appointments_financial_state
  on public.appointments;
create trigger zz_trg_activity_appointments_financial_state
after insert or update or delete on public.appointments
for each row execute function public.augment_appointment_activity_financial_state();

revoke all on function public.augment_appointment_activity_financial_state()
  from public, anon, authenticated;

commit;
