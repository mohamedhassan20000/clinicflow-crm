-- Phase 8B: "My Performance" — a doctor's own operational performance report,
-- distinct from the administrative clinic-wide Doctor Performance report.
--
-- Scope: the CURRENT DOCTOR only. Unlike an admin/manager who sees clinic-wide
-- rankings, this report is the caller's own factual operational KPIs. The RPC is
-- SECURITY INVOKER and explicitly filters `doctor_id = auth.uid()` so it reports
-- only appointments the caller is the treating doctor for — never the broader
-- RLS scope (a doctor's RLS also admits their department's / assigned patients'
-- appointments booked under other doctors, which is not "my performance").
--
-- The role guard hard-denies every role except `doctor`. Admins and managers use
-- the clinic-wide `get_doctor_performance_report`; assistants have no personal
-- operational performance of their own (their operational activity is measured
-- under 8C, against the doctors they assist). Letting either in here would be a
-- category error, so both are refused.
--
-- KPIs are computed only from authoritative system data: appointment lifecycle
-- counts (with `replaced` kept as its own reschedule event, never conflated with
-- cancellations or no-shows — Phase 6), follow-up completion derived from the
-- doctor's own completed appointments, unique patients, average patients per
-- active day, and a completed-appointment trend versus the immediately preceding
-- equal-length period. There are no subjective or manually entered ratings.

create or replace function public.get_my_performance_summary(
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
  v_span interval := p_end - p_start;
  v_prev_start timestamptz := p_start - v_span;
  v_summary jsonb;
begin
  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  -- Self-scoped operational report: doctors only. Admin/manager use the
  -- clinic-wide doctor-performance report; assistants are covered by 8C.
  if v_role <> 'doctor'::public.user_role then
    raise exception 'Not authorized to view personal performance'
      using errcode = '42501';
  end if;

  with base as (
    -- The doctor's OWN sessions only. Explicit doctor_id filter, not just RLS:
    -- "my performance" is the appointments I am the treating doctor for.
    select
      a.id,
      a.status,
      a.patient_id,
      a.scheduled_at,
      exists (
        select 1
        from public.follow_ups f
        where f.appointment_id = a.id
          and f.clinic_id = v_clinic_id
      ) as has_followup
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.doctor_id = auth.uid()
      and a.deleted_at is null
      and a.scheduled_at >= p_start
      and a.scheduled_at <= p_end
  ),
  totals as (
    select
      -- `replaced` originals are a reschedule event, excluded from the real
      -- appointment denominator (Phase 6), but counted for the replacement rate.
      count(*) filter (where status <> 'replaced'::public.appointment_status) as appointment_count,
      count(*) filter (where status = 'completed'::public.appointment_status) as completed_count,
      count(*) filter (where status = 'cancelled'::public.appointment_status) as cancelled_count,
      count(*) filter (where status = 'no_show'::public.appointment_status) as no_show_count,
      count(*) filter (where status = 'replaced'::public.appointment_status) as replaced_count,
      count(*) as grand_total,
      count(distinct patient_id) filter (
        where status = 'completed'::public.appointment_status
      ) as unique_patients,
      count(distinct (scheduled_at at time zone 'UTC')::date) filter (
        where status = 'completed'::public.appointment_status
      ) as active_days,
      count(*) filter (
        where status = 'completed'::public.appointment_status
      ) as followups_eligible,
      count(*) filter (
        where status = 'completed'::public.appointment_status and has_followup
      ) as followups_completed
    from base
  ),
  previous as (
    -- Completed sessions in the immediately preceding equal-length period, for a
    -- factual trend. Same doctor/clinic/non-deleted filters.
    select count(*) as prev_completed
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.doctor_id = auth.uid()
      and a.deleted_at is null
      and a.status = 'completed'::public.appointment_status
      and a.scheduled_at >= v_prev_start
      and a.scheduled_at < p_start
  )
  select jsonb_build_object(
    'appointmentCount', t.appointment_count,
    'completedCount', t.completed_count,
    'cancelledCount', t.cancelled_count,
    'cancellationRate',
      case when t.appointment_count = 0 then 0
        else round((t.cancelled_count::numeric / t.appointment_count) * 100, 1) end,
    'noShowCount', t.no_show_count,
    'noShowRate',
      case when t.appointment_count = 0 then 0
        else round((t.no_show_count::numeric / t.appointment_count) * 100, 1) end,
    'replacedCount', t.replaced_count,
    'replacementRate',
      case when t.grand_total = 0 then 0
        else round((t.replaced_count::numeric / t.grand_total) * 100, 1) end,
    'uniquePatients', t.unique_patients,
    'activeDays', t.active_days,
    'averagePatientsPerDay',
      case when t.active_days = 0 then 0
        else round(t.completed_count::numeric / t.active_days, 1) end,
    'followupsEligible', t.followups_eligible,
    'followupsCompleted', t.followups_completed,
    'followupCompletionRate',
      case when t.followups_eligible = 0 then 0
        else round((t.followups_completed::numeric / t.followups_eligible) * 100, 1) end,
    -- Completed appointments still awaiting a follow-up (past due by definition:
    -- the appointment is completed and no follow-up has been recorded).
    'overdueFollowups', t.followups_eligible - t.followups_completed,
    'previousCompletedCount', p.prev_completed,
    -- Null when there is no prior baseline, so the UI can show "—" rather than a
    -- misleading 0% or a divide-by-zero.
    'completedTrendPct',
      case when p.prev_completed = 0 then null
        else round(
          ((t.completed_count - p.prev_completed)::numeric / p.prev_completed) * 100,
          1
        ) end
  )
  into v_summary
  from totals t
  cross join previous p;

  return v_summary;
end;
$$;
revoke all on function public.get_my_performance_summary(timestamptz, timestamptz)
from public;
grant execute on function public.get_my_performance_summary(timestamptz, timestamptz)
to authenticated, service_role;
