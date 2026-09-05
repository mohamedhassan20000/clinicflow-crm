-- P9 — server-owned booking stage for the WhatsApp patient assistant.
--
-- Additive, and deliberately narrow. One nullable jsonb column on
-- `conversations`, plus the two existing patient-AI RPCs widened to write and
-- read it. Nothing already applied is edited: `20260819120000` and
-- `20260822190000` stay exactly as they were deployed, and this file carries
-- the whole delta so it can be replayed on a database built from either state.
--
-- What the column is *not*:
--   * not an authorization input — it holds no patient id, no clinic id and no
--     verification flag, and `parseBookingStageState` in
--     `lib/ai/booking-stage.ts` rebuilds it key by key against a closed shape so
--     one could not survive a read even if it were somehow written;
--   * not model-writable — there is no tool argument anywhere that reaches it.
--     Every value is computed by ClinicFlow from a server-resolved fact and
--     written through `set_conversation_ai_state`, which is service-role only.
--
-- Rollback is "stop writing the column". The application ignores an absent or
-- unparseable value and falls back to today's flat tool mount, so this
-- migration is safe to leave in place with the feature switched off.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists ai_booking_stage jsonb;

alter table public.conversations
  drop constraint if exists conversations_ai_booking_stage_object;
alter table public.conversations
  add constraint conversations_ai_booking_stage_object
  check (ai_booking_stage is null
         or (jsonb_typeof(ai_booking_stage) = 'object'
             and pg_column_size(ai_booking_stage) <= 4096));

comment on column public.conversations.ai_booking_stage is
  'P9: server-owned booking workflow metadata for this conversation — the '
  'derived stage, when it was entered, the turn counter, the submitted/escalated/'
  'intake latches, and the doctors, days and slots actually offered to the '
  'patient. Written only by set_conversation_ai_state. Never an authorization '
  'input and never model-writable.';

-- Stage belongs to the person the thread is about, exactly as collected state
-- does. Re-pointing the thread at a different patient makes it stale by
-- definition, so it is cleared on the same edge.
create or replace function public.clear_conversation_identity_on_patient_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.patient_id is distinct from old.patient_id then
    new.identity_verified_at := null;
    new.identity_verification_failures := 0;
    new.identity_verification_locked_until := null;
    new.ai_collected_data := '{}'::jsonb;
    new.ai_pending_clarification := null;
    new.ai_booking_stage := null;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Writing it
--
-- `p_stage` is a whole-object replace rather than a merge, unlike `p_collected`.
-- The stage record is a single server-computed snapshot with internal
-- consistency between its fields (a stage, when it was entered, and the offers
-- that belong to it); merging two partial snapshots could produce a record that
-- was never true. The caller always sends the complete object it just derived.
--
-- The 5-argument signature is dropped rather than overloaded: leaving both in
-- place would make a 5-argument call ambiguous, and PostgREST resolves by
-- argument names, so an overload set is a live foot-gun rather than a
-- compatibility measure.
-- ---------------------------------------------------------------------------

drop function if exists public.set_conversation_ai_state(uuid, uuid, jsonb, jsonb, boolean);

create or replace function public.set_conversation_ai_state(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_collected jsonb default null,
  p_pending jsonb default null,
  p_clear_pending boolean default false,
  p_stage jsonb default null
)
returns table (collected jsonb, pending jsonb, stage jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.conversations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_collected is not null and jsonb_typeof(p_collected) <> 'object' then
    raise exception 'INVALID_COLLECTED_STATE';
  end if;
  if p_pending is not null and jsonb_typeof(p_pending) <> 'object' then
    raise exception 'INVALID_PENDING_STATE';
  end if;
  if p_stage is not null and jsonb_typeof(p_stage) <> 'object' then
    raise exception 'INVALID_BOOKING_STAGE_STATE';
  end if;

  update public.conversations c
  set ai_collected_data = case
        when p_collected is null then c.ai_collected_data
        -- `||` is a shallow merge: a key present in the new object wins, a key
        -- absent from it survives. That is exactly the semantics wanted — a
        -- turn that establishes a date of birth must not erase the name.
        else c.ai_collected_data || p_collected
      end,
      ai_pending_clarification = case
        when p_clear_pending then null
        when p_pending is null then c.ai_pending_clarification
        else p_pending
      end,
      ai_booking_stage = case
        when p_stage is null then c.ai_booking_stage
        else p_stage
      end
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  returning * into v_row;

  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  collected := v_row.ai_collected_data;
  pending := v_row.ai_pending_clarification;
  stage := v_row.ai_booking_stage;
  return next;
end;
$$;

revoke all on function public.set_conversation_ai_state(uuid, uuid, jsonb, jsonb, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_conversation_ai_state(uuid, uuid, jsonb, jsonb, boolean, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Reading it
--
-- The body is the one deployed by 20260822190000 (soft-deleted patients read
-- back as unlinked) with one column appended. Repeating it in full is the cost
-- of `returns table` not being alterable in place; nothing else about the
-- function changes.
-- ---------------------------------------------------------------------------

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
  booking_stage jsonb
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
    conversation.ai_booking_stage
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
