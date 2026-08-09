-- P7-4: remaining analytical document batch.
--
-- The five pre-existing report-backed documents continue to use their current
-- SECURITY INVOKER report RPCs. Sales and Follow-up Analytics deliberately get
-- dedicated, RLS-respecting data pipelines because neither exists in
-- REPORT_CATALOG. The final function records canonical reprints for only the
-- seven P7-4 document types.

create or replace function public.get_document_sales_report(
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
  v_result jsonb;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_role <> all (array[
    'admin'::public.user_role,
    'manager'::public.user_role,
    'receptionist'::public.user_role
  ]) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  with appointment_scope as (
    select
      a.id,
      coalesce(a.total_amount, 0)::numeric as service_amount,
      coalesce(a.paid_amount, 0)::numeric as primary_amount,
      coalesce(a.secondary_amount, 0)::numeric as secondary_amount,
      coalesce(a.insurance_amount, 0)::numeric as insurance_amount,
      coalesce(a.deposit_amount, 0)::numeric as deposit_amount,
      coalesce(a.outstanding_amount, 0)::numeric as outstanding_amount,
      a.payment_method,
      a.secondary_payment_method
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.deleted_at is null
      and a.status = 'completed'::public.appointment_status
      and a.paid_at >= p_start
      and a.paid_at <= p_end
  ),
  settlement_scope as (
    select
      s.id,
      coalesce(s.amount, 0)::numeric as amount,
      s.payment_method
    from public.outstanding_settlements s
    where s.clinic_id = v_clinic_id
      and s.settled_at >= p_start
      and s.settled_at <= p_end
  ),
  appointment_totals as (
    select
      coalesce(sum(service_amount), 0)::numeric as service_total,
      coalesce(sum(primary_amount), 0)::numeric as primary_total,
      coalesce(sum(secondary_amount), 0)::numeric as secondary_total,
      coalesce(sum(insurance_amount), 0)::numeric as insurance_total,
      coalesce(sum(deposit_amount), 0)::numeric as deposit_total,
      coalesce(sum(outstanding_amount), 0)::numeric as outstanding_total,
      count(*)::integer as transaction_count
    from appointment_scope
  ),
  settlement_totals as (
    select
      coalesce(sum(amount), 0)::numeric as settlement_total,
      count(*)::integer as settlement_count
    from settlement_scope
  ),
  payment_rows as (
    select payment_method::text as method, sum(primary_amount)::numeric as amount
    from appointment_scope
    where payment_method is not null
    group by payment_method
    union all
    select secondary_payment_method::text, sum(secondary_amount)::numeric
    from appointment_scope
    where secondary_payment_method is not null
    group by secondary_payment_method
    union all
    select payment_method::text, sum(amount)::numeric
    from settlement_scope
    where payment_method is not null
    group by payment_method
  ),
  payment_totals as (
    select method, coalesce(sum(amount), 0)::numeric as amount
    from payment_rows
    group by method
  )
  select jsonb_build_object(
    'serviceTotal', a.service_total,
    'primaryTotal', a.primary_total,
    'secondaryTotal', a.secondary_total,
    'insuranceTotal', a.insurance_total,
    'depositTotal', a.deposit_total,
    'settlementTotal', s.settlement_total,
    'outstandingTotal', a.outstanding_total,
    'collectedTotal',
      a.primary_total + a.secondary_total + a.insurance_total
      + a.deposit_total + s.settlement_total,
    'transactionCount', a.transaction_count,
    'settlementCount', s.settlement_count,
    'paymentMethods', coalesce((
      select jsonb_agg(
        jsonb_build_object('method', p.method, 'amount', p.amount)
        order by p.amount desc
      )
      from payment_totals p
    ), '[]'::jsonb)
  ) into v_result
  from appointment_totals a
  cross join settlement_totals s;

  return v_result;
end;
$$;

revoke all on function public.get_document_sales_report(timestamptz, timestamptz)
from public, anon;
grant execute on function public.get_document_sales_report(timestamptz, timestamptz)
to authenticated, service_role;

comment on function public.get_document_sales_report(timestamptz, timestamptz) is
  'P7-4 Sales document resolver. Collection-period figures only; SECURITY INVOKER preserves table RLS.';

create or replace function public.get_document_follow_up_analytics_report(
  p_start timestamptz,
  p_end timestamptz,
  p_doctor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_result jsonb;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_role <> all (array[
    'admin'::public.user_role,
    'manager'::public.user_role,
    'receptionist'::public.user_role,
    'doctor'::public.user_role,
    'assistant'::public.user_role
  ]) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  with outcome_scope as (
    select f.outcome
    from public.follow_ups f
    join public.appointments a on a.id = f.appointment_id
    where f.clinic_id = v_clinic_id
      and a.deleted_at is null
      and a.scheduled_at >= p_start
      and a.scheduled_at <= p_end
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
  ),
  totals as (
    select
      count(*)::integer as completed_count,
      count(*) filter (where outcome = 'all_fine'::public.follow_up_outcome)::integer
        as all_fine_count,
      count(*) filter (where outcome = 'has_problem'::public.follow_up_outcome)::integer
        as has_problem_count,
      count(*) filter (where outcome = 'no_response'::public.follow_up_outcome)::integer
        as no_response_count
    from outcome_scope
  ),
  outcome_rows as (
    select 'all_fine'::text as outcome, all_fine_count as count from totals
    union all
    select 'has_problem', has_problem_count from totals
    union all
    select 'no_response', no_response_count from totals
  )
  select jsonb_build_object(
    'completedCount', t.completed_count,
    'allFineCount', t.all_fine_count,
    'hasProblemCount', t.has_problem_count,
    'noResponseCount', t.no_response_count,
    'outcomes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'outcome', o.outcome,
        'count', o.count,
        'rate', case
          when t.completed_count = 0 then 0
          else round((o.count::numeric / t.completed_count) * 100, 1)
        end
      ) order by case o.outcome
        when 'all_fine' then 1
        when 'has_problem' then 2
        else 3
      end)
      from outcome_rows o
    ), '[]'::jsonb)
  ) into v_result
  from totals t;

  return v_result;
end;
$$;

revoke all on function public.get_document_follow_up_analytics_report(
  timestamptz, timestamptz, uuid
) from public, anon;
grant execute on function public.get_document_follow_up_analytics_report(
  timestamptz, timestamptz, uuid
) to authenticated, service_role;

comment on function public.get_document_follow_up_analytics_report(
  timestamptz, timestamptz, uuid
) is
  'P7-4 Follow-up Analytics document resolver. Uses appointment-scheduled period semantics and caller RLS.';

create or replace function public.record_analytical_document_reprint(
  p_document_id uuid
)
returns table (
  pdf_storage_path text,
  document_number text,
  print_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_actor_id uuid := auth.uid();
  v_role public.user_role := public.auth_role();
  v_document public.documents%rowtype;
  v_print_count integer;
begin
  if v_actor_id is null or v_clinic_id is null or v_role is null then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id
    and d.clinic_id = v_clinic_id
    and d.doc_type = any (array[
      'FOLLOW_UP_PAGE_REPORT',
      'CANCELLATION_REPORT',
      'NO_SHOW_REPORT',
      'SALES_REPORT',
      'FOLLOW_UP_ANALYTICS_REPORT',
      'DOCTOR_PERFORMANCE_REPORT',
      'RECEPTIONIST_PERFORMANCE_REPORT'
    ])
    and d.status = any (array['issued', 'void', 'cancelled'])
  for update;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if (
    v_document.doc_type in ('DOCTOR_PERFORMANCE_REPORT', 'RECEPTIONIST_PERFORMANCE_REPORT')
    and v_role <> all (array['admin'::public.user_role, 'manager'::public.user_role])
  ) or (
    v_document.doc_type = 'SALES_REPORT'
    and v_role <> all (array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'receptionist'::public.user_role
    ])
  ) or (
    v_document.doc_type <> all (array[
      'DOCTOR_PERFORMANCE_REPORT',
      'RECEPTIONIST_PERFORMANCE_REPORT',
      'SALES_REPORT'
    ])
    and v_role <> all (array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'receptionist'::public.user_role,
      'doctor'::public.user_role,
      'assistant'::public.user_role
    ])
  ) then
    raise exception 'DOCUMENT_REPRINT_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if v_document.pdf_storage_path is null then
    raise exception 'DOCUMENT_PDF_UNAVAILABLE' using errcode = '55000';
  end if;

  update public.documents d
  set print_count = d.print_count + 1
  where d.id = v_document.id
  returning d.print_count into v_print_count;

  insert into public.document_events (
    clinic_id, document_id, event, actor_id, is_system, metadata
  ) values (
    v_clinic_id,
    v_document.id,
    'reprinted',
    v_actor_id,
    false,
    jsonb_build_object('print_count', v_print_count)
  );

  return query select
    v_document.pdf_storage_path,
    v_document.document_number,
    v_print_count;
end;
$$;

alter function public.record_analytical_document_reprint(uuid) owner to postgres;
revoke all on function public.record_analytical_document_reprint(uuid)
from public, anon;
grant execute on function public.record_analytical_document_reprint(uuid)
to authenticated;

comment on function public.record_analytical_document_reprint(uuid) is
  'P7-4 canonical reprint transaction restricted to the seven analytical batch document types.';
