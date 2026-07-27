-- Phase 8C: "My Assistant Performance" — a section within My Performance that
-- lets a doctor see the operational performance of the assistants assigned to
-- THEM, each assistant shown separately.
--
-- Scope & authorization (see docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md §8C):
--   * Doctor-only. Every role except `doctor` is hard-denied (errcode 42501),
--     exactly like My Performance (8B). Admins/managers use the clinic-wide
--     staff reports; assistants must never see another assistant's performance.
--   * A doctor sees ONLY assistants assigned to them (assistant_doctor_assignments
--     where doctor_id = the caller). The assignment table is not readable by
--     doctors under RLS, so this RPC is SECURITY DEFINER and re-derives the
--     caller from auth.uid(); it constrains every read to the caller's own
--     clinic and own doctor_id, so it can widen nothing.
--   * Multi-assignment isolation. Metrics are drawn from the Phase 8D
--     `activity_events` trail filtered by `doctor_id = auth.uid()` (the
--     denormalized owning doctor of each event). An assistant who also assists
--     another doctor contributes to THIS report only for activity performed on
--     the calling doctor's own entities — activity for other doctors never leaks.
--
-- Metrics are factual actor-level counts from the append-only activity trail —
-- there is no composite or subjective score. Only actions the 8D trigger
-- actually records (appointment lifecycle + follow-ups) are counted; there is no
-- invoice activity trail yet, so no invoice KPIs are fabricated.

create or replace function public.get_my_assistant_performance(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doctor uuid := auth.uid();
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
  v_assistants jsonb;
begin
  if v_doctor is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  -- Doctor-only, mirroring My Performance (8B). An assistant must never see
  -- another assistant's performance through this surface.
  if v_role <> 'doctor'::public.user_role then
    raise exception 'Not authorized to view assistant performance'
      using errcode = '42501';
  end if;

  -- One row per assistant assigned to the calling doctor (active, same clinic),
  -- with actor-level counts from the activity trail scoped to THIS doctor's
  -- entities and the requested window. Assistants with no activity still appear
  -- with zero counts, so the doctor sees every assigned assistant.
  select coalesce(
    jsonb_agg(row_to_json(t)::jsonb order by t."assistantName", t."assistantId"),
    '[]'::jsonb
  )
  into v_assistants
  from (
    select
      a.assistant_id as "assistantId",
      p.full_name as "assistantName",
      count(e.id) as "totalActions",
      count(e.id) filter (where e.action = 'appointment.created') as "appointmentsBooked",
      count(e.id) filter (where e.action = 'appointment.confirmed') as "confirmations",
      count(e.id) filter (where e.action = 'appointment.checked_in') as "checkIns",
      count(e.id) filter (where e.action = 'appointment.completed') as "completions",
      count(e.id) filter (where e.action = 'appointment.cancelled') as "cancellations",
      count(e.id) filter (where e.action = 'appointment.no_show') as "noShows",
      count(e.id) filter (where e.action = 'appointment.rescheduled') as "reschedules",
      count(e.id) filter (where e.action = 'appointment.replaced') as "replacements",
      count(e.id) filter (
        where e.action in (
          'appointment.confirmed',
          'appointment.checked_in',
          'appointment.session_started',
          'appointment.completed',
          'appointment.cancelled',
          'appointment.no_show',
          'appointment.replaced',
          'appointment.status_changed'
        )
      ) as "statusChanges",
      count(e.id) filter (where e.action = 'follow_up.recorded') as "followUpsRecorded",
      count(e.id) filter (
        where e.action in ('follow_up.outcome_changed', 'follow_up.updated')
      ) as "followUpUpdates"
    from public.assistant_doctor_assignments a
    join public.profiles p
      on p.id = a.assistant_id
     and p.clinic_id = a.clinic_id
     and p.role = 'assistant'::public.user_role
     and p.is_active = true
     and p.is_deleted = false
     and p.deleted_at is null
    left join public.activity_events e
      on e.actor_id = a.assistant_id
     and e.clinic_id = v_clinic_id
     -- The event's owning doctor is the calling doctor: this is the
     -- multi-assignment isolation guarantee. Activity the assistant performed
     -- for a DIFFERENT doctor carries that doctor's id and is excluded.
     and e.doctor_id = v_doctor
     and e.occurred_at >= p_start
     and e.occurred_at <= p_end
    where a.doctor_id = v_doctor
      and a.clinic_id = v_clinic_id
    group by a.assistant_id, p.full_name
  ) t;

  return jsonb_build_object('assistants', v_assistants);
end;
$$;
alter function public.get_my_assistant_performance(timestamptz, timestamptz)
  owner to postgres;
revoke all on function public.get_my_assistant_performance(timestamptz, timestamptz)
  from public;
grant execute on function public.get_my_assistant_performance(timestamptz, timestamptz)
  to authenticated, service_role;
