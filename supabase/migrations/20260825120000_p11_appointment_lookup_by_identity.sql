-- P11 — "عايز أعرف ميعادي": appointment lookup by full name and national id.
--
-- Additive only. One new function, one new column comment, nothing dropped,
-- nothing narrowed, and no existing function's signature touched — so a build
-- that lands before this migration keeps working unchanged, and a build that
-- lands after it gains one capability.
--
-- ## Why this is not `list_patient_ai_appointments`
--
-- That function answers "what are *my* appointments?" for a thread that has
-- passed the date-of-birth challenge, and it reads `conversations.patient_id`
-- to decide whose. Neither half fits the case this migration is for:
--
--   * The patient asking "ميعادي امتى؟" is very often writing from a number the
--     clinic has never linked, so there is no `patient_id` to read — and the
--     assistant's only move was to start a *registration*, which is the defect.
--
--   * Reading `conversations.patient_id` at all is the wrong shape here. When
--     the sender supplies a name and a national id, the answer must come from
--     those two values and from nothing else. A function that could fall back
--     to the thread's own patient would return sender A's appointment in reply
--     to patient B's identity, which is the cross-patient leak this phase is
--     required to make impossible. There is deliberately no branch below that
--     reads `patient_id` from the conversation.
--
-- ## What it is, precisely
--
--   * **Exact identity, never fuzzy.** The same `fold_patient_name` /
--     `fold_national_id` pair `identify_patient_for_booking` uses. Both must
--     select the same single live patient of this clinic. No resolver, no
--     similarity, no "did you mean".
--
--   * **No existence oracle.** Every failure — unknown name, unknown id, an id
--     that belongs to somebody else, a name that exists with a different id,
--     more than one match — returns the identical `no_match`. The caller cannot
--     tell them apart because this function does not tell them apart.
--
--   * **Rate-limited on the same counter** as the date-of-birth check and the
--     booking identification, so guessing national ids here is no cheaper than
--     guessing them there, and five failures lock the thread for 30 minutes.
--
--   * **It links nothing and verifies nothing.** Unlike
--     `identify_patient_for_booking`, it does not set `patient_id`,
--     `patient_link_status`, `booking_identity_confirmed_at` or
--     `identity_verified_at`. A successful lookup changes no row on
--     `conversations` except the attempt counter it resets. That is the whole
--     security argument for allowing it without a date-of-birth challenge: it
--     grants no state, so it cannot be a stepping stone to anything.
--
--   * **Booking facts only.** When, with whom, in which department, for which
--     service, and the status of the request. No diagnosis, no note, no
--     document, no balance, no other patient. Clinical disclosure still costs a
--     date-of-birth verification, exactly as before.

create or replace function public.lookup_patient_appointments_by_identity(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text
)
returns table (
  status text,
  attempts_remaining integer,
  patient_name text,
  appointment_id uuid,
  scheduled_at timestamptz,
  duration_minutes integer,
  appointment_status public.appointment_status,
  doctor_name text,
  department_name text,
  service_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_match public.patients%rowtype;
  v_count integer;
  v_failures integer;
  v_found integer;
begin
  status := 'no_match';
  attempts_remaining := null;
  patient_name := null;
  appointment_id := null;
  scheduled_at := null;
  duration_minutes := null;
  appointment_status := null;
  doctor_name := null;
  department_name := null;
  service_name := null;

  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp() then
    status := 'locked'; attempts_remaining := 0; return next; return;
  end if;

  -- Unreadable input costs no attempt: our inability to parse a value must not
  -- spend the patient's budget. Same property as the date-of-birth path.
  if p_full_name is null or public.fold_patient_name(p_full_name) is null
     or p_national_id is null or public.fold_national_id(p_national_id) is null then
    status := 'unreadable'; return next; return;
  end if;

  select count(*)::integer into v_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id)
    and public.fold_patient_name(p.full_name) = public.fold_patient_name(p_full_name);

  if v_count <> 1 then
    update public.conversations c
    set identity_verification_failures = least(c.identity_verification_failures + 1, 5),
        identity_verification_locked_until = case
          when c.identity_verification_failures + 1 >= 5
            then clock_timestamp() + interval '30 minutes'
          else c.identity_verification_locked_until end
    where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    returning c.identity_verification_failures into v_failures;
    insert into public.audit_logs (
      clinic_id, action, table_name, record_id, actor_type, source, new_data
    ) values (
      p_clinic_id, 'AI_APPOINTMENT_LOOKUP_NO_MATCH', 'conversations', p_conversation_id,
      'ai', 'ai_assistant',
      jsonb_build_object('scope', 'booking_only', 'clinical_disclosure', false)
    );
    status := case when v_failures >= 5 then 'locked' else 'no_match' end;
    attempts_remaining := greatest(5 - coalesce(v_failures, 5), 0);
    return next; return;
  end if;

  select p.* into v_match
  from public.patients p
  where p.clinic_id = p_clinic_id
    and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id)
    and public.fold_patient_name(p.full_name) = public.fold_patient_name(p_full_name)
  limit 1;

  -- The attempt budget is restored on success, and nothing else on the
  -- conversation is written. In particular `patient_id`, `patient_link_status`,
  -- `booking_identity_confirmed_at` and `identity_verified_at` are untouched:
  -- this call answers a question, it does not change who the thread is.
  update public.conversations c
  set identity_verification_failures = 0
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_APPOINTMENT_LOOKUP_MATCHED', 'appointments', p_conversation_id,
    'ai', 'ai_assistant',
    jsonb_build_object('scope', 'booking_only', 'clinical_disclosure', false)
  );

  v_found := 0;
  for appointment_id, scheduled_at, duration_minutes, appointment_status,
      doctor_name, department_name, service_name in
    select
      a.id, a.scheduled_at, a.duration_minutes, a.status,
      d.full_name, dep.name, s.name
    from public.appointments a
    join public.profiles d
      on d.id = a.doctor_id and d.clinic_id = a.clinic_id
    left join public.departments dep
      on dep.id = a.department_id and dep.clinic_id = a.clinic_id
    left join public.services s
      on s.id = a.service_id and s.clinic_id = a.clinic_id
    where a.clinic_id = p_clinic_id
      and a.patient_id = v_match.id
      and a.deleted_at is null
      and a.status not in (
        'replaced'::public.appointment_status,
        'cancelled'::public.appointment_status
      )
      and a.scheduled_at >= clock_timestamp()
    order by a.scheduled_at
    limit 10
  loop
    v_found := v_found + 1;
    status := 'found';
    attempts_remaining := 5;
    patient_name := v_match.full_name;
    return next;
  end loop;

  if v_found = 0 then
    status := 'no_upcoming';
    attempts_remaining := 5;
    patient_name := v_match.full_name;
    appointment_id := null;
    scheduled_at := null;
    duration_minutes := null;
    appointment_status := null;
    doctor_name := null;
    department_name := null;
    service_name := null;
    return next;
  end if;
  return;
end;
$$;

revoke all on function public.lookup_patient_appointments_by_identity(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.lookup_patient_appointments_by_identity(uuid, uuid, text, text)
  to service_role;

comment on function public.lookup_patient_appointments_by_identity(uuid, uuid, text, text) is
  'Booking-scope appointment lookup by exact folded name AND national id. Never reads '
  'conversations.patient_id, never links or verifies a conversation, never discloses '
  'clinical data, and reports every failure as the same no_match.';
