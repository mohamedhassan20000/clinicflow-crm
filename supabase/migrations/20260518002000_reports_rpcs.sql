create index if not exists idx_appt_clinic_scheduled_status_doctor
  on public.appointments (clinic_id, scheduled_at, status, doctor_id)
  where deleted_at is null;

create index if not exists idx_followups_clinic_recorded_outcome
  on public.follow_ups (clinic_id, recorded_at, outcome);

create or replace function public.get_cancellation_report(
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
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role = 'doctor'::public.user_role then
    raise exception 'Not authorized'
      using errcode = '42501';
  end if;

  return (
    with base as (
      select id, status, cancellation_reason, doctor_id, patient_id
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
        and scheduled_at >= p_start
        and scheduled_at <= p_end
    ),
    totals as (
      select
        count(*) as total_appointments,
        count(*) filter (where status = 'cancelled'::public.appointment_status) as cancelled_count
      from base
    ),
    by_doctor as (
      select
        a.doctor_id,
        pr.full_name as doctor_name,
        count(*) as total,
        count(*) filter (where a.status = 'cancelled'::public.appointment_status) as cancelled
      from base a
      join public.profiles pr on pr.id = a.doctor_id
      group by a.doctor_id, pr.full_name
    ),
    by_reason as (
      select cancellation_reason as reason, count(*) as cnt
      from base
      where status = 'cancelled'::public.appointment_status
        and cancellation_reason is not null
      group by cancellation_reason
      order by cnt desc
      limit 10
    )
    select jsonb_build_object(
      'totalAppointments', t.total_appointments,
      'cancelledCount', t.cancelled_count,
      'cancellationRate',
        case
          when t.total_appointments = 0 then 0
          else round((t.cancelled_count::numeric / t.total_appointments) * 100, 1)
        end,
      'byDoctor', coalesce((
        select jsonb_agg(jsonb_build_object(
          'doctorId', d.doctor_id,
          'doctorName', d.doctor_name,
          'total', d.total,
          'cancelled', d.cancelled,
          'rate',
            case
              when d.total = 0 then 0
              else round((d.cancelled::numeric / d.total) * 100, 1)
            end
        ) order by d.cancelled desc)
        from by_doctor d
      ), '[]'::jsonb),
      'byReason', coalesce((
        select jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.cnt))
        from by_reason r
      ), '[]'::jsonb)
    )
    from totals t
  );
end;
$$;

create or replace function public.get_no_show_report(
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
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role = 'doctor'::public.user_role then
    raise exception 'Not authorized'
      using errcode = '42501';
  end if;

  return (
    with base as (
      select id, status, no_show_reason, doctor_id, patient_id
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
        and scheduled_at >= p_start
        and scheduled_at <= p_end
    ),
    totals as (
      select
        count(*) as total_appointments,
        count(*) filter (where status = 'no_show'::public.appointment_status) as no_show_count
      from base
    ),
    by_doctor as (
      select
        a.doctor_id,
        pr.full_name as doctor_name,
        count(*) as total,
        count(*) filter (where a.status = 'no_show'::public.appointment_status) as no_show
      from base a
      join public.profiles pr on pr.id = a.doctor_id
      group by a.doctor_id, pr.full_name
    )
    select jsonb_build_object(
      'totalAppointments', t.total_appointments,
      'noShowCount', t.no_show_count,
      'noShowRate',
        case
          when t.total_appointments = 0 then 0
          else round((t.no_show_count::numeric / t.total_appointments) * 100, 1)
        end,
      'byDoctor', coalesce((
        select jsonb_agg(jsonb_build_object(
          'doctorId', d.doctor_id,
          'doctorName', d.doctor_name,
          'total', d.total,
          'noShow', d.no_show,
          'rate',
            case
              when d.total = 0 then 0
              else round((d.no_show::numeric / d.total) * 100, 1)
            end
        ) order by d.no_show desc)
        from by_doctor d
      ), '[]'::jsonb)
    )
    from totals t
  );
end;
$$;

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
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'manager'::public.user_role]) then
    raise exception 'Not authorized'
      using errcode = '42501';
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
          'completionRate',
            case
              when d.sessions = 0 then 0
              else round((d.completed::numeric / d.sessions) * 100, 1)
            end,
          'cancellationRate',
            case
              when d.sessions = 0 then 0
              else round((d.cancelled::numeric / d.sessions) * 100, 1)
            end,
          'noShowRate',
            case
              when d.sessions = 0 then 0
              else round((d.no_show::numeric / d.sessions) * 100, 1)
            end,
          'deptPatientShare',
            case
              when dt.dept_patients is null or dt.dept_patients = 0 then 0
              else round((d.unique_patients::numeric / dt.dept_patients) * 100, 1)
            end,
          'clinicPatientShare',
            case
              when ct.clinic_patients = 0 then 0
              else round((d.unique_patients::numeric / ct.clinic_patients) * 100, 1)
            end,
          'deptRevenueShare',
            case
              when dt.dept_revenue is null or dt.dept_revenue = 0 then 0
              else round((d.revenue::numeric / dt.dept_revenue) * 100, 1)
            end,
          'clinicRevenueShare',
            case
              when ct.clinic_revenue = 0 then 0
              else round((d.revenue::numeric / ct.clinic_revenue) * 100, 1)
            end
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
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  if v_role <> all (array['admin'::public.user_role, 'manager'::public.user_role]) then
    raise exception 'Not authorized'
      using errcode = '42501';
  end if;

  return (
    with appt_by_creator as (
      select created_by, count(*) as booked
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
        and created_at >= p_start
        and created_at <= p_end
      group by created_by
    ),
    clinic_appt_total as (
      select greatest(count(*), 1) as total
      from public.appointments
      where clinic_id = v_clinic_id
        and deleted_at is null
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

revoke execute on function public.get_cancellation_report(timestamptz, timestamptz)
from public;
revoke execute on function public.get_no_show_report(timestamptz, timestamptz)
from public;
revoke execute on function public.get_doctor_performance_report(timestamptz, timestamptz)
from public;
revoke execute on function public.get_receptionist_performance_report(timestamptz, timestamptz)
from public;

grant execute on function public.get_cancellation_report(timestamptz, timestamptz)
to authenticated, service_role;
grant execute on function public.get_no_show_report(timestamptz, timestamptz)
to authenticated, service_role;
grant execute on function public.get_doctor_performance_report(timestamptz, timestamptz)
to authenticated, service_role;
grant execute on function public.get_receptionist_performance_report(timestamptz, timestamptz)
to authenticated, service_role;
