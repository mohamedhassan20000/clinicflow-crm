-- Phase 3: make the operational report RPCs scope-aware for doctors & assistants.
--
-- These RPCs are SECURITY INVOKER and read `public.appointments`, whose
-- role-scoped SELECT policy already restricts a doctor to their own appointments
-- and an assistant to their assigned doctors' appointments. The previous blanket
-- `if v_role = 'doctor' then raise 42501` therefore did nothing except forbid a
-- role that RLS would already have scoped. Removing it lets a doctor / assistant
-- see the SAME reports filtered to exactly the data they are authorized for —
-- never another doctor's, another clinic's, or clinic-wide data.
--
-- Revenue, doctor-performance and receptionist-performance RPCs are intentionally
-- NOT changed here: they remain admin/manager (revenue also receptionist-denied)
-- so clinic-wide financial and administrative reports stay closed to doctors and
-- assistants, per the authorization model.

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
