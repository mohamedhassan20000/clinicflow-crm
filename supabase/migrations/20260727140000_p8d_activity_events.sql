-- Phase 8D: Unified Activity Timeline / Audit Trail.
--
-- A durable, append-only, actor-level activity log that becomes the source of
-- truth for operational accountability and (in later sub-phases 8B/8C) actor-level
-- KPIs. It is deliberately distinct from the generic table-diff `audit_logs`:
--   * `audit_logs` is an admin/manager-only raw before/after row dump.
--   * `activity_events` records *semantic* actions (appointment.confirmed,
--     follow_up.recorded, ...), carries the actor's role, distinguishes
--     system-generated events, and is readable — scoped — by the same
--     doctors/assistants who may already read the underlying entity.
--
-- Design invariants (see docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md §8D):
--   * Append-only. No UPDATE/DELETE for authenticated roles; corrections are new
--     events, history is never rewritten.
--   * Spoof-proof write boundary. Events are written ONLY by a SECURITY DEFINER
--     trigger that stamps actor_id = auth.uid() server-side. Authenticated roles
--     have no INSERT grant and no INSERT policy, so a client can never forge an
--     actor, role, clinic, or timestamp.
--   * Read authorization mirrors entity visibility: admins/managers/receptionists
--     clinic-wide (matching their clinic-wide appointment/patient/follow-up read
--     scope); doctors and assistants only for events whose owning doctor/patient
--     falls in their authorized scope — assistants never see events outside their
--     supervised-doctor union.
--   * System-generated actions (reminders, cron, service-role writes) get
--     actor_id = null and is_system = true, clearly distinguishable from humans.
--   * Present state stays authoritative in the entity tables; this trail is
--     authoritative only for actor-level *history*. Cutover is begin-from-now:
--     the trigger captures events going forward, with no synthetic backfill of
--     pre-existing rows (documented in the Phase 8D checkpoint).

-- ── table ─────────────────────────────────────────────────────────────────────
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role public.user_role,
  is_system boolean not null default false,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  patient_id uuid,
  doctor_id uuid,
  previous_state jsonb,
  new_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

comment on table public.activity_events is
  'Append-only semantic activity trail (Phase 8D). Written only by the '
  'record_activity_event() SECURITY DEFINER trigger, which stamps the actor from '
  'auth.uid(). Read scope mirrors entity visibility. Authoritative for actor-level '
  'history only; entity tables remain authoritative for present state.';
comment on column public.activity_events.actor_id is
  'Human actor (auth.uid()) or null for system/service-role events (is_system).';
comment on column public.activity_events.doctor_id is
  'Denormalized owning doctor for scope checks; survives entity deletion.';

create index if not exists activity_events_entity_idx
  on public.activity_events (clinic_id, entity_type, entity_id, occurred_at desc);
create index if not exists activity_events_actor_idx
  on public.activity_events (clinic_id, actor_id, occurred_at desc);
create index if not exists activity_events_doctor_idx
  on public.activity_events (clinic_id, doctor_id, occurred_at desc);
create index if not exists activity_events_patient_idx
  on public.activity_events (clinic_id, patient_id, occurred_at desc);

-- ── write boundary: one SECURITY DEFINER trigger for every covered entity ───────
-- Derives the semantic action from the row transition, stamps the actor and role
-- from the authenticated session (null ⇒ system), denormalizes the owning
-- doctor/patient for scoped reads, and records a curated (non-noise) snapshot.
create or replace function public.record_activity_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_is_system boolean := (auth.uid() is null);
  v_role public.user_role;
  v_entity_type text;
  v_clinic uuid;
  v_entity_id uuid;
  v_patient uuid;
  v_doctor uuid;
  v_action text;
  v_prev jsonb;
  v_new jsonb;
begin
  -- Best-effort role capture; system/service writes leave it null.
  if not v_is_system then
    select p.role into v_role from public.profiles p where p.id = v_actor;
  end if;

  if tg_table_name = 'appointments' then
    v_entity_type := 'appointment';
    v_entity_id := coalesce(new.id, old.id);
    v_clinic := coalesce(new.clinic_id, old.clinic_id);
    v_patient := coalesce(new.patient_id, old.patient_id);
    v_doctor := coalesce(new.doctor_id, old.doctor_id);

    if tg_op = 'INSERT' then
      v_action := 'appointment.created';
    elsif tg_op = 'DELETE' then
      v_action := 'appointment.deleted';
    elsif new.status is distinct from old.status then
      v_action := case new.status
        when 'confirmed' then 'appointment.confirmed'
        when 'arrived' then 'appointment.checked_in'
        when 'in_session' then 'appointment.session_started'
        when 'completed' then 'appointment.completed'
        when 'cancelled' then 'appointment.cancelled'
        when 'no_show' then 'appointment.no_show'
        when 'replaced' then 'appointment.replaced'
        else 'appointment.status_changed'
      end;
    elsif new.scheduled_at is distinct from old.scheduled_at then
      v_action := 'appointment.rescheduled';
    elsif (new.deleted_at is not null) and (old.deleted_at is null) then
      v_action := 'appointment.trashed';
    elsif (new.deleted_at is null) and (old.deleted_at is not null) then
      v_action := 'appointment.restored';
    else
      v_action := 'appointment.updated';
    end if;

    v_prev := case when tg_op = 'INSERT' then null else jsonb_build_object(
      'status', old.status,
      'scheduled_at', old.scheduled_at,
      'doctor_id', old.doctor_id,
      'duration_minutes', old.duration_minutes,
      'total_amount', old.total_amount,
      'paid_amount', old.paid_amount,
      'outstanding_amount', old.outstanding_amount,
      'deleted_at', old.deleted_at
    ) end;
    v_new := case when tg_op = 'DELETE' then null else jsonb_build_object(
      'status', new.status,
      'scheduled_at', new.scheduled_at,
      'doctor_id', new.doctor_id,
      'duration_minutes', new.duration_minutes,
      'total_amount', new.total_amount,
      'paid_amount', new.paid_amount,
      'outstanding_amount', new.outstanding_amount,
      'deleted_at', new.deleted_at
    ) end;

  elsif tg_table_name = 'follow_ups' then
    v_entity_type := 'follow_up';
    v_entity_id := coalesce(new.id, old.id);
    v_clinic := coalesce(new.clinic_id, old.clinic_id);
    v_patient := coalesce(new.patient_id, old.patient_id);
    -- Derive the owning doctor for scope (best effort): the linked appointment's
    -- doctor, else the patient's assigned doctor.
    select a.doctor_id into v_doctor from public.appointments a
      where a.id = coalesce(new.appointment_id, old.appointment_id);
    if v_doctor is null then
      select p.assigned_doctor_id into v_doctor from public.patients p
        where p.id = v_patient;
    end if;

    if tg_op = 'INSERT' then
      v_action := 'follow_up.recorded';
    elsif tg_op = 'DELETE' then
      v_action := 'follow_up.deleted';
    elsif new.outcome is distinct from old.outcome then
      v_action := 'follow_up.outcome_changed';
    else
      v_action := 'follow_up.updated';
    end if;

    v_prev := case when tg_op = 'INSERT' then null else jsonb_build_object(
      'outcome', old.outcome,
      'appointment_id', old.appointment_id,
      'recorded_at', old.recorded_at
    ) end;
    v_new := case when tg_op = 'DELETE' then null else jsonb_build_object(
      'outcome', new.outcome,
      'appointment_id', new.appointment_id,
      'recorded_at', new.recorded_at
    ) end;
  else
    return coalesce(new, old);
  end if;

  insert into public.activity_events (
    clinic_id, actor_id, actor_role, is_system, action,
    entity_type, entity_id, patient_id, doctor_id, previous_state, new_state
  ) values (
    v_clinic, v_actor, v_role, v_is_system, v_action,
    v_entity_type, v_entity_id, v_patient, v_doctor, v_prev, v_new
  );

  return coalesce(new, old);
end;
$$;
alter function public.record_activity_event() owner to postgres;
revoke all on function public.record_activity_event() from public;
grant execute on function public.record_activity_event() to authenticated, service_role;

drop trigger if exists trg_activity_appointments on public.appointments;
create trigger trg_activity_appointments
  after insert or update or delete on public.appointments
  for each row execute function public.record_activity_event();

drop trigger if exists trg_activity_follow_ups on public.follow_ups;
create trigger trg_activity_follow_ups
  after insert or update or delete on public.follow_ups
  for each row execute function public.record_activity_event();

-- ── grants & RLS (append-only, scoped reads) ────────────────────────────────────
alter table public.activity_events enable row level security;

-- Authenticated roles can only SELECT (subject to the policy below). All writes
-- go through the SECURITY DEFINER trigger, which runs as the table owner and so
-- bypasses RLS. service_role keeps full access for tooling/backfill/tests.
revoke all on table public.activity_events from anon, authenticated;
grant select on table public.activity_events to authenticated;
grant all on table public.activity_events to service_role;

drop policy if exists "activity_events_select_scoped" on public.activity_events;
create policy "activity_events_select_scoped"
on public.activity_events
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ]
    )
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        doctor_id = auth.uid()
        or exists (
          select 1
          from public.patients p
          where p.id = activity_events.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and (
              p.assigned_doctor_id = auth.uid()
              or (
                public.auth_department_id() is not null
                and p.department_id = public.auth_department_id()
              )
            )
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and (
        doctor_id = any (public.auth_supervised_doctor_ids())
        or exists (
          select 1
          from public.patients p
          where p.id = activity_events.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
        )
      )
    )
  )
);
-- No INSERT/UPDATE/DELETE policies: authenticated writes are denied outright,
-- which — together with the revoked grants — makes the trail append-only and the
-- actor un-forgeable.
