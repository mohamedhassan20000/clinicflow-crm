-- P11S — confirming a booking identity without ever handling the full ID.
--
-- The booking flow's identity question is "You're {name}, correct?". A name
-- alone is weak evidence in the markets ClinicFlow serves — families share
-- surnames and clinics hold several "محمد أحمد" — so staff asked for the
-- confirmation to carry a second, recognisable detail.
--
-- The obvious second detail is the national/civil ID, and it is the one thing
-- that must never appear in a WhatsApp thread: it is semi-public, it is the key
-- `identify_patient_for_booking` matches on, and a message history is not a
-- place to leave it. So the assistant is never given it. It is given the last
-- four digits and nothing else — enough for the patient to recognise their own
-- record, useless to anyone reading over their shoulder, and impossible to
-- expand back into the ID because the rest never leaves the database.
--
-- `resolve_patient_ai_context` is the single place patient-AI identity is
-- assembled, so the suffix is computed here, in SQL, from `patient.national_id`
-- — not in TypeScript from a full value that would then exist in application
-- memory. A return-type change needs a drop/recreate; the body is otherwise
-- byte-identical to the version this replaces, plus the one column.

drop function if exists public.resolve_patient_ai_context(uuid, uuid);

create function public.resolve_patient_ai_context(
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
  patient_display_name text,
  patient_national_id_suffix text
)
language plpgsql
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
    case when patient.id is null then null else patient.full_name end,
    -- Digits only, last four, and only when there are more than four to begin
    -- with: a short ID would otherwise be returned whole by a column whose
    -- entire purpose is that it never is.
    case
      when patient.id is null then null
      when length(regexp_replace(coalesce(patient.national_id, ''), '\D', '', 'g')) > 4
        then right(regexp_replace(patient.national_id, '\D', '', 'g'), 4)
      else null
    end
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

comment on function public.resolve_patient_ai_context(uuid, uuid) is
  'Patient AI identity context. P11S adds patient_national_id_suffix — the last four digits only, so a booking confirmation can be recognisable without a national ID ever entering a WhatsApp thread or application memory.';

revoke all on function public.resolve_patient_ai_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_patient_ai_context(uuid, uuid)
  to service_role;
