-- P9C — booking on behalf of somebody else ("ممكن احجز لصاحبي").
--
-- Until now the intake boundary had exactly one subject: the person holding the
-- phone. `stage_patient_intake_from_conversation` returns `already_linked` the
-- moment the conversation has a patient, and
-- `create_provisional_ai_appointment_request` refuses outright unless
-- `patient_id is null`. So a linked patient asking to book for a friend had no
-- representable outcome at all: the assistant collected the friend's name, id,
-- date of birth and email, and there was nowhere to put any of it. The only
-- thing the system could still have done was create the appointment under the
-- *sender's* record — the wrong patient, silently, which is the failure this
-- migration exists to make impossible rather than merely unlikely.
--
-- The subject of an intake therefore becomes explicit. `is_third_party` says the
-- staged person is not the sender, and `requested_by_patient_id` records who
-- asked, so staff reviewing the queue can see the relationship rather than infer
-- it from a phone number that belongs to someone else.
--
-- Two rules are kept exactly as they were, because they are what make the
-- boundary safe:
--
--   * **Staged, never created.** A third-party intake lands in
--     `ai_patient_intakes` as `pending_review` like every other one. The
--     assistant cannot create a patient record, for the sender or for anyone
--     else, and the appointment it books is a `pending` request against that
--     intake which a human must approve.
--   * **Identity proof is about the sender, and only the sender.** The
--     phone-match / date-of-birth / national-id comparison ladder exists to
--     decide whether the person writing in *is* an existing patient. A friend is
--     not claiming to be anyone, so that ladder does not apply to them and is
--     not run — running it would compare a stranger's details against the
--     sender's record and lock the thread out on a mismatch that means nothing.
--     What is still run is the national-id duplicate check: a friend who already
--     has a file at this clinic goes to staff as `duplicate_review` rather than
--     silently becoming a second record.

alter table public.ai_patient_intakes
  add column if not exists is_third_party boolean not null default false,
  add column if not exists requested_by_patient_id uuid
    references public.patients(id) on delete set null;

comment on column public.ai_patient_intakes.is_third_party is
  'The staged person is not the WhatsApp sender. The phone is a contact number, not proof of identity.';
comment on column public.ai_patient_intakes.requested_by_patient_id is
  'The linked patient who asked for this booking, when someone booked on another person''s behalf.';

create index if not exists ai_patient_intakes_requested_by_idx
  on public.ai_patient_intakes (clinic_id, requested_by_patient_id)
  where requested_by_patient_id is not null;

-- The old signature has to go rather than be overloaded: two callable functions
-- differing only by defaulted trailing parameters is an ambiguity waiting for
-- the first caller that omits them.
drop function if exists public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid
);

create function public.stage_patient_intake_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text,
  p_department_id uuid,
  p_doctor_id uuid,
  p_for_third_party boolean default false,
  p_phone text default null
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
  v_requested_by uuid;
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

  -- Booking for the sender: unchanged. A linked conversation has nothing to
  -- register, and the identity ladder below is the whole point of the call.
  if v_conversation.patient_id is not null and not coalesce(p_for_third_party, false) then
    status := 'already_linked'; intake_id := null; return next; return;
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp()
     and not coalesce(p_for_third_party, false) then
    status := 'identity_locked'; intake_id := null; attempts_remaining := 0; return next; return;
  end if;

  -- The friend's own number when the sender gave one, otherwise the thread's,
  -- which is at least a number the clinic can reach them on. For a third party
  -- this is contact information and nothing more: it proves nothing, and none of
  -- the identity comparisons below are run against it.
  v_phone := case
    when coalesce(p_for_third_party, false)
      then coalesce(
        nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
      )
    else nullif(btrim(coalesce(v_conversation.participant_address, '')), '')
  end;
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

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_id_match_id, v_id_count
  from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id);

  if not coalesce(p_for_third_party, false) then
    select count(*)::integer into v_phone_count
    from public.patients p
    where p.clinic_id = p_clinic_id and p.phone = v_phone
      and not p.is_deleted and p.deleted_at is null;
    if v_phone_count = 1 then
      select p.* into v_phone_match from public.patients p
      where p.clinic_id = p_clinic_id and p.phone = v_phone
        and not p.is_deleted and p.deleted_at is null limit 1;
    end if;

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
  end if;

  -- A national id the clinic already knows goes to a human, for the sender and
  -- for a friend alike. Two files for one person is the one duplicate this
  -- boundary can actually detect, and it is never the assistant's call to make.
  if v_id_count > 0 then
    status := 'duplicate_review'; intake_id := null; return next; return;
  end if;

  v_requested_by := case
    when coalesce(p_for_third_party, false) then v_conversation.patient_id
    else null
  end;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, requested_by_patient_id
  ) values (
    p_clinic_id, p_conversation_id, btrim(p_full_name), p_date_of_birth, v_phone,
    lower(btrim(p_email)), btrim(p_national_id),
    p_department_id, p_doctor_id, coalesce(p_for_third_party, false), v_requested_by
  )
  on conflict (clinic_id, conversation_id) do update
    set full_name = excluded.full_name,
        date_of_birth = excluded.date_of_birth,
        phone = excluded.phone,
        email = excluded.email,
        national_id = excluded.national_id,
        department_id = excluded.department_id,
        doctor_id = excluded.doctor_id,
        is_third_party = excluded.is_third_party,
        requested_by_patient_id = excluded.requested_by_patient_id,
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
      'doctor_id', p_doctor_id, 'conversation_id', p_conversation_id,
      'is_third_party', coalesce(p_for_third_party, false)
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
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text
) to service_role;

-- The provisional booking path now serves two cases that are the same shape: an
-- unlinked sender booking for themselves, and a linked sender booking for a
-- third party. In both, the appointment belongs to a `pending_review` intake and
-- not to any patient record — which is precisely why a linked conversation may
-- use it *only* when the intake is flagged third-party. A linked sender booking
-- for themselves still has no business here and is still refused.
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
  if not found then
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
  -- A linked conversation reaches this path only on behalf of somebody else.
  if v_conversation.patient_id is not null and not coalesce(v_intake.is_third_party, false) then
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
      'scheduled_at', v_request.scheduled_at, 'doctor_id', p_doctor_id,
      'is_third_party', coalesce(v_intake.is_third_party, false)
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
