-- P11R: a conversation-bound, explicit-confirmation mutation boundary for
-- changing one verified patient's own pending ClinicFlow request.
--
-- This is intentionally separate from replace_appointment: that RPC derives a
-- staff actor from auth.uid(). Patient AI uses service_role, so reusing it by
-- weakening its staff authorization would widen a mature staff boundary.

create or replace function public.prepare_patient_ai_reschedule(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_appointment_id uuid
)
returns table (
  appointment_id uuid,
  scheduled_at timestamptz,
  doctor_id uuid,
  doctor_name text,
  department_id uuid,
  service_id uuid,
  duration_minutes integer
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
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.scheduling'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select c.patient_id into v_patient_id
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
    and c.identity_verified_at is not null
    and c.ai_paused_at is null;
  if not found or v_patient_id is null then
    raise exception 'PATIENT_IDENTITY_VERIFICATION_REQUIRED' using errcode = '42501';
  end if;

  return query
  select a.id, a.scheduled_at, a.doctor_id, d.full_name,
         a.department_id, a.service_id, a.duration_minutes
  from public.appointments a
  join public.profiles d on d.id = a.doctor_id and d.clinic_id = a.clinic_id
  where a.id = p_appointment_id
    and a.clinic_id = p_clinic_id
    and a.patient_id = v_patient_id
    and a.status = 'pending'::public.appointment_status
    and a.scheduled_at > clock_timestamp()
    and a.deleted_at is null
    and a.replaced_by_appointment_id is null;
end;
$$;

revoke all on function public.prepare_patient_ai_reschedule(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_patient_ai_reschedule(uuid, uuid, uuid)
  to service_role;

create or replace function public.reschedule_patient_ai_appointment(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_appointment_id uuid,
  p_scheduled_at timestamptz
)
returns table (
  rescheduled boolean,
  new_appointment_id uuid,
  reason text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_original public.appointments%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_cap integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.scheduling'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
    and c.identity_verified_at is not null
    and c.ai_paused_at is null
  for update;
  if not found or v_conversation.patient_id is null then
    raise exception 'PATIENT_IDENTITY_VERIFICATION_REQUIRED' using errcode = '42501';
  end if;

  select a.* into v_original
  from public.appointments a
  where a.id = p_appointment_id
    and a.clinic_id = p_clinic_id
    and a.patient_id = v_conversation.patient_id
    and a.deleted_at is null
  for update;
  if not found then
    return query select false, null::uuid, 'not_found'::text, null::timestamptz;
    return;
  end if;
  if v_original.status <> 'pending'::public.appointment_status
     or v_original.replaced_by_appointment_id is not null
     or v_original.scheduled_at <= clock_timestamp()
     or (v_original.expires_at is not null and v_original.expires_at <= clock_timestamp()) then
    return query select false, null::uuid, 'pending_required'::text, null::timestamptz;
    return;
  end if;
  if p_scheduled_at = v_original.scheduled_at then
    return query select false, null::uuid, 'unchanged'::text, v_original.scheduled_at;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('patient-ai-reschedule:' || p_clinic_id::text || ':' || v_original.doctor_id::text, 0)
  );
  if not public.ai_requested_slot_is_available(
    p_clinic_id, v_original.doctor_id, p_scheduled_at, v_original.duration_minutes
  ) then
    return query select false, null::uuid, 'slot_unavailable'::text, null::timestamptz;
    return;
  end if;

  select c.ai_pending_slot_cap into v_cap
  from public.clinics c where c.id = p_clinic_id and c.is_active;
  if v_cap is null or (
    select count(*)
    from public.appointments a
    where a.clinic_id = p_clinic_id
      and a.doctor_id = v_original.doctor_id
      and a.scheduled_at = p_scheduled_at
      and a.status = 'pending'::public.appointment_status
      and a.deleted_at is null
      and (a.expires_at is null or a.expires_at > clock_timestamp())
  ) >= v_cap then
    return query select false, null::uuid, 'slot_pending_cap'::text, null::timestamptz;
    return;
  end if;

  insert into public.appointments (
    id, clinic_id, patient_id, doctor_id, department_id, service_id,
    scheduled_at, duration_minutes, status, notes, insurance_provider_id,
    package_id, package_session_number, expires_at, created_by,
    ai_patient_conversation_id, replaces_appointment_id,
    original_appointment_id
  ) values (
    v_new_id, v_original.clinic_id, v_original.patient_id, v_original.doctor_id,
    v_original.department_id, v_original.service_id, p_scheduled_at,
    v_original.duration_minutes, 'pending'::public.appointment_status,
    v_original.notes, v_original.insurance_provider_id, v_original.package_id,
    v_original.package_session_number, v_original.expires_at, null,
    p_conversation_id, v_original.id,
    coalesce(v_original.original_appointment_id, v_original.id)
  );

  update public.appointments
  set status = 'replaced'::public.appointment_status,
      replaced_by_appointment_id = v_new_id,
      updated_by = null,
      updated_at = clock_timestamp()
  where id = v_original.id and clinic_id = p_clinic_id;

  insert into public.audit_logs (
    clinic_id, action, table_name, record_id, actor_type, source, old_data, new_data
  ) values (
    p_clinic_id, 'AI_TOOL_RESCHEDULE_MY_APPOINTMENT', 'appointments', v_new_id,
    'ai', 'ai_assistant',
    jsonb_build_object('appointment_id', v_original.id, 'scheduled_at', v_original.scheduled_at),
    jsonb_build_object('appointment_id', v_new_id, 'scheduled_at', p_scheduled_at,
                       'status', 'pending', 'replaces_appointment_id', v_original.id)
  );

  return query select true, v_new_id, 'rescheduled'::text, p_scheduled_at;
end;
$$;

revoke all on function public.reschedule_patient_ai_appointment(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reschedule_patient_ai_appointment(uuid, uuid, uuid, timestamptz)
  to service_role;

comment on function public.reschedule_patient_ai_appointment(uuid, uuid, uuid, timestamptz) is
  'Atomically replaces one DOB-verified conversation patient pending appointment after an authoritative slot offer and explicit application confirmation.';
