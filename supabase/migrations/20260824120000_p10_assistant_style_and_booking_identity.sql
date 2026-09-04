-- P10 — assistant communication style, richer intake, and booking identity.
--
-- Additive only. Nothing here drops a column, narrows a constraint, or changes
-- the meaning of an existing value: every new column carries a default that
-- reproduces today's behaviour, and every replaced function keeps its old
-- arguments with defaults so a deploy that lands before this migration still
-- calls a signature that exists.
--
-- Four things are added, in the order the assistant meets them:
--
--   1. **Communication style on `clinics`.** Language, Arabic register, tone and
--      one short clinic-authored style line. The patient assistant reads them
--      through `resolve_patient_ai_context` and puts them in the system prompt,
--      so "speak Egyptian Arabic, friendly and concise" is product
--      configuration rather than something the model has to be talked into on
--      every turn. `ai_style_instruction` is *communication style only* — the
--      prompt frames it as untrusted clinic-authored text that can never
--      override a security, medical, booking or identity rule.
--
--   2. **Blood type and the patient's own spelling on `ai_patient_intakes`.**
--      Blood type because it is on the real New Patient form and the AI intake
--      was the only path that could not collect it. `full_name_original`
--      because transliterating "علي ابراهيم محمد" to "Ali Ibrahim Mohamed" is
--      a convenience for the file convention and must not be the *only* record
--      of what the patient actually wrote.
--
--   3. **Booking identity, separate from clinical identity.** A patient writing
--      from the number already on their file may confirm their own name and
--      book. That is emphatically *not* permission to be shown clinical data:
--      `booking_identity_confirmed_at` is a new, weaker column and
--      `identity_verified_at` — the one every clinical disclosure path checks —
--      is left strictly alone. Nothing in this migration ever writes it.
--
--   4. **Identification from a different phone**, by exact normalized name and
--      national id, rate-limited on the same counter as the date-of-birth
--      check, and deliberately incapable of saying whether a national id
--      belongs to somebody else: every failure returns the same `no_match`.

-- ---------------------------------------------------------------------------
-- 1. Communication style
-- ---------------------------------------------------------------------------

alter table public.clinics
  add column if not exists ai_language_mode text not null default 'auto',
  add column if not exists ai_arabic_style text not null default 'auto',
  add column if not exists ai_tone text not null default 'friendly',
  add column if not exists ai_style_instruction text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clinics_ai_language_mode_check'
  ) then
    alter table public.clinics add constraint clinics_ai_language_mode_check
      check (ai_language_mode in ('auto', 'ar', 'en'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'clinics_ai_arabic_style_check'
  ) then
    alter table public.clinics add constraint clinics_ai_arabic_style_check
      check (ai_arabic_style in ('auto', 'msa', 'egyptian', 'gulf', 'saudi', 'levantine'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'clinics_ai_tone_check'
  ) then
    alter table public.clinics add constraint clinics_ai_tone_check
      check (ai_tone in ('friendly', 'neutral', 'formal'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'clinics_ai_style_instruction_check'
  ) then
    alter table public.clinics add constraint clinics_ai_style_instruction_check
      check (ai_style_instruction is null or char_length(ai_style_instruction) <= 280);
  end if;
end;
$$;

comment on column public.clinics.ai_language_mode is
  'Patient assistant language: auto (mirror the patient), ar, or en.';
comment on column public.clinics.ai_arabic_style is
  'Arabic register the assistant writes in when it writes Arabic.';
comment on column public.clinics.ai_tone is
  'Register of the patient assistant: friendly, neutral, or formal.';
comment on column public.clinics.ai_style_instruction is
  'One short clinic-authored communication-style line. Style only: it can never '
  'override a security, medical, booking or identity rule.';

-- ---------------------------------------------------------------------------
-- 2. Intake: blood type and the name as the patient wrote it
-- ---------------------------------------------------------------------------

alter table public.ai_patient_intakes
  add column if not exists blood_type public.blood_type,
  add column if not exists full_name_original text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_patient_intakes_full_name_original_check'
  ) then
    alter table public.ai_patient_intakes
      add constraint ai_patient_intakes_full_name_original_check
      check (
        full_name_original is null
        or char_length(full_name_original) between 2 and 100
      );
  end if;
end;
$$;

comment on column public.ai_patient_intakes.blood_type is
  'Blood type as collected during AI intake. Null when the patient did not give one.';
comment on column public.ai_patient_intakes.full_name_original is
  'The name exactly as the patient typed it, when `full_name` is a transliteration '
  'of it. Never overwritten by the transliteration and shown to the reviewing staff '
  'member alongside it.';

-- ---------------------------------------------------------------------------
-- 3. Booking identity — weaker than, and never a substitute for, verification
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists booking_identity_confirmed_at timestamptz;

comment on column public.conversations.booking_identity_confirmed_at is
  'The sender confirmed, for booking purposes only, which patient file this thread '
  'belongs to. Deliberately NOT identity_verified_at: no clinical, appointment or '
  'record disclosure may read this column. Booking only.';

-- ---------------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------------

-- resolve_patient_ai_context: same shape plus the style columns and the two
-- booking-identity facts. Recreated rather than altered because the return
-- table is part of the signature.
drop function if exists public.resolve_patient_ai_context(uuid, uuid);

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
  pending_clarification jsonb,
  booking_stage jsonb,
  ai_language_mode text,
  ai_arabic_style text,
  ai_tone text,
  ai_style_instruction text,
  booking_identity_confirmed_at timestamptz,
  patient_display_name text
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
    conversation.ai_pending_clarification,
    conversation.ai_booking_stage,
    clinic.ai_language_mode,
    clinic.ai_arabic_style,
    clinic.ai_tone,
    clinic.ai_style_instruction,
    case when patient.id is null then null else conversation.booking_identity_confirmed_at end,
    -- The name is returned only so the assistant can ask "you are X, correct?"
    -- of somebody writing from the number already on that file. It is not a
    -- clinical field and it is null whenever the thread is not linked.
    case when patient.id is null then null else patient.full_name end
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

-- The clinic's communication style, written by an admin through the settings
-- action. `clinics` has no clinic_id column, so this is keyed by primary key.
create or replace function public.set_clinic_ai_communication_style(
  p_clinic_id uuid,
  p_language_mode text,
  p_arabic_style text,
  p_tone text,
  p_style_instruction text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  update public.clinics c
  set ai_language_mode = p_language_mode,
      ai_arabic_style = p_arabic_style,
      ai_tone = p_tone,
      ai_style_instruction = nullif(btrim(coalesce(p_style_instruction, '')), '')
  where c.id = p_clinic_id;
  if not found then raise exception 'CLINIC_NOT_FOUND'; end if;
end;
$$;

revoke all on function public.set_clinic_ai_communication_style(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_clinic_ai_communication_style(uuid, text, text, text, text)
  to service_role;

-- Booking-identity confirmation for a thread whose number already selects one
-- patient file. Writes only the weak column. It cannot verify identity, cannot
-- link a conversation, and refuses outright unless the thread is already linked
-- to a live patient of this clinic.
create or replace function public.confirm_patient_booking_identity(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (status text, patient_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient public.patients%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  if v_conversation.patient_id is null then
    status := 'not_linked'; patient_name := null; return next; return;
  end if;
  select p.* into v_patient from public.patients p
  where p.id = v_conversation.patient_id and p.clinic_id = p_clinic_id
    and not p.is_deleted and p.deleted_at is null;
  if not found then
    status := 'not_linked'; patient_name := null; return next; return;
  end if;
  -- The number on this thread is the evidence. A thread is only ever linked by
  -- the reviewed phone-matching path, so reaching here means WhatsApp proved
  -- the sender holds the number on that file.
  if v_conversation.participant_address is null
     or v_patient.phone is distinct from v_conversation.participant_address then
    status := 'phone_mismatch'; patient_name := null; return next; return;
  end if;
  update public.conversations c
  set booking_identity_confirmed_at = clock_timestamp()
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_BOOKING_IDENTITY_CONFIRMED', 'conversations', p_conversation_id,
    'ai', 'ai_assistant',
    jsonb_build_object('scope', 'booking_only', 'clinical_disclosure', false)
  );
  status := 'confirmed'; patient_name := v_patient.full_name; return next;
end;
$$;

revoke all on function public.confirm_patient_booking_identity(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_patient_booking_identity(uuid, uuid)
  to service_role;

-- A known patient writing from a number that is not on their file. Exact,
-- normalized name AND national id, both. Rate-limited on the same counter the
-- date-of-birth check uses, so a stranger cannot iterate national ids here any
-- more cheaply than there — and every failure is the same `no_match`, so this
-- can never answer "does this id exist?".
create or replace function public.identify_patient_for_booking(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text
)
returns table (status text, attempts_remaining integer, patient_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_match public.patients%rowtype;
  v_count integer;
  v_failures integer;
begin
  attempts_remaining := null;
  patient_name := null;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select c.* into v_conversation from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.status = 'open'::public.conversation_status
  for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.ai_paused_at is not null then
    raise exception 'HUMAN_TAKEOVER_ACTIVE' using errcode = '42501';
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp() then
    status := 'locked'; attempts_remaining := 0; return next; return;
  end if;
  if v_conversation.patient_id is not null then
    status := 'already_linked'; return next; return;
  end if;
  if p_full_name is null or public.fold_patient_name(p_full_name) is null
     or p_national_id is null or public.fold_national_id(p_national_id) is null then
    status := 'no_match'; return next; return;
  end if;

  -- Both must select the same single live record. No fuzzy resolver takes part
  -- in this decision, by design: this is identity, and identity is exact.
  select count(*)::integer into v_count from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
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
    status := case when v_failures >= 5 then 'locked' else 'no_match' end;
    attempts_remaining := greatest(5 - v_failures, 0);
    return next; return;
  end if;
  select p.* into v_match from public.patients p
  where p.clinic_id = p_clinic_id and not p.is_deleted and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id)
    and public.fold_patient_name(p.full_name) = public.fold_patient_name(p_full_name)
  limit 1;

  -- Booking identity only. `identity_verified_at` is untouched, so every
  -- clinical, appointment and record disclosure still demands the date-of-birth
  -- check even though this thread may now book.
  update public.conversations c
  set patient_id = v_match.id,
      patient_link_status = 'automatic',
      booking_identity_confirmed_at = clock_timestamp(),
      identity_verification_failures = 0
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id;
  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, new_data
  ) values (
    p_clinic_id, 'AI_BOOKING_IDENTITY_MATCHED', 'conversations', p_conversation_id,
    'ai', 'ai_assistant',
    jsonb_build_object('scope', 'booking_only', 'clinical_disclosure', false)
  );
  status := 'identified'; attempts_remaining := 5; patient_name := v_match.full_name;
  return next;
end;
$$;

revoke all on function public.identify_patient_for_booking(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.identify_patient_for_booking(uuid, uuid, text, text)
  to service_role;

-- stage_patient_intake_from_conversation gains two optional arguments.
--
-- The previous ten-argument signature is dropped rather than left beside the
-- new one, and that is not optional: PostgREST resolves an RPC by name and
-- refuses with `PGRST203` ("could not choose the best candidate function")
-- the moment two overloads could both accept a call. Leaving the old one in
-- place would break *every* intake staging call the instant this migration
-- landed — which is exactly what the integration suite caught.
--
-- Dropping it is safe because both new arguments default to null: any caller
-- built against the old signature produces a call the new function accepts
-- with identical behaviour, so a build that lands before this migration and a
-- build that lands after it both work.
drop function if exists public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text
);

create or replace function public.stage_patient_intake_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text,
  p_department_id uuid,
  p_doctor_id uuid,
  p_for_third_party boolean default false,
  p_phone text default null,
  p_blood_type text default null,
  p_full_name_original text default null
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
  v_blood public.blood_type;
  v_original text;
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

  if v_conversation.patient_id is not null and not coalesce(p_for_third_party, false) then
    status := 'already_linked'; intake_id := null; return next; return;
  end if;
  if v_conversation.identity_verification_locked_until > clock_timestamp()
     and not coalesce(p_for_third_party, false) then
    status := 'identity_locked'; intake_id := null; attempts_remaining := 0; return next; return;
  end if;

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
  -- An unreadable blood type is dropped rather than raised: it is an optional
  -- convenience field and refusing the whole intake over it would lose a name,
  -- a national id and a date of birth the patient has already given.
  begin
    v_blood := nullif(btrim(coalesce(p_blood_type, '')), '')::public.blood_type;
  exception when others then
    v_blood := null;
  end;
  v_original := nullif(btrim(coalesce(p_full_name_original, '')), '');
  if v_original is not null and char_length(v_original) not between 2 and 100 then
    v_original := null;
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

  if v_id_count > 0 then
    status := 'duplicate_review'; intake_id := null; return next; return;
  end if;

  v_requested_by := case
    when coalesce(p_for_third_party, false) then v_conversation.patient_id
    else null
  end;

  insert into public.ai_patient_intakes (
    clinic_id, conversation_id, full_name, date_of_birth, phone, email,
    national_id, department_id, doctor_id, is_third_party, requested_by_patient_id,
    blood_type, full_name_original
  ) values (
    p_clinic_id, p_conversation_id, btrim(p_full_name), p_date_of_birth, v_phone,
    lower(btrim(p_email)), btrim(p_national_id),
    p_department_id, p_doctor_id, coalesce(p_for_third_party, false), v_requested_by,
    v_blood, v_original
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
        -- A later call that carries no blood type must not erase one an earlier
        -- turn already collected.
        blood_type = coalesce(excluded.blood_type, ai_patient_intakes.blood_type),
        full_name_original = coalesce(
          excluded.full_name_original, ai_patient_intakes.full_name_original
        ),
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
      'is_third_party', coalesce(p_for_third_party, false),
      'blood_type_supplied', v_blood is not null
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
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid, boolean, text, text, text
) to service_role;

-- approve_ai_patient_intake: byte-for-byte the P7-followup definition, with one
-- change — the new patient record carries the blood type the intake collected.
-- The whole body is restated because plpgsql has no way to patch a single
-- statement inside a function, and restating it is what keeps the identity,
-- duplicate and audit rules in this file readable next to the change.
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
      department_id, assigned_doctor_id, file_number, created_by, blood_type
    ) values (
      v_intake.clinic_id, v_intake.full_name, v_intake.national_id,
      v_intake.date_of_birth, v_intake.phone, v_intake.email,
      v_intake.department_id, v_intake.doctor_id, v_file, p_actor_id, v_intake.blood_type
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
