-- P5A: booking-core hardening, conversation-bound patient identity, and
-- service-only patient tool RPCs. No webhook/agent-loop wiring or auto replies.

-- ---------------------------------------------------------------------------
-- Patient identity and clinic-configurable pending-booking policy
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column identity_verified_at timestamptz,
  add column identity_verification_failures smallint not null default 0
    check (identity_verification_failures between 0 and 5),
  add column identity_verification_locked_until timestamptz;

alter table public.clinics
  add column ai_pending_booking_ttl_minutes integer not null default 1440
    check (ai_pending_booking_ttl_minutes between 15 and 10080),
  add column ai_pending_slot_cap smallint not null default 2
    check (ai_pending_slot_cap between 1 and 10);

create or replace function public.clear_conversation_identity_on_patient_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.patient_id is distinct from new.patient_id then
    new.identity_verified_at := null;
    new.identity_verification_failures := 0;
    new.identity_verification_locked_until := null;
  end if;
  return new;
end;
$$;

create trigger trg_conversations_clear_identity_on_patient_change
  before update of patient_id on public.conversations
  for each row execute function public.clear_conversation_identity_on_patient_change();

revoke all on function public.clear_conversation_identity_on_patient_change()
  from public, anon, authenticated, service_role;

-- Identity proof is owned by the service-only DOB RPC. Ordinary authenticated
-- conversation updates may relink a patient, but the earlier trigger must reset
-- the proof in that case; clients cannot manufacture or preserve verification.
create or replace function public.protect_patient_ai_identity_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.identity_verified_at is not null
       or new.identity_verification_failures <> 0
       or new.identity_verification_locked_until is not null then
      raise exception 'PATIENT_AI_IDENTITY_STATE_SERVER_ONLY'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.identity_verified_at is distinct from new.identity_verified_at
     or old.identity_verification_failures is distinct from new.identity_verification_failures
     or old.identity_verification_locked_until is distinct from new.identity_verification_locked_until then
    if old.patient_id is distinct from new.patient_id
       and new.identity_verified_at is null
       and new.identity_verification_failures = 0
       and new.identity_verification_locked_until is null then
      return new;
    end if;
    raise exception 'PATIENT_AI_IDENTITY_STATE_SERVER_ONLY'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_conversations_guard_ai_identity
  before insert or update of
    patient_id,
    identity_verified_at,
    identity_verification_failures,
    identity_verification_locked_until
  on public.conversations
  for each row execute function public.protect_patient_ai_identity_state();

revoke all on function public.protect_patient_ai_identity_state()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- AI-created pending appointment provenance, caps, and TTL
-- ---------------------------------------------------------------------------

alter table public.appointments
  alter column created_by drop not null,
  add column ai_patient_conversation_id uuid,
  add column expires_at timestamptz,
  add constraint appointments_ai_patient_conversation_clinic_fkey
    foreign key (ai_patient_conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete restrict,
  add constraint appointments_ai_origin_exclusive_check check (
    not (ai_patient_conversation_id is not null and ai_workflow_run_id is not null)
  ),
  add constraint appointments_creator_attribution_check check (
    created_by is not null
    or ai_patient_conversation_id is not null
  ),
  add constraint appointments_ai_pending_expiry_check check (
    status <> 'pending'::public.appointment_status
    or (
      ai_patient_conversation_id is null
      and ai_workflow_run_id is null
    )
    or expires_at is not null
  ) not valid;

create index appointments_ai_pending_patient_cap_idx
  on public.appointments (clinic_id, patient_id, expires_at)
  where status = 'pending'::public.appointment_status
    and deleted_at is null
    and (ai_patient_conversation_id is not null or ai_workflow_run_id is not null);

create index appointments_ai_pending_slot_cap_idx
  on public.appointments (clinic_id, doctor_id, scheduled_at, expires_at)
  where status = 'pending'::public.appointment_status
    and deleted_at is null
    and (ai_patient_conversation_id is not null or ai_workflow_run_id is not null);

-- Existing P4.11 AI workflow bookings become TTL-bound immediately. Historical
-- terminal rows retain null expiry because they cannot contribute to a cap.
update public.appointments as appointment
set expires_at = clock_timestamp()
  + make_interval(mins => clinic.ai_pending_booking_ttl_minutes)
from public.clinics as clinic
where appointment.clinic_id = clinic.id
  and appointment.ai_workflow_run_id is not null
  and appointment.status = 'pending'::public.appointment_status
  and appointment.deleted_at is null
  and appointment.expires_at is null;

alter table public.appointments
  validate constraint appointments_ai_pending_expiry_check;

-- Staff retain their normal appointment lifecycle writes, including confirming
-- or cancelling a pending request, but AI provenance and TTL are server-owned.
create or replace function public.protect_ai_booking_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ai_patient_conversation_id is not null
       or new.ai_workflow_run_id is not null
       or new.expires_at is not null then
      raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
    end if;
  elsif old.ai_patient_conversation_id is distinct from new.ai_patient_conversation_id
     or old.ai_workflow_run_id is distinct from new.ai_workflow_run_id
     or old.expires_at is distinct from new.expires_at then
    raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_appointments_guard_ai_metadata
  before insert or update of
    ai_patient_conversation_id,
    ai_workflow_run_id,
    expires_at
  on public.appointments
  for each row execute function public.protect_ai_booking_metadata();

revoke all on function public.protect_ai_booking_metadata()
  from public, anon, authenticated, service_role;

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
  v_is_ai boolean;
  v_old_is_active boolean := false;
begin
  v_is_ai := new.ai_patient_conversation_id is not null
    or new.ai_workflow_run_id is not null;

  if not v_is_ai or new.status <> 'pending'::public.appointment_status
     or new.deleted_at is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_is_active := (
      (old.ai_patient_conversation_id is not null or old.ai_workflow_run_id is not null)
      and old.status = 'pending'::public.appointment_status
      and old.deleted_at is null
    );
    if v_old_is_active
       and old.patient_id = new.patient_id
       and old.doctor_id = new.doctor_id
       and old.scheduled_at = new.scheduled_at
       and old.ai_patient_conversation_id is not distinct from new.ai_patient_conversation_id
       and old.ai_workflow_run_id is not distinct from new.ai_workflow_run_id then
      return new;
    end if;
  end if;

  select clinic.ai_pending_slot_cap, clinic.ai_pending_booking_ttl_minutes
    into v_slot_cap, v_ttl_minutes
  from public.clinics as clinic
  where clinic.id = new.clinic_id
    and clinic.is_active
  for share;
  if not found then
    raise exception 'AI_BOOKING_CLINIC_UNAVAILABLE' using errcode = 'P0001';
  end if;

  if new.ai_patient_conversation_id is not null then
    select conversation.patient_id
      into v_conversation_patient
    from public.conversations as conversation
    where conversation.id = new.ai_patient_conversation_id
      and conversation.clinic_id = new.clinic_id
      and conversation.status = 'open'::public.conversation_status;
    if not found or v_conversation_patient is null
       or v_conversation_patient <> new.patient_id
       or new.created_by is not null then
      raise exception 'AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH'
        using errcode = '42501';
    end if;
  end if;

  -- One clinic-local advisory lock makes both count checks race-safe, including
  -- mixed patient-agent and staff-workflow AI bookings.
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
    )
    and (tg_op = 'INSERT' or appointment.id <> new.id);
  if v_slot_pending >= v_slot_cap then
    raise exception 'AI_PENDING_SLOT_CAP' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger trg_appointments_ai_pending_policy
  before insert or update of
    patient_id,
    doctor_id,
    scheduled_at,
    status,
    deleted_at,
    expires_at,
    ai_patient_conversation_id,
    ai_workflow_run_id
  on public.appointments
  for each row execute function public.enforce_ai_pending_booking_policy();

revoke all on function public.enforce_ai_pending_booking_policy()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared service-only patient authorization boundary
-- ---------------------------------------------------------------------------

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
  clinic_timezone text
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
    conversation.patient_id,
    conversation.patient_id is not null,
    conversation.identity_verified_at,
    conversation.identity_verification_locked_until,
    clinic.name,
    clinic.locale,
    clinic.timezone
  from public.conversations as conversation
  join public.clinics as clinic
    on clinic.id = conversation.clinic_id
   and clinic.is_active
  left join public.patients as patient
    on patient.id = conversation.patient_id
   and patient.clinic_id = conversation.clinic_id
   and not patient.is_deleted
   and patient.deleted_at is null
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
    and (
      conversation.patient_id is null
      or patient.id is not null
    );
end;
$$;

revoke all on function public.resolve_patient_ai_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_patient_ai_context(uuid, uuid)
  to service_role;

create or replace function public.verify_patient_conversation_dob(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_date_of_birth date
)
returns table (
  verified boolean,
  identity_verified_at timestamptz,
  locked_until timestamptz,
  attempts_remaining integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_dob date;
  v_now timestamptz := clock_timestamp();
  v_failures integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select * into v_conversation
  from public.conversations as conversation
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
  for update;
  if not found or v_conversation.patient_id is null then
    raise exception 'PATIENT_IDENTITY_UNLINKED' using errcode = '42501';
  end if;

  if v_conversation.identity_verification_locked_until is not null
     and v_conversation.identity_verification_locked_until > v_now then
    return query select
      false,
      v_conversation.identity_verified_at,
      v_conversation.identity_verification_locked_until,
      0;
    return;
  end if;

  select patient.date_of_birth into v_dob
  from public.patients as patient
  where patient.id = v_conversation.patient_id
    and patient.clinic_id = p_clinic_id
    and not patient.is_deleted
    and patient.deleted_at is null;
  if not found then
    raise exception 'PATIENT_IDENTITY_UNLINKED' using errcode = '42501';
  end if;

  if v_dob = p_date_of_birth then
    update public.conversations
    set identity_verified_at = v_now,
        identity_verification_failures = 0,
        identity_verification_locked_until = null
    where id = p_conversation_id and clinic_id = p_clinic_id;

    insert into public.audit_logs (
      clinic_id, action, table_name, record_id, new_data
    ) values (
      p_clinic_id,
      'AI_PATIENT_IDENTITY_VERIFIED',
      'conversations',
      p_conversation_id,
      jsonb_build_object('method', 'dob', 'verified', true)
    );

    return query select true, v_now, null::timestamptz, 5;
    return;
  end if;

  v_failures := least(5, coalesce(v_conversation.identity_verification_failures, 0) + 1);
  update public.conversations
  set identity_verified_at = null,
      identity_verification_failures = v_failures,
      identity_verification_locked_until = case
        when v_failures >= 5 then v_now + interval '15 minutes'
        else null
      end
  where id = p_conversation_id and clinic_id = p_clinic_id;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, new_data
  ) values (
    p_clinic_id,
    'AI_PATIENT_IDENTITY_FAILED',
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'method', 'dob',
      'verified', false,
      'locked', v_failures >= 5
    )
  );

  return query select
    false,
    null::timestamptz,
    case when v_failures >= 5 then v_now + interval '15 minutes' else null end,
    greatest(0, 5 - v_failures);
end;
$$;

revoke all on function public.verify_patient_conversation_dob(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.verify_patient_conversation_dob(uuid, uuid, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- Conversation-bound patient tool RPCs
-- ---------------------------------------------------------------------------

create or replace function public.create_patient_preliminary_booking(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_doctor_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_service_id uuid default null
)
returns table (appointment_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_doctor public.profiles%rowtype;
  v_appointment public.appointments%rowtype;
  v_end timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.scheduling'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;
  if p_scheduled_at <= clock_timestamp()
     or p_duration_minutes < 15
     or p_duration_minutes > 240
     or mod(p_duration_minutes, 15) <> 0 then
    raise exception 'AI_BOOKING_INVALID_SLOT' using errcode = '22023';
  end if;

  select * into v_conversation
  from public.conversations as conversation
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
  for update;
  if not found or v_conversation.patient_id is null then
    raise exception 'PATIENT_IDENTITY_UNLINKED' using errcode = '42501';
  end if;

  select * into v_doctor
  from public.profiles as profile
  where profile.id = p_doctor_id
    and profile.clinic_id = p_clinic_id
    and profile.role = 'doctor'::public.user_role
    and profile.is_active
    and not profile.is_deleted
    and profile.deleted_at is null;
  if not found then
    raise exception 'AI_BOOKING_DOCTOR_UNAVAILABLE' using errcode = 'P0001';
  end if;

  if p_service_id is not null and not exists (
    select 1 from public.services as service
    where service.id = p_service_id
      and service.clinic_id = p_clinic_id
      and service.is_active
      and service.deleted_at is null
      and (
        v_doctor.department_id is null
        or service.department_id = v_doctor.department_id
      )
  ) then
    raise exception 'AI_BOOKING_SERVICE_UNAVAILABLE' using errcode = 'P0001';
  end if;

  v_end := p_scheduled_at + make_interval(mins => p_duration_minutes);
  if exists (
    select 1
    from public.appointments as appointment
    where appointment.clinic_id = p_clinic_id
      and appointment.doctor_id = p_doctor_id
      and appointment.status = any (
        array[
          'confirmed'::public.appointment_status,
          'arrived'::public.appointment_status,
          'in_session'::public.appointment_status
        ]
      )
      and appointment.deleted_at is null
      and p_scheduled_at < (
        appointment.scheduled_at
        + make_interval(mins => appointment.duration_minutes + 15)
      )
      and v_end > (appointment.scheduled_at - interval '15 minutes')
  ) then
    raise exception 'AI_BOOKING_SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  insert into public.appointments (
    clinic_id,
    patient_id,
    doctor_id,
    department_id,
    service_id,
    scheduled_at,
    duration_minutes,
    status,
    created_by,
    ai_patient_conversation_id
  ) values (
    p_clinic_id,
    v_conversation.patient_id,
    p_doctor_id,
    v_doctor.department_id,
    p_service_id,
    p_scheduled_at,
    p_duration_minutes,
    'pending'::public.appointment_status,
    null,
    p_conversation_id
  )
  returning * into v_appointment;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, new_data
  ) values (
    p_clinic_id,
    'AI_TOOL_CREATE_PRELIMINARY_BOOKING',
    'appointments',
    v_appointment.id,
    jsonb_build_object(
      'status', 'pending',
      'expires_at', v_appointment.expires_at,
      'source', 'patient_conversation'
    )
  );

  return query select v_appointment.id, v_appointment.expires_at;
end;
$$;

revoke all on function public.create_patient_preliminary_booking(
  uuid, uuid, uuid, timestamptz, integer, uuid
) from public, anon, authenticated;
grant execute on function public.create_patient_preliminary_booking(
  uuid, uuid, uuid, timestamptz, integer, uuid
) to service_role;

create or replace function public.list_patient_ai_appointments(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (
  appointment_id uuid,
  scheduled_at timestamptz,
  duration_minutes integer,
  status public.appointment_status,
  doctor_name text,
  department_name text,
  service_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_patient_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;
  select conversation.patient_id into v_patient_id
  from public.conversations as conversation
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
    and conversation.identity_verified_at is not null;
  if not found or v_patient_id is null then
    raise exception 'PATIENT_IDENTITY_VERIFICATION_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    appointment.id,
    appointment.scheduled_at,
    appointment.duration_minutes,
    appointment.status,
    doctor.full_name,
    department.name,
    service.name
  from public.appointments as appointment
  join public.profiles as doctor
    on doctor.id = appointment.doctor_id
   and doctor.clinic_id = appointment.clinic_id
  left join public.departments as department
    on department.id = appointment.department_id
   and department.clinic_id = appointment.clinic_id
  left join public.services as service
    on service.id = appointment.service_id
   and service.clinic_id = appointment.clinic_id
  where appointment.clinic_id = p_clinic_id
    and appointment.patient_id = v_patient_id
    and appointment.deleted_at is null
    and appointment.status <> 'replaced'::public.appointment_status
    and appointment.scheduled_at >= clock_timestamp() - interval '30 days'
  order by appointment.scheduled_at
  limit 50;
end;
$$;

revoke all on function public.list_patient_ai_appointments(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.list_patient_ai_appointments(uuid, uuid)
  to service_role;

create or replace function public.cancel_patient_ai_appointment(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_appointment_id uuid
)
returns table (cancelled boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient_id uuid;
  v_appointment public.appointments%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;
  select conversation.patient_id into v_patient_id
  from public.conversations as conversation
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
    and conversation.identity_verified_at is not null;
  if not found or v_patient_id is null then
    raise exception 'PATIENT_IDENTITY_VERIFICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_appointment
  from public.appointments as appointment
  where appointment.id = p_appointment_id
    and appointment.clinic_id = p_clinic_id
    and appointment.patient_id = v_patient_id
    and appointment.deleted_at is null
  for update;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if v_appointment.status <> 'pending'::public.appointment_status then
    return query select false, 'staff_required'::text;
    return;
  end if;

  update public.appointments
  set status = 'cancelled'::public.appointment_status,
      cancellation_reason = 'Cancelled by patient through AI assistant',
      cancelled_at = v_now,
      cancelled_by = null,
      updated_by = null
  where id = p_appointment_id and clinic_id = p_clinic_id;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, old_data, new_data
  ) values (
    p_clinic_id,
    'AI_TOOL_CANCEL_MY_APPOINTMENT',
    'appointments',
    p_appointment_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'cancelled', 'source', 'patient_conversation')
  );

  return query select true, 'cancelled'::text;
end;
$$;

revoke all on function public.cancel_patient_ai_appointment(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_patient_ai_appointment(uuid, uuid, uuid)
  to service_role;

create or replace function public.search_patient_clinic_faq(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_question text,
  p_language text
)
returns table (faq_id uuid, question text, answer text, language text, score real)
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
  if coalesce(length(btrim(p_question)), 0) = 0 or length(p_question) > 500
     or p_language not in ('ar', 'en') then
    raise exception 'PATIENT_FAQ_INVALID_QUERY' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.conversations as conversation
    where conversation.id = p_conversation_id
      and conversation.clinic_id = p_clinic_id
      and conversation.status = 'open'::public.conversation_status
  ) then
    raise exception 'PATIENT_AI_CONVERSATION_NOT_FOUND' using errcode = '42501';
  end if;

  return query
  select
    faq.id,
    faq.question,
    faq.answer,
    faq.language,
    greatest(
      similarity(
        public.normalize_search_text(faq.question),
        public.normalize_search_text(p_question)
      ),
      case
        when public.normalize_search_text(faq.question)
          like '%' || public.normalize_search_text(p_question) || '%'
          then 0.8
        else 0
      end
    )::real
  from public.clinic_faq as faq
  where faq.clinic_id = p_clinic_id
    and faq.is_active
    and faq.language in (p_language, case when p_language = 'ar' then 'en' else 'ar' end)
  order by
    (faq.language = p_language) desc,
    greatest(
      similarity(
        public.normalize_search_text(faq.question),
        public.normalize_search_text(p_question)
      ),
      case
        when public.normalize_search_text(faq.question)
          like '%' || public.normalize_search_text(p_question) || '%'
          then 0.8
        else 0
      end
    ) desc,
    faq.sort_order,
    faq.id
  limit 3;
end;
$$;

revoke all on function public.search_patient_clinic_faq(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.search_patient_clinic_faq(uuid, uuid, text, text)
  to service_role;

-- Daily P3D cron job: terminally cancel due AI-created pending rows. The update
-- passes through the normal appointment transition trigger and atomically
-- records one content-minimized audit row per expiry.
create or replace function public.expire_ai_pending_bookings(
  p_now timestamptz default clock_timestamp(),
  p_limit integer default 500
)
returns table (expired_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 2000 then
    raise exception 'AI_BOOKING_INVALID_EXPIRY_LIMIT' using errcode = '22023';
  end if;

  for v_row in
    select appointment.id, appointment.clinic_id
    from public.appointments as appointment
    where appointment.status = 'pending'::public.appointment_status
      and appointment.deleted_at is null
      and appointment.expires_at is not null
      and appointment.expires_at <= p_now
      and (
        appointment.ai_patient_conversation_id is not null
        or appointment.ai_workflow_run_id is not null
      )
    order by appointment.expires_at, appointment.id
    for update skip locked
    limit p_limit
  loop
    update public.appointments
    set status = 'cancelled'::public.appointment_status,
        cancellation_reason = 'AI pending booking expired',
        cancelled_at = p_now,
        cancelled_by = null,
        updated_by = null
    where id = v_row.id and clinic_id = v_row.clinic_id;

    insert into public.audit_logs (
      clinic_id, action, table_name, record_id, old_data, new_data
    ) values (
      v_row.clinic_id,
      'AI_PENDING_BOOKING_EXPIRED',
      'appointments',
      v_row.id,
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'cancelled', 'reason', 'ttl_expired')
    );
    v_count := v_count + 1;
  end loop;

  return query select v_count;
end;
$$;

revoke all on function public.expire_ai_pending_bookings(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.expire_ai_pending_bookings(timestamptz, integer)
  to service_role;

-- P4.5C originally tied the shared budget-pool resolver to the staff surface.
-- P5A keeps surface-specific entitlement checks in prepareAiExecution and the
-- patient RPCs, while the shared pool requires only the Pro + AI umbrella.
create or replace function public.resolve_ai_commercial_limits(
  p_clinic_id uuid,
  p_period_start date
)
returns table (
  included_limit_micros bigint,
  addon_limit_micros bigint,
  overage_limit_micros bigint,
  total_limit_micros bigint,
  request_limit integer,
  concurrency_limit integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan_limits jsonb;
  v_counter_limit integer := 0;
  v_terms public.ai_commercial_terms%rowtype;
begin
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_BUDGET_INVALID_PERIOD';
  end if;
  if not coalesce(public.effective_ai_feature(
    p_clinic_id,
    'ai_assistant'
  ), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select plan.limits into v_plan_limits
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  where subscription.clinic_id = p_clinic_id
    and plan.slug = 'pro_ai'
    and plan.is_active;
  if not found then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select coalesce(limit_snapshot, 0) into v_counter_limit
  from public.usage_counters
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = 'ai_messages'::public.usage_metric;

  select * into v_terms
  from public.ai_commercial_terms
  where clinic_id = p_clinic_id;

  included_limit_micros := coalesce(
    v_terms.included_budget_override_micros,
    (v_plan_limits ->> 'ai_credits_month')::bigint,
    0
  );
  addon_limit_micros := coalesce(v_terms.addon_budget_micros, 0);
  overage_limit_micros := case
    when v_terms.overage_mode = 'contracted'
      then coalesce(v_terms.overage_budget_micros, 0)
    else 0
  end;
  total_limit_micros :=
    included_limit_micros + addon_limit_micros + overage_limit_micros;
  request_limit := greatest(
    coalesce((v_plan_limits ->> 'ai_requests_month')::integer, 0),
    coalesce((v_plan_limits ->> 'ai_messages_month')::integer, 0),
    v_counter_limit
  );
  concurrency_limit := coalesce(
    (v_plan_limits ->> 'ai_concurrent_requests')::integer,
    0
  );

  if included_limit_micros <= 0 or total_limit_micros <= 0
     or request_limit <= 0 or concurrency_limit <= 0 then
    raise exception 'AI_BUDGET_INVALID_COMMERCIAL_LIMITS';
  end if;
  return next;
end;
$$;

revoke all on function public.resolve_ai_commercial_limits(uuid, date)
  from public, anon, authenticated, service_role;

-- Patient budget reservations use the conversation id as their content-free
-- actor key. It is not a staff profile id, so hybrid-fallback audit rows must
-- retain the reservation binding while leaving audit_logs.actor_id null.
create or replace function public.log_ai_provider_fallback(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_provider text,
  p_error_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_budget_reservations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_PROVIDER_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_provider is distinct from 'anthropic'
     or p_error_class is null
     or p_error_class not in (
       'authentication', 'permission', 'quota', 'rate_limit', 'timeout',
       'provider_unavailable', 'request_failed'
     ) then
    raise exception 'AI_PROVIDER_INVALID_FALLBACK_AUDIT';
  end if;

  select reservation.* into v_reservation
  from public.ai_budget_reservations as reservation
  join public.ai_clinic_provider_policies as policy
    on policy.clinic_id = reservation.clinic_id
  where reservation.request_id = p_request_id
    and reservation.clinic_id = p_clinic_id
    and reservation.actor_id = p_actor_id
    and reservation.credential_mode = 'hybrid'
    and reservation.status = 'reserved'
    and policy.credential_mode = 'hybrid'
    and policy.provider = p_provider
    and policy.hybrid_disclosure_version = 'p45b-hybrid-disclosure-v1'
    and policy.hybrid_accepted_at is not null;
  if not found then
    raise exception 'AI_PROVIDER_HYBRID_POLICY_REQUIRED' using errcode = '42501';
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    case
      when v_reservation.surface = 'patient_messaging' then null
      else p_actor_id
    end,
    p_clinic_id,
    'AI_PROVIDER_HYBRID_FALLBACK',
    'ai_budget_reservations',
    v_reservation.id,
    jsonb_build_object(
      'request_id', p_request_id,
      'credential_mode', 'hybrid',
      'provider', p_provider,
      'from', 'tenant_credential',
      'to', 'managed',
      'error_class', p_error_class,
      'surface', v_reservation.surface
    )
  );
  return true;
end;
$$;

revoke all on function public.log_ai_provider_fallback(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.log_ai_provider_fallback(
  uuid, uuid, uuid, text, text
) to service_role;

-- P5A enables patient suggestion/tool execution and pending-only scheduling on
-- Pro + AI. Automatic patient replies remain disabled for P5B.
update public.plans
set features = features || jsonb_build_object(
      'ai.patient_suggest', true,
      'ai.patient_auto', false,
      'ai.scheduling', true
    ),
    updated_at = clock_timestamp()
where slug = 'pro_ai';
