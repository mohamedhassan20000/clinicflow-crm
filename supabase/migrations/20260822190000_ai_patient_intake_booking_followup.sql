-- Follow-up delta for 20260822120000_ai_patient_intake_booking_upgrade.sql.
--
-- The original migration was already applied to the remote database before the
-- post-push review fixes were folded back into its file. Supabase tracks
-- migrations by version, so those later edits will never be replayed there.
-- This migration carries only the delta: the corrected function bodies and the
-- widened staff-read policies.
--
-- Verified against the live remote catalog: table columns, constraints, RLS
-- enablement, indexes, triggers and function grants already match the intended
-- schema, and public.register_patient_from_conversation is already dropped.
-- The remaining drift is eight function bodies and two RLS policies, so this
-- file is pure create-or-replace plus policy recreation. It touches no data,
-- adds no columns and is safe to run repeatedly, including on a database built
-- from the full migration chain (where it is a no-op re-application).

-- Staff read policies. The reviewed-intake queue is a management surface, so
-- managers read it alongside admins and receptionists.
drop policy if exists ai_patient_intakes_staff_read on public.ai_patient_intakes;
create policy ai_patient_intakes_staff_read
  on public.ai_patient_intakes for select to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role
      ]
    )
  );

drop policy if exists ai_appointment_requests_staff_read on public.ai_appointment_requests;
create policy ai_appointment_requests_staff_read
  on public.ai_appointment_requests for select to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'receptionist'::public.user_role,
        'manager'::public.user_role
      ]
    )
  );

-- A soft-deleted patient must not turn a WhatsApp thread into an authorization
-- black hole. Return the conversation as unlinked when its stored patient
-- reference is no longer active; the staging RPC below clears that stale
-- reference under lock before writing a new reviewed intake.
create or replace function public.resolve_patient_ai_context(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (
  clinic_id uuid,
  conversation_id uuid,
  patient_id uuid,
  linked boolean,
  identity_verified_at timestamptz,
  identity_locked_until timestamptz,
  clinic_name text,
  clinic_locale text,
  clinic_timezone text,
  clinic_country text,
  participant_address text,
  ai_paused boolean,
  collected_data jsonb,
  pending_clarification jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  return query
  select
    conversation.clinic_id,
    conversation.id,
    case when patient.id is null then null else conversation.patient_id end,
    patient.id is not null,
    case when patient.id is null then null else conversation.identity_verified_at end,
    case when patient.id is null then null else conversation.identity_verification_locked_until end,
    clinic.name,
    clinic.locale,
    clinic.timezone,
    clinic.country::text,
    conversation.participant_address,
    conversation.ai_paused_at is not null,
    coalesce(conversation.ai_collected_data, '{}'::jsonb),
    conversation.ai_pending_clarification
  from public.conversations as conversation
  join public.clinics as clinic
    on clinic.id = conversation.clinic_id and clinic.is_active
  left join public.patients as patient
    on patient.id = conversation.patient_id
   and patient.clinic_id = conversation.clinic_id
   and not patient.is_deleted and patient.deleted_at is null
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status;
end;
$$;

revoke all on function public.resolve_patient_ai_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_patient_ai_context(uuid, uuid)
  to service_role;

-- Shared availability guard for provisional requests and intake approval. The
-- application still calculates and presents slots with computeAvailability;
-- this is the transactional recheck which prevents a stale/delayed AI turn.
create or replace function public.ai_requested_slot_is_available(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_local timestamp;
  v_local_date date;
  v_local_time time;
  v_day integer;
  v_end timestamptz;
begin
  select c.timezone into v_timezone
  from public.clinics c
  where c.id = p_clinic_id and c.is_active;
  if not found or p_scheduled_at < clock_timestamp() + interval '24 hours' then return false; end if;
  if p_duration_minutes < 15 or p_duration_minutes > 240
     or mod(p_duration_minutes, 15) <> 0 then return false; end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = p_doctor_id and p.clinic_id = p_clinic_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then return false; end if;

  v_local := p_scheduled_at at time zone v_timezone;
  v_local_date := v_local::date;
  v_local_time := v_local::time;
  v_day := extract(dow from v_local)::integer;
  v_end := p_scheduled_at + make_interval(mins => p_duration_minutes);

  if not exists (
    select 1 from public.doctor_schedules s
    where s.clinic_id = p_clinic_id and s.doctor_id = p_doctor_id
      and s.day_of_week = v_day and s.is_enabled
      and (s.valid_from is null or s.valid_from <= v_local_date)
      and (s.valid_until is null or s.valid_until >= v_local_date)
      and s.start_time::time <= v_local_time
      and s.end_time::time >= (v_local + make_interval(mins => p_duration_minutes))::time
  ) then return false; end if;

  if exists (select 1 from public.clinic_working_hours h where h.clinic_id = p_clinic_id)
     and not exists (
       select 1 from public.clinic_working_hours h
       where h.clinic_id = p_clinic_id and h.day_of_week = v_day
         and h.shift_start::time <= v_local_time
         and h.shift_end::time >= (v_local + make_interval(mins => p_duration_minutes))::time
     ) then return false; end if;

  if exists (
    select 1 from public.doctor_unavailability u
    where u.clinic_id = p_clinic_id and u.doctor_id = p_doctor_id
      and u.is_active and u.starts_at < v_end and u.ends_at > p_scheduled_at
  ) then return false; end if;

  if exists (
    select 1 from public.appointments a
    where a.clinic_id = p_clinic_id and a.doctor_id = p_doctor_id
      and a.status = any (array[
        'confirmed'::public.appointment_status,
        'arrived'::public.appointment_status,
        'in_session'::public.appointment_status
      ])
      and a.deleted_at is null
      and p_scheduled_at < a.scheduled_at + make_interval(mins => a.duration_minutes + 15)
      and v_end > a.scheduled_at - interval '15 minutes'
  ) then return false; end if;

  return true;
end;
$$;

revoke all on function public.ai_requested_slot_is_available(uuid, uuid, timestamptz, integer)
  from public, anon, authenticated, service_role;

-- Service-only staging boundary. The phone comes from the WhatsApp thread and
-- identity-sensitive comparisons remain exact. Fuzzy matching never enters it.
create or replace function public.stage_patient_intake_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text,
  p_department_id uuid,
  p_doctor_id uuid
)
returns table (status text, intake_id uuid, attempts_remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_phone text;
  v_phone_match public.patients%rowtype;
  v_phone_count integer;
  v_id_match_id uuid;
  v_id_count integer;
  v_failures integer;
  v_intake_id uuid;
begin
  attempts_remaining := null;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  if v_conversation.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = v_conversation.patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted and p.deleted_at is null
  ) then
    update public.conversations c
    set patient_id = null, patient_link_status = 'unlinked'
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    update public.inbound_messages m
    set patient_id = null
    where m.conversation_id = p_conversation_id
      and m.clinic_id = p_clinic_id
      and m.patient_id = v_conversation.patient_id;
    update public.inbound_message_attachments a
    set patient_id = null
    where a.conversation_id = p_conversation_id
      and a.clinic_id = p_clinic_id
      and a.patient_id = v_conversation.patient_id;
    v_conversation.patient_id := null;
  end if;
  if v_conversation.patient_id is not null then
    status := 'already_linked'; intake_id := null; return next; return;
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp() then
    status := 'identity_locked'; intake_id := null; attempts_remaining := 0; return next; return;
  end if;

  v_phone := nullif(btrim(coalesce(v_conversation.participant_address, '')), '');
  if v_phone is null
     or p_full_name is null or char_length(btrim(p_full_name)) not between 2 and 100
     or p_national_id is null or public.fold_national_id(p_national_id) is null
     or char_length(public.fold_national_id(p_national_id)) not between 5 and 32
     or p_date_of_birth not between date '1900-01-01' and current_date
     or p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_PATIENT_DETAILS';
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.clinic_id = p_clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = p_doctor_id and p.clinic_id = p_clinic_id
      and p.department_id = p_department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INVALID_INTAKE_ASSIGNMENT'; end if;

  select count(*)::integer into v_phone_count
  from public.patients p
  where p.clinic_id = p_clinic_id and p.phone = v_phone
    and not p.is_deleted and p.deleted_at is null;
  if v_phone_count = 1 then
    select p.* into v_phone_match from public.patients p
    where p.clinic_id = p_clinic_id and p.phone = v_phone
      and not p.is_deleted and p.deleted_at is null limit 1;
  end if;
  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_id_match_id, v_id_count
  from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id);

  if v_phone_count > 1 then
    status := 'duplicate_ambiguous'; intake_id := null; return next; return;
  end if;
  if v_phone_count = 1 then
    if (v_id_count > 0 and v_id_match_id is distinct from v_phone_match.id)
       or v_phone_match.date_of_birth is distinct from p_date_of_birth
       or public.fold_national_id(v_phone_match.national_id)
          is distinct from public.fold_national_id(p_national_id)
       or public.fold_patient_name(v_phone_match.full_name)
          is distinct from public.fold_patient_name(p_full_name) then
      update public.conversations c
      set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
          identity_verification_locked_until = case
            when c.identity_verification_failures + 1 >= 5
              then clock_timestamp() + interval '30 minutes'
            else c.identity_verification_locked_until end
      where c.id = p_conversation_id and c.clinic_id = p_clinic_id
      returning c.identity_verification_failures into v_failures;
      status := case when v_failures >= 5 then 'identity_locked' else 'identity_mismatch' end;
      intake_id := null; attempts_remaining := greatest(5 - v_failures, 0);
      return next; return;
    end if;

    update public.conversations c
    set patient_id = v_phone_match.id, patient_link_status = 'automatic'
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    update public.conversations c
    set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
        identity_verification_locked_until = null
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    update public.inbound_messages m set patient_id = v_phone_match.id
    where m.conversation_id = p_conversation_id and m.clinic_id = p_clinic_id and m.patient_id is null;
    update public.inbound_message_attachments a set patient_id = v_phone_match.id
    where a.conversation_id = p_conversation_id and a.clinic_id = p_clinic_id and a.patient_id is null;
    update public.conversations c
    set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
      || jsonb_build_object(
        'department_id', p_department_id,
        'doctor_id', p_doctor_id
      )
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
    status := 'linked_existing'; intake_id := null; return next; return;
  end if;
  if v_id_count > 0 then
    status := 'duplicate_review'; intake_id := null; return next; return;
  end if;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id
  ) values (
    p_clinic_id, p_conversation_id, btrim(p_full_name), p_date_of_birth, v_phone,
    lower(btrim(p_email)), btrim(p_national_id),
    p_department_id, p_doctor_id
  )
  on conflict (clinic_id, conversation_id) do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        updated_at = clock_timestamp()
    where ai_patient_intakes.review_status = 'pending_review'
  returning id into v_intake_id;
  if v_intake_id is null then
    status := 'already_reviewed'; intake_id := null; return next; return;
  end if;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_PATIENT_INTAKE_STAGED', 'ai_patient_intakes', v_intake_id,
    'ai', 'ai_assistant', jsonb_build_object(
      'review_status', 'pending_review', 'department_id', p_department_id,
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id
    )
  );
  update public.conversations c
  set ai_collected_data = coalesce(c.ai_collected_data, '{}'::jsonb)
    || jsonb_build_object(
      'department_id', p_department_id,
      'doctor_id', p_doctor_id
    )
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
  status := 'staged'; intake_id := v_intake_id; return next;
end;
$$;

revoke all on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid
) to service_role;

create or replace function public.create_provisional_ai_appointment_request(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_doctor_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_service_id uuid default null
)
returns table (request_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_intake public.ai_patient_intakes%rowtype;
  v_ttl integer;
  v_cap integer;
  v_request public.ai_appointment_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status for update;
  if not found or v_conversation.patient_id is not null then
    raise exception 'PROVISIONAL_INTAKE_REQUIRED';
  end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  select i.* into v_intake from public.ai_patient_intakes i
  where i.clinic_id = p_clinic_id and i.conversation_id = p_conversation_id
    and i.review_status = 'pending_review' for update;
  if not found or v_intake.doctor_id <> p_doctor_id then
    raise exception 'PROVISIONAL_INTAKE_REQUIRED';
  end if;
  if p_service_id is not null and not exists (
    select 1 from public.services s
    where s.id = p_service_id and s.clinic_id = p_clinic_id
      and s.department_id = v_intake.department_id
      and s.is_active and s.deleted_at is null
  ) then raise exception 'AI_BOOKING_SERVICE_UNAVAILABLE'; end if;
  if p_scheduled_at < clock_timestamp() + interval '24 hours' then
    raise exception 'AI_BOOKING_MINIMUM_NOTICE' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai-intake-booking:' || p_clinic_id::text, 0)
  );
  -- A pending row whose TTL elapsed is terminal. Transition it before the
  -- partial unique index is consulted so a corrected/retried booking can own
  -- the intake immediately after expiry.
  update public.ai_appointment_requests r
  set status = 'expired', updated_at = clock_timestamp()
  where r.clinic_id = p_clinic_id and r.intake_id = v_intake.id
    and r.status = 'pending' and r.expires_at <= clock_timestamp();
  if not public.ai_requested_slot_is_available(
    p_clinic_id, p_doctor_id, p_scheduled_at, p_duration_minutes
  ) then raise exception 'AI_BOOKING_SLOT_UNAVAILABLE'; end if;
  select c.ai_pending_booking_ttl_minutes, c.ai_pending_slot_cap into v_ttl, v_cap
  from public.clinics c where c.id = p_clinic_id and c.is_active;
  if exists (
    select 1 from public.ai_appointment_requests r
    where r.clinic_id = p_clinic_id and r.intake_id = v_intake.id
      and r.status = 'pending' and r.expires_at > clock_timestamp()
  ) then raise exception 'AI_PENDING_PATIENT_CAP'; end if;
  if (
    (select count(*) from public.ai_appointment_requests r
      where r.clinic_id = p_clinic_id and r.doctor_id = p_doctor_id
        and r.scheduled_at = p_scheduled_at and r.status = 'pending'
        and r.expires_at > clock_timestamp())
    +
    (select count(*) from public.appointments a
      where a.clinic_id = p_clinic_id and a.doctor_id = p_doctor_id
        and a.scheduled_at = p_scheduled_at and a.status = 'pending'::public.appointment_status
        and a.deleted_at is null and a.expires_at > clock_timestamp()
        and (
          a.ai_patient_conversation_id is not null
          or a.ai_workflow_run_id is not null
          or a.ai_action_receipt_id is not null
        ))
  ) >= v_cap then raise exception 'AI_PENDING_SLOT_CAP'; end if;

  insert into public.ai_appointment_requests (
    clinic_id, intake_id, conversation_id, department_id, doctor_id,
    service_id, scheduled_at, duration_minutes, expires_at
  ) values (
    p_clinic_id, v_intake.id, p_conversation_id, v_intake.department_id,
    p_doctor_id, p_service_id, p_scheduled_at, p_duration_minutes,
    clock_timestamp() + make_interval(mins => v_ttl)
  ) returning * into v_request;
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_APPOINTMENT_REQUEST_STAGED', 'ai_appointment_requests',
    v_request.id, 'ai', 'ai_assistant', jsonb_build_object(
      'status', 'pending', 'intake_id', v_intake.id,
      'scheduled_at', v_request.scheduled_at, 'doctor_id', p_doctor_id
    )
  );
  return query select v_request.id, v_request.expires_at;
end;
$$;

revoke all on function public.create_provisional_ai_appointment_request(
  uuid, uuid, uuid, timestamptz, integer, uuid
) from public, anon, authenticated;
grant execute on function public.create_provisional_ai_appointment_request(
  uuid, uuid, uuid, timestamptz, integer, uuid
) to service_role;

-- A trigger-safe capability check for the reviewed approval transaction. A
-- caller cannot manufacture this context with SET/config alone: the guarded
-- statement must also be executing as the owner of the approval function, the
-- JWT actor must match the local actor marker and an active clinic reviewer,
-- and the marker must identify the pending intake for this exact conversation.
create or replace function public.ai_intake_approval_context_matches(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_intake_id uuid;
  v_actor_id uuid;
  v_approval_owner text;
begin
  if p_clinic_id is null or p_conversation_id is null then return false; end if;

  begin
    v_intake_id := nullif(
      current_setting('clinicflow.ai_intake_approval_id', true), ''
    )::uuid;
    v_actor_id := nullif(
      current_setting('clinicflow.ai_intake_approval_actor', true), ''
    )::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_intake_id is null or v_actor_id is null or v_actor_id is distinct from auth.uid() then
    return false;
  end if;

  select roles.rolname into v_approval_owner
  from pg_catalog.pg_proc procedures
  join pg_catalog.pg_roles roles on roles.oid = procedures.proowner
  where procedures.oid = pg_catalog.to_regprocedure(
    'public.approve_ai_patient_intake(uuid,uuid)'
  );
  if v_approval_owner is null or current_user::text <> v_approval_owner then
    return false;
  end if;

  return exists (
    select 1
    from public.ai_patient_intakes i
    join public.profiles reviewer
      on reviewer.id = v_actor_id and reviewer.clinic_id = i.clinic_id
    where i.id = v_intake_id and i.clinic_id = p_clinic_id
      and i.conversation_id = p_conversation_id
      and i.review_status = 'pending_review'
      and reviewer.role = any (
        array[
          'admin'::public.user_role,
          'manager'::public.user_role,
          'receptionist'::public.user_role
        ]
      )
      and reviewer.is_active and not reviewer.is_deleted
      and reviewer.deleted_at is null
  );
end;
$$;

revoke all on function public.ai_intake_approval_context_matches(uuid, uuid)
  from public;
-- The existing invoker-security trigger functions call this predicate for
-- every actor. It is read-only and always false outside the owner-bound context.
grant execute on function public.ai_intake_approval_context_matches(uuid, uuid)
  to anon, authenticated, service_role;

create or replace function public.approve_ai_patient_intake(
  p_intake_id uuid,
  p_actor_id uuid
)
returns table (patient_id uuid, appointment_id uuid, already_processed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.ai_patient_intakes%rowtype;
  v_conversation public.conversations%rowtype;
  v_existing public.patients%rowtype;
  v_phone_count integer;
  v_id_count integer;
  v_patient_id uuid;
  v_request public.ai_appointment_requests%rowtype;
  v_appointment_id uuid;
  v_next integer;
  v_file text;
  v_previous_approval_id text;
  v_previous_approval_actor text;
  v_has_active_patient_booking boolean := false;
begin
  if p_actor_id is distinct from auth.uid()
     or coalesce(public.auth_role()::text, '') not in ('admin', 'manager', 'receptionist')
  then raise exception 'INTAKE_REVIEW_FORBIDDEN' using errcode = '42501'; end if;
  select i.* into v_intake from public.ai_patient_intakes i
  where i.id = p_intake_id and i.clinic_id = public.auth_clinic_id() for update;
  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.review_status = 'approved' then
    select r.appointment_id into v_appointment_id
    from public.ai_appointment_requests r
    where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
      and r.status = 'linked' limit 1;
    return query select v_intake.approved_patient_id, v_appointment_id, true;
    return;
  end if;
  if v_intake.review_status <> 'pending_review' then
    raise exception 'INTAKE_ALREADY_REVIEWED';
  end if;
  if not exists (
    select 1 from public.departments d
    where d.id = v_intake.department_id and d.clinic_id = v_intake.clinic_id
      and d.is_active and d.deleted_at is null
  ) or not exists (
    select 1 from public.profiles p
    where p.id = v_intake.doctor_id and p.clinic_id = v_intake.clinic_id
      and p.department_id = v_intake.department_id
      and p.role = 'doctor'::public.user_role
      and p.is_active and not p.is_deleted and p.deleted_at is null
  ) then raise exception 'INTAKE_ASSIGNMENT_STALE'; end if;

  select c.* into v_conversation from public.conversations c
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;

  select count(*)::integer into v_phone_count from public.patients p
  where p.clinic_id = v_intake.clinic_id and p.phone = v_intake.phone
    and not p.is_deleted and p.deleted_at is null;
  select count(*)::integer into v_id_count from public.patients p
  where p.clinic_id = v_intake.clinic_id
    and public.fold_national_id(p.national_id) = v_intake.national_id_folded
    and not p.is_deleted and p.deleted_at is null;
  if v_phone_count > 1 or v_id_count > 1 then raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED'; end if;
  if v_phone_count = 1 then
    select p.* into v_existing from public.patients p
    where p.clinic_id = v_intake.clinic_id and p.phone = v_intake.phone
      and not p.is_deleted and p.deleted_at is null limit 1;
    if public.fold_national_id(v_existing.national_id)
         is distinct from v_intake.national_id_folded
       or v_existing.date_of_birth is distinct from v_intake.date_of_birth then
      raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED';
    end if;
    v_patient_id := v_existing.id;
  elsif v_id_count > 0 then
    raise exception 'INTAKE_DUPLICATE_REVIEW_REQUIRED';
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_intake.clinic_id::text || ':patient-file-number', 0)
    );
    select coalesce(max((substring(p.file_number from 4))::integer), 0) + 1 into v_next
    from public.patients p
    where p.clinic_id = v_intake.clinic_id and p.file_number ~ '^CF-\d+$';
    v_file := 'CF-' || lpad(v_next::text, 4, '0');
    insert into public.patients (
      clinic_id, full_name, national_id, date_of_birth, phone, email,
      department_id, assigned_doctor_id, file_number, created_by
    ) values (
      v_intake.clinic_id, v_intake.full_name, v_intake.national_id,
      v_intake.date_of_birth, v_intake.phone, v_intake.email,
      v_intake.department_id, v_intake.doctor_id, v_file, p_actor_id
    ) returning id into v_patient_id;
  end if;

  -- The caller remains the real authenticated staff member. These local,
  -- intake-bound markers authorize only the guarded writes performed by this
  -- reviewed transaction; the trigger helper also verifies the function owner,
  -- actor, clinic, conversation, and pending intake before accepting them.
  v_previous_approval_id := current_setting('clinicflow.ai_intake_approval_id', true);
  v_previous_approval_actor := current_setting('clinicflow.ai_intake_approval_actor', true);
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id', v_intake.id::text, true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor', p_actor_id::text, true
  );

  update public.conversations c
  set patient_id = v_patient_id, patient_link_status = 'manual'
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
  update public.conversations c
  set identity_verified_at = clock_timestamp(), identity_verification_failures = 0,
      identity_verification_locked_until = null
  where c.id = v_intake.conversation_id and c.clinic_id = v_intake.clinic_id;
  update public.inbound_messages m set patient_id = v_patient_id
  where m.conversation_id = v_intake.conversation_id
    and m.clinic_id = v_intake.clinic_id and m.patient_id is null;
  update public.inbound_message_attachments a set patient_id = v_patient_id
  where a.conversation_id = v_intake.conversation_id
    and a.clinic_id = v_intake.clinic_id and a.patient_id is null;

  select r.* into v_request from public.ai_appointment_requests r
  where r.intake_id = v_intake.id and r.clinic_id = v_intake.clinic_id
    and r.status = 'pending' for update;
  if found then
    if v_request.expires_at <= clock_timestamp()
       or not public.ai_requested_slot_is_available(
         v_request.clinic_id, v_request.doctor_id,
         v_request.scheduled_at, v_request.duration_minutes
       ) then
      update public.ai_appointment_requests
      set status = 'expired', updated_at = clock_timestamp()
      where id = v_request.id;
    else
      -- Preserve the one-active-AI-booking-per-patient invariant. Under the
      -- same advisory lock used by the appointment trigger, a pre-existing
      -- pending booking degrades only this request instead of rolling back the
      -- reviewed patient and conversation linkage.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'p5a-ai-booking:' || v_request.clinic_id::text, 0
        )
      );
      select exists (
        select 1 from public.appointments a
        where a.clinic_id = v_request.clinic_id
          and a.patient_id = v_patient_id
          and a.status = 'pending'::public.appointment_status
          and a.deleted_at is null and a.expires_at > clock_timestamp()
          and (
            a.ai_patient_conversation_id is not null
            or a.ai_workflow_run_id is not null
            or a.ai_action_receipt_id is not null
          )
      ) into v_has_active_patient_booking;

      if v_has_active_patient_booking then
        update public.ai_appointment_requests
        set status = 'dismissed', updated_at = clock_timestamp()
        where id = v_request.id;
      else
        begin
          insert into public.appointments (
            clinic_id, patient_id, doctor_id, department_id, service_id,
            scheduled_at, duration_minutes, status, created_by,
            ai_patient_conversation_id
          ) values (
            v_request.clinic_id, v_patient_id, v_request.doctor_id,
            v_request.department_id, v_request.service_id, v_request.scheduled_at,
            v_request.duration_minutes, 'pending'::public.appointment_status, null,
            v_request.conversation_id
          ) returning id into v_appointment_id;
          update public.ai_appointment_requests
          set status = 'linked', appointment_id = v_appointment_id,
              updated_at = clock_timestamp()
          where id = v_request.id;
        exception
          when unique_violation or exclusion_violation then
            -- A staff booking may have claimed the exact patient/doctor slot
            -- after staging. Keep the reviewed patient and dismiss only the
            -- stale provisional request.
            v_appointment_id := null;
            update public.ai_appointment_requests
            set status = 'dismissed', updated_at = clock_timestamp()
            where id = v_request.id;
        end;
      end if;
    end if;
  end if;

  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_id',
    coalesce(v_previous_approval_id, ''),
    true
  );
  perform pg_catalog.set_config(
    'clinicflow.ai_intake_approval_actor',
    coalesce(v_previous_approval_actor, ''),
    true
  );

  update public.ai_patient_intakes
  set review_status = 'approved', reviewed_at = clock_timestamp(),
      reviewed_by = p_actor_id, approved_patient_id = v_patient_id,
      updated_at = clock_timestamp()
  where id = v_intake.id;
  insert into public.audit_logs (
    clinic_id, actor_id, actor_type, source, action, table_name, record_id, new_data
  ) values (
    v_intake.clinic_id, p_actor_id, 'user', 'ai_assistant_review',
    'AI_PATIENT_INTAKE_APPROVED', 'ai_patient_intakes', v_intake.id,
    jsonb_build_object('patient_id', v_patient_id, 'appointment_id', v_appointment_id)
  );
  return query select v_patient_id, v_appointment_id, false;
end;
$$;

revoke all on function public.approve_ai_patient_intake(uuid, uuid)
  from public, anon;
grant execute on function public.approve_ai_patient_intake(uuid, uuid)
  to authenticated;

-- The AI path still requires an open conversation. Approval may link the
-- reviewed request after staff paused or closed the thread, but all identity,
-- provenance, expiry, patient-cap and slot-cap checks remain in force.
create or replace function public.enforce_ai_pending_booking_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_slot_cap integer;
  v_ttl_minutes integer;
  v_patient_pending integer;
  v_slot_pending integer;
  v_conversation_patient uuid;
  v_receipt public.ai_action_receipts%rowtype;
  v_is_ai boolean;
  v_is_intake_approval boolean := false;
  v_old_is_active boolean := false;
begin
  v_is_ai := new.ai_patient_conversation_id is not null
    or new.ai_workflow_run_id is not null
    or new.ai_action_receipt_id is not null;
  v_is_intake_approval := public.ai_intake_approval_context_matches(
    new.clinic_id, new.ai_patient_conversation_id
  );

  if not v_is_ai or new.status <> 'pending'::public.appointment_status
     or new.deleted_at is not null then
    return new;
  end if;

  if new.scheduled_at < clock_timestamp() + interval '24 hours' then
    raise exception 'AI_BOOKING_MINIMUM_NOTICE' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    v_old_is_active := (
      (
        old.ai_patient_conversation_id is not null
        or old.ai_workflow_run_id is not null
        or old.ai_action_receipt_id is not null
      )
      and old.status = 'pending'::public.appointment_status
      and old.deleted_at is null
    );
    if v_old_is_active
       and old.patient_id = new.patient_id
       and old.doctor_id = new.doctor_id
       and old.scheduled_at = new.scheduled_at
       and old.ai_patient_conversation_id is not distinct from new.ai_patient_conversation_id
       and old.ai_workflow_run_id is not distinct from new.ai_workflow_run_id
       and old.ai_action_receipt_id is not distinct from new.ai_action_receipt_id then
      return new;
    end if;
  end if;

  select clinic.ai_pending_slot_cap, clinic.ai_pending_booking_ttl_minutes
    into v_slot_cap, v_ttl_minutes
  from public.clinics as clinic
  where clinic.id = new.clinic_id and clinic.is_active
  for share;
  if not found then
    raise exception 'AI_BOOKING_CLINIC_UNAVAILABLE' using errcode = 'P0001';
  end if;

  if new.ai_patient_conversation_id is not null then
    select conversation.patient_id into v_conversation_patient
    from public.conversations as conversation
    where conversation.id = new.ai_patient_conversation_id
      and conversation.clinic_id = new.clinic_id
      and (v_is_intake_approval or conversation.status = 'open'::public.conversation_status);
    if not found or v_conversation_patient is null
       or v_conversation_patient <> new.patient_id
       or new.created_by is not null then
      raise exception 'AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH'
        using errcode = '42501';
    end if;
  end if;

  if new.ai_action_receipt_id is not null then
    select * into v_receipt
    from public.ai_action_receipts receipt
    where receipt.id = new.ai_action_receipt_id
      and receipt.clinic_id = new.clinic_id
      and receipt.actor_id = new.created_by
      and receipt.action_id = 'appointments.create_pending'
      and receipt.phase = 'execute';
    if not found then
      raise exception 'AI_BOOKING_ACTION_RECEIPT_MISMATCH' using errcode = '42501';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('p5a-ai-booking:' || new.clinic_id::text, 0)
  );
  new.expires_at := coalesce(
    new.expires_at,
    clock_timestamp() + make_interval(mins => v_ttl_minutes)
  );
  if new.expires_at <= clock_timestamp() then
    raise exception 'AI_BOOKING_INVALID_EXPIRY' using errcode = '22023';
  end if;

  select count(*)::integer into v_patient_pending
  from public.appointments as appointment
  where appointment.clinic_id = new.clinic_id
    and appointment.patient_id = new.patient_id
    and appointment.status = 'pending'::public.appointment_status
    and appointment.deleted_at is null
    and appointment.expires_at > clock_timestamp()
    and (
      appointment.ai_patient_conversation_id is not null
      or appointment.ai_workflow_run_id is not null
      or appointment.ai_action_receipt_id is not null
    )
    and (tg_op = 'INSERT' or appointment.id <> new.id);
  if v_patient_pending >= 1 then
    raise exception 'AI_PENDING_PATIENT_CAP' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_slot_pending
  from public.appointments as appointment
  where appointment.clinic_id = new.clinic_id
    and appointment.doctor_id = new.doctor_id
    and appointment.scheduled_at = new.scheduled_at
    and appointment.status = 'pending'::public.appointment_status
    and appointment.deleted_at is null
    and appointment.expires_at > clock_timestamp()
    and (
      appointment.ai_patient_conversation_id is not null
      or appointment.ai_workflow_run_id is not null
      or appointment.ai_action_receipt_id is not null
    )
    and (tg_op = 'INSERT' or appointment.id <> new.id);
  if v_slot_pending >= v_slot_cap then
    raise exception 'AI_PENDING_SLOT_CAP' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_ai_pending_booking_policy()
  from public, anon, authenticated, service_role;

create or replace function public.reject_ai_patient_intake(
  p_intake_id uuid,
  p_actor_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_intake public.ai_patient_intakes%rowtype;
begin
  if p_actor_id is distinct from auth.uid()
     or coalesce(public.auth_role()::text, '') not in ('admin', 'manager', 'receptionist')
  then raise exception 'INTAKE_REVIEW_FORBIDDEN' using errcode = '42501'; end if;
  select i.* into v_intake from public.ai_patient_intakes i
  where i.id = p_intake_id and i.clinic_id = public.auth_clinic_id() for update;
  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.review_status <> 'pending_review' then return false; end if;
  update public.ai_appointment_requests
  set status = 'dismissed', updated_at = clock_timestamp()
  where intake_id = v_intake.id and clinic_id = v_intake.clinic_id and status = 'pending';
  update public.ai_patient_intakes
  set review_status = 'rejected', reviewed_at = clock_timestamp(),
      reviewed_by = p_actor_id, review_reason = nullif(left(btrim(p_reason), 500), ''),
      updated_at = clock_timestamp()
  where id = v_intake.id;
  insert into public.audit_logs (
    clinic_id, actor_id, actor_type, source, action, table_name, record_id, new_data
  ) values (
    v_intake.clinic_id, p_actor_id, 'user', 'ai_assistant_review',
    'AI_PATIENT_INTAKE_REJECTED', 'ai_patient_intakes', v_intake.id,
    jsonb_build_object('reason_recorded', nullif(btrim(p_reason), '') is not null)
  );
  return true;
end;
$$;

revoke all on function public.reject_ai_patient_intake(uuid, uuid, text)
  from public, anon;
grant execute on function public.reject_ai_patient_intake(uuid, uuid, text)
  to authenticated;

-- Defensive: the reviewed intake flow supersedes the older auto-registration
-- RPC. Already dropped on the remote, kept here so any database that somehow
-- retained it converges.
drop function if exists public.register_patient_from_conversation(
  uuid, uuid, text, text, date, text
);
