-- Phase 6 analytics completion: historical replaced originals must never
-- inflate performance sessions/bookings or grouped AI totals. Dedicated
-- replacement counts/rates remain available through the cancellation,
-- no-show, and AI appointment-stat surfaces.

create or replace function public.get_doctor_performance_report(
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
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'manager'::public.user_role]) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return (
    with appt as (
      select
        a.doctor_id,
        a.patient_id,
        a.department_id,
        a.status,
        coalesce(a.paid_amount, 0)
          + coalesce(a.secondary_amount, 0)
          + coalesce(a.insurance_amount, 0) as collected
      from public.appointments a
      where a.clinic_id = v_clinic_id
        and a.deleted_at is null
        and a.status <> 'replaced'::public.appointment_status
        and a.scheduled_at >= p_start
        and a.scheduled_at <= p_end
    ),
    clinic_totals as (
      select
        count(distinct patient_id) as clinic_patients,
        coalesce(sum(collected), 0) as clinic_revenue
      from appt
      where status = 'completed'::public.appointment_status
    ),
    per_doctor as (
      select
        a.doctor_id,
        pr.full_name,
        pr.department_id as dept_id,
        count(*) as sessions,
        count(*) filter (where status = 'completed'::public.appointment_status) as completed,
        count(*) filter (where status = 'cancelled'::public.appointment_status) as cancelled,
        count(*) filter (where status = 'no_show'::public.appointment_status) as no_show,
        count(distinct patient_id) filter (
          where status = 'completed'::public.appointment_status
        ) as unique_patients,
        coalesce(sum(collected) filter (
          where status = 'completed'::public.appointment_status
        ), 0) as revenue
      from appt a
      join public.profiles pr on pr.id = a.doctor_id
      group by a.doctor_id, pr.full_name, pr.department_id
    ),
    dept_totals as (
      select
        dept_id,
        coalesce(sum(unique_patients), 0) as dept_patients,
        coalesce(sum(revenue), 0) as dept_revenue
      from per_doctor
      where dept_id is not null
      group by dept_id
    )
    select jsonb_build_object(
      'doctors', coalesce((
        select jsonb_agg(jsonb_build_object(
          'doctorId', d.doctor_id,
          'doctorName', d.full_name,
          'departmentId', d.dept_id,
          'sessions', d.sessions,
          'completed', d.completed,
          'cancelled', d.cancelled,
          'noShow', d.no_show,
          'uniquePatients', d.unique_patients,
          'revenue', d.revenue,
          'completionRate', case when d.sessions = 0 then 0
            else round((d.completed::numeric / d.sessions) * 100, 1) end,
          'cancellationRate', case when d.sessions = 0 then 0
            else round((d.cancelled::numeric / d.sessions) * 100, 1) end,
          'noShowRate', case when d.sessions = 0 then 0
            else round((d.no_show::numeric / d.sessions) * 100, 1) end,
          'deptPatientShare', case
            when dt.dept_patients is null or dt.dept_patients = 0 then 0
            else round((d.unique_patients::numeric / dt.dept_patients) * 100, 1) end,
          'clinicPatientShare', case when ct.clinic_patients = 0 then 0
            else round((d.unique_patients::numeric / ct.clinic_patients) * 100, 1) end,
          'deptRevenueShare', case
            when dt.dept_revenue is null or dt.dept_revenue = 0 then 0
            else round((d.revenue::numeric / dt.dept_revenue) * 100, 1) end,
          'clinicRevenueShare', case when ct.clinic_revenue = 0 then 0
            else round((d.revenue::numeric / ct.clinic_revenue) * 100, 1) end
        ) order by d.revenue desc)
        from per_doctor d
        left join dept_totals dt on dt.dept_id = d.dept_id
        cross join clinic_totals ct
      ), '[]'::jsonb)
    )
    from clinic_totals
  );
end;
$$;

create or replace function public.get_receptionist_performance_report(
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
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'manager'::public.user_role]) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return (
    with appt_by_creator as (
      select created_by, count(*) as booked
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
        and status <> 'replaced'::public.appointment_status
        and created_at >= p_start
        and created_at <= p_end
      group by created_by
    ),
    clinic_appt_total as (
      select greatest(count(*), 1) as total
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
        and status <> 'replaced'::public.appointment_status
        and created_at >= p_start
        and created_at <= p_end
    ),
    fu_by_recorder as (
      select recorded_by, count(*) as handled
      from public.follow_ups
      where clinic_id = v_clinic_id
        and recorded_at >= p_start
        and recorded_at <= p_end
      group by recorded_by
    ),
    clinic_fu_total as (
      select greatest(count(*), 1) as total
      from public.follow_ups
      where clinic_id = v_clinic_id
        and recorded_at >= p_start
        and recorded_at <= p_end
    ),
    receptionists as (
      select id, full_name
      from public.profiles
      where clinic_id = v_clinic_id
        and role = 'receptionist'::public.user_role
        and is_active = true
        and is_deleted = false
        and deleted_at is null
    )
    select jsonb_build_object(
      'receptionists', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', r.id,
          'name', r.full_name,
          'appointmentsBooked', coalesce(ab.booked, 0),
          'appointmentShare', round((coalesce(ab.booked, 0)::numeric / ct.total) * 100, 1),
          'followupsHandled', coalesce(fc.handled, 0),
          'followupShare', round((coalesce(fc.handled, 0)::numeric / ft.total) * 100, 1)
        ) order by coalesce(ab.booked, 0) desc)
        from receptionists r
        left join appt_by_creator ab on ab.created_by = r.id
        left join fu_by_recorder fc on fc.recorded_by = r.id
        cross join clinic_appt_total ct
        cross join clinic_fu_total ft
      ), '[]'::jsonb)
    )
    from clinic_appt_total, clinic_fu_total
  );
end;
$$;

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
    count(*) filter (where a.status = 'completed'::public.appointment_status),
    count(*) filter (where a.status = 'replaced'::public.appointment_status)
  into v_total, v_cancelled, v_no_show, v_completed, v_replaced
  from public.appointments a
  where a.clinic_id = v_clinic_id
    and a.deleted_at is null
    and a.scheduled_at >= p_start
    and a.scheduled_at <= p_end;

  with grouped as (
    select
      case p_group_by
        when 'status' then a.status::text
        when 'doctor' then coalesce(doc.full_name, 'Unassigned')
        else coalesce(d.name, 'Unassigned')
      end as bucket,
      count(*) filter (
        where a.status <> 'replaced'::public.appointment_status
      ) as total,
      count(*) filter (
        where a.status = 'cancelled'::public.appointment_status
      ) as cancelled,
      count(*) filter (
        where a.status = 'no_show'::public.appointment_status
      ) as no_show,
      count(*) filter (
        where a.status = 'completed'::public.appointment_status
      ) as completed,
      count(*) filter (
        where a.status = 'replaced'::public.appointment_status
      ) as replaced
    from public.appointments a
    left join public.profiles doc on doc.id = a.doctor_id
    left join public.departments d on d.id = a.department_id
    where a.clinic_id = v_clinic_id
      and a.deleted_at is null
      and a.scheduled_at >= p_start
      and a.scheduled_at <= p_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucket', g.bucket,
        'total', g.total,
        'cancelled', g.cancelled,
        'no_show', g.no_show,
        'completed', g.completed,
        'replaced', g.replaced,
        'replacement_rate', case when (g.total + g.replaced) = 0 then 0
          else round((g.replaced::numeric / (g.total + g.replaced)) * 100, 2) end
      )
      order by (g.total + g.replaced) desc, g.bucket asc
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
