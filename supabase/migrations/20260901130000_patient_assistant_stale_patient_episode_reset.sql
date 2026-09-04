-- Patient Assistant: a soft-deleted/unavailable patient link starts a new
-- conversation episode before any booking stage or authority is resolved.
--
-- This is deliberately forward-only. Historical messages, outbound messages,
-- audit rows, patient records, appointments and reviewed intake rows are never
-- deleted or rewritten. Only the invalid conversation link and assistant-owned
-- episode state are cleared.

create or replace function public.normalize_stale_patient_conversation_episode(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (reset_performed boolean, context_reset_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_boundary timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
  for update;

  if not found then
    return;
  end if;

  -- Null is already the normalized, idempotent state. A live same-clinic
  -- patient is authoritative and must never be reset by this function.
  if v_conversation.patient_id is null or exists (
    select 1
    from public.patients p
    where p.id = v_conversation.patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted
      and p.deleted_at is null
  ) then
    reset_performed := false;
    context_reset_at := v_conversation.ai_context_reset_at;
    return next;
    return;
  end if;

  -- The newest inbound row is the first message of the fresh episode. Using
  -- its stored timestamp (and the model read's >= comparison) keeps that turn
  -- visible while excluding every older episode. The clock is only a fallback
  -- for a legacy conversation with no inbound rows at all.
  select coalesce(max(m.received_at), clock_timestamp()) into v_boundary
  from public.inbound_messages m
  where m.clinic_id = p_clinic_id
    and m.conversation_id = p_conversation_id;

  update public.conversations c
  set patient_id = null,
      patient_link_status = 'unlinked',
      booking_identity_confirmed_at = null,
      identity_verified_at = null,
      identity_verification_failures = 0,
      identity_verification_locked_until = null,
      ai_collected_data = '{}'::jsonb,
      ai_pending_clarification = null,
      ai_booking_stage = null,
      ai_escalated_at = null,
      ai_escalation_reason = null,
      ai_paused_at = null,
      ai_last_replied_at = null,
      ai_context_reset_at = v_boundary
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;

  -- Preserve the draft as audit history but make it impossible to send in the
  -- new episode.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.clinic_id = p_clinic_id
    and s.conversation_id = p_conversation_id
    and s.status = 'pending';

  reset_performed := true;
  context_reset_at := v_boundary;
  return next;
end;
$$;

revoke all on function public.normalize_stale_patient_conversation_episode(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.normalize_stale_patient_conversation_episode(uuid, uuid)
  to service_role;

-- Existing-row repair. This intentionally targets only links to patient rows
-- that are soft-deleted; a missing/cross-clinic anomaly is normalized lazily by
-- the runtime function, where the clinic and open-conversation lock are known.
with invalid_soft_deleted as (
  select c.id, c.clinic_id
  from public.conversations c
  join public.patients p
    on p.id = c.patient_id
   and p.clinic_id = c.clinic_id
  where p.is_deleted or p.deleted_at is not null
), reset_conversations as (
  update public.conversations c
  set patient_id = null,
      patient_link_status = 'unlinked',
      booking_identity_confirmed_at = null,
      identity_verified_at = null,
      identity_verification_failures = 0,
      identity_verification_locked_until = null,
      ai_collected_data = '{}'::jsonb,
      ai_pending_clarification = null,
      ai_booking_stage = null,
      ai_escalated_at = null,
      ai_escalation_reason = null,
      ai_paused_at = null,
      ai_last_replied_at = null,
      ai_context_reset_at = statement_timestamp()
  from invalid_soft_deleted invalid
  where c.id = invalid.id
    and c.clinic_id = invalid.clinic_id
  returning c.id, c.clinic_id
)
update public.ai_suggested_replies s
set status = 'superseded'
from reset_conversations reset
where s.conversation_id = reset.id
  and s.clinic_id = reset.clinic_id
  and s.status = 'pending';

-- The authoritative resolver self-normalizes first. The row lock and all
-- resets above run in this same RPC transaction, before collected/stage state
-- is selected and before application authority resolution can inspect it.
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
volatile
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

  perform normalized.reset_performed
  from public.normalize_stale_patient_conversation_episode(
    p_clinic_id,
    p_conversation_id
  ) normalized;

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
