-- Phase 6: exclude the `replaced` reschedule event from the AI appointment
-- stats totals and rates, and surface dedicated replacement KPIs. Reproduced
-- from 20260720130000_p46a_staff_analytics.sql with only these changes.

create or replace function public.ai_get_appointment_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_group_by text default 'status'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('clinic_analytics');
  v_total bigint;
  v_cancelled bigint;
  v_no_show bigint;
  v_completed bigint;
  v_replaced bigint;
  v_buckets jsonb;
begin
  if p_group_by not in ('status', 'doctor', 'department') then
    raise exception 'Unsupported grouping' using errcode = '22023';
  end if;

  select
    count(*) filter (where a.status <> 'replaced'::public.appointment_status),
    count(*) filter (where a.status = 'cancelled'::public.appointment_status),
    count(*) filter (where a.status = 'no_show'::public.appointment_status),
    count(*) filter (where a.status = 'completed'::public.appointment_status)
  into v_total, v_cancelled, v_no_show, v_completed
  from public.appointments a
  where a.clinic_id = v_clinic_id and a.deleted_at is null
    and a.scheduled_at >= p_start and a.scheduled_at <= p_end;

  select count(*) filter (where a.status = 'replaced'::public.appointment_status)
  into v_replaced
  from public.appointments a
  where a.clinic_id = v_clinic_id and a.deleted_at is null
    and a.scheduled_at >= p_start and a.scheduled_at <= p_end;

  with grouped as (
    select
      case p_group_by
        when 'status' then a.status::text
        when 'doctor' then coalesce(doc.full_name, 'Unassigned')
        else coalesce(d.name, 'Unassigned')
      end as bucket,
      count(*) as total,
      count(*) filter (where a.status = 'cancelled'::public.appointment_status) as cancelled,
      count(*) filter (where a.status = 'no_show'::public.appointment_status) as no_show,
      count(*) filter (where a.status = 'completed'::public.appointment_status) as completed
    from public.appointments a
    left join public.profiles doc on doc.id = a.doctor_id
    left join public.departments d on d.id = a.department_id
    where a.clinic_id = v_clinic_id and a.deleted_at is null
      and a.scheduled_at >= p_start and a.scheduled_at <= p_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucket', g.bucket,
        'total', g.total,
        'cancelled', g.cancelled,
        'no_show', g.no_show,
        'completed', g.completed
      )
      order by g.total desc, g.bucket asc
    ),
    '[]'::jsonb
  )
  into v_buckets
  from grouped g;

  return jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'group_by', p_group_by,
    'total', v_total,
    'completed', v_completed,
    'cancelled', v_cancelled,
    'no_show', v_no_show,
    'replaced', v_replaced,
    'replacement_rate', case when (v_total + v_replaced) = 0 then 0
      else round((v_replaced::numeric / (v_total + v_replaced)) * 100, 2) end,
    'cancellation_rate', case when v_total = 0 then 0
      else round((v_cancelled::numeric / v_total) * 100, 2) end,
    'no_show_rate', case when v_total = 0 then 0
      else round((v_no_show::numeric / v_total) * 100, 2) end,
    'buckets', v_buckets
  );
end;
$$;
