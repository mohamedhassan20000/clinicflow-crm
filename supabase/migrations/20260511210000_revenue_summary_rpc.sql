-- Performance Phase 2A: server-side revenue summary for large reports.
-- SECURITY INVOKER is intentional so existing table RLS remains in force.

create or replace function public.get_revenue_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_department_id uuid default null,
  p_doctor_id uuid default null,
  p_patient_ids uuid[] default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_summary jsonb;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role = 'receptionist'::public.user_role then
    raise exception 'Not authorized to view revenue summaries'
      using errcode = '42501';
  end if;

  with appointment_scope as (
    select
      a.id,
      a.total_amount,
      a.paid_amount,
      a.insurance_amount,
      a.secondary_amount,
      a.deposit_amount,
      a.outstanding_amount,
      a.payment_method,
      a.secondary_payment_method
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.deleted_at is null
      and a.status = 'completed'::public.appointment_status
      and a.paid_at >= p_start
      and a.paid_at <= p_end
      and (p_department_id is null or a.department_id = p_department_id)
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
      and (p_patient_ids is null or a.patient_id = any(p_patient_ids))
  ),
  settlement_scope as (
    select
      s.id,
      s.amount,
      s.payment_method
    from public.outstanding_settlements s
    left join public.appointments a on a.id = s.appointment_id
    where s.clinic_id = v_clinic_id
      and s.settled_at >= p_start
      and s.settled_at <= p_end
      and (p_patient_ids is null or s.patient_id = any(p_patient_ids))
      and (p_department_id is null or a.department_id = p_department_id)
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
  ),
  appointment_totals as (
    select
      coalesce(sum(total_amount), 0)::numeric as total_amount,
      coalesce(sum(paid_amount), 0)::numeric as primary_amount,
      coalesce(sum(secondary_amount), 0)::numeric as secondary_amount,
      coalesce(sum(insurance_amount), 0)::numeric as insurance_amount,
      coalesce(sum(deposit_amount), 0)::numeric as deposit_amount,
      coalesce(sum(outstanding_amount), 0)::numeric as outstanding_amount,
      count(*)::integer as transaction_count
    from appointment_scope
  ),
  settlement_totals as (
    select
      coalesce(sum(amount), 0)::numeric as settlements_amount,
      count(*)::integer as settlement_count
    from settlement_scope
  ),
  method_rows as (
    select payment_method::text as method, coalesce(sum(paid_amount), 0)::numeric as amount
    from appointment_scope
    where payment_method is not null and paid_amount is not null
    group by payment_method
    union all
    select secondary_payment_method::text as method, coalesce(sum(secondary_amount), 0)::numeric as amount
    from appointment_scope
    where secondary_payment_method is not null and secondary_amount is not null
    group by secondary_payment_method
    union all
    select payment_method::text as method, coalesce(sum(amount), 0)::numeric as amount
    from settlement_scope
    where payment_method is not null and amount is not null
    group by payment_method
  ),
  method_totals as (
    select method, coalesce(sum(amount), 0)::numeric as amount
    from method_rows
    group by method
  )
  select jsonb_build_object(
    'totalAmount', at.total_amount,
    'primaryTotal', at.primary_amount,
    'secondaryTotal', at.secondary_amount,
    'insuranceTotal', at.insurance_amount,
    'depositTotal', at.deposit_amount,
    'outstandingTotal', at.outstanding_amount,
    'settlementsTotal', st.settlements_amount,
    'grossTotal',
      at.primary_amount +
      at.secondary_amount +
      at.insurance_amount +
      at.deposit_amount +
      st.settlements_amount,
    'transactionCount', at.transaction_count,
    'settlementCount', st.settlement_count,
    'methodBreakdown',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('method', mt.method, 'amount', mt.amount)
            order by mt.amount desc
          )
          from method_totals mt
        ),
        '[]'::jsonb
      )
  )
  into v_summary
  from appointment_totals at
  cross join settlement_totals st;

  return v_summary;
end;
$$;

revoke all on function public.get_revenue_summary(timestamptz, timestamptz, uuid, uuid, uuid[])
from public;

grant execute on function public.get_revenue_summary(timestamptz, timestamptz, uuid, uuid, uuid[])
to authenticated, service_role;
