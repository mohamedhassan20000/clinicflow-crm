-- Phase 8A: "My Revenue" — a doctor-oriented revenue report distinct from the
-- administrative Revenue report.
--
-- Data scope: a doctor sees only their own collected revenue; an assistant sees
-- only the union of their assigned doctors' revenue. This is enforced by RLS:
-- the RPC is SECURITY INVOKER and reads ONLY the RLS-scoped `appointments`
-- table (the appointment payment columns the caller may already read). It never
-- reads clinic-wide settlement/deposit tables (`outstanding_settlements`) that
-- doctors/assistants cannot see — so "My Revenue" is, by construction,
-- appointment-collected revenue for the caller's own authorized rows only.
--
-- The role guard hard-denies every role except doctor/assistant. Admin, manager
-- and receptionist keep the existing clinic-wide `get_revenue_summary`; they can
-- never reach this self-scoped RPC (which under their RLS would otherwise return
-- clinic-wide figures).

create or replace function public.get_my_revenue_summary(
  p_start timestamptz,
  p_end timestamptz
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

  -- Self-scoped report: only doctors (own scope) and assistants (supervised-
  -- doctor union) may run it. Everyone else uses the administrative revenue
  -- report; letting them in here would surface clinic-wide figures under their
  -- broader RLS, defeating the "My Revenue" scoping guarantee.
  if v_role not in ('doctor'::public.user_role, 'assistant'::public.user_role) then
    raise exception 'Not authorized to view personal revenue'
      using errcode = '42501';
  end if;

  with appointment_scope as (
    -- RLS on `appointments` scopes these rows to the caller: a doctor's own
    -- appointments, an assistant's supervised doctors' appointments. No extra
    -- doctor_id predicate is needed — and none is offered — so the assistant
    -- aggregate is exactly the union of their assigned doctors.
    select
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
    -- No settlements: this report never reads the clinic-wide settlement table.
    'grossTotal',
      at.primary_amount +
      at.secondary_amount +
      at.insurance_amount +
      at.deposit_amount,
    'transactionCount', at.transaction_count,
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
  from appointment_totals at;

  return v_summary;
end;
$$;
revoke all on function public.get_my_revenue_summary(timestamptz, timestamptz)
from public;
grant execute on function public.get_my_revenue_summary(timestamptz, timestamptz)
to authenticated, service_role;
