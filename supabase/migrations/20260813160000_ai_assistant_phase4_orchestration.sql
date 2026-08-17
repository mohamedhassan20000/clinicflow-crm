-- Phase 4: retain sanitized AI SDK tool parts across a refresh and replace the
-- retired workflow-run booking provenance with the action-receipt ledger.

alter table public.agent_messages
  add column if not exists parts jsonb;

comment on column public.agent_messages.parts is
  'Sanitized, size-bounded AI SDK UI message parts. Tool outputs are retained for conversation resume; model history remains separately redacted.';

alter table public.appointments
  add column if not exists ai_action_receipt_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'appointments_ai_action_receipt_fkey'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_ai_action_receipt_fkey
      foreign key (ai_action_receipt_id)
      references public.ai_action_receipts(id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists appointments_ai_action_receipt_uidx
  on public.appointments (ai_action_receipt_id)
  where ai_action_receipt_id is not null;

alter table public.appointments
  drop constraint if exists appointments_ai_workflow_pair_check,
  add constraint appointments_ai_workflow_pair_check check (
    (ai_workflow_run_id is null and ai_workflow_step_id is null)
    or (ai_workflow_run_id is not null and ai_workflow_step_id ~ '^[a-z][a-z0-9_]{0,63}$')
  ),
  drop constraint if exists appointments_ai_origin_exclusive_check,
  add constraint appointments_ai_origin_exclusive_check check (
    (case when ai_patient_conversation_id is null then 0 else 1 end)
    + (case when ai_workflow_run_id is null then 0 else 1 end)
    + (case when ai_action_receipt_id is null then 0 else 1 end) <= 1
  ),
  drop constraint if exists appointments_ai_pending_expiry_check,
  add constraint appointments_ai_pending_expiry_check check (
    status <> 'pending'::public.appointment_status
    or (ai_patient_conversation_id is null and ai_workflow_run_id is null and ai_action_receipt_id is null)
    or expires_at is not null
  );

create or replace function public.protect_ai_booking_metadata()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'INSERT' then
    if new.ai_patient_conversation_id is not null or new.ai_workflow_run_id is not null
       or new.ai_workflow_step_id is not null or new.ai_action_receipt_id is not null
       or new.expires_at is not null then
      raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
    end if;
  elsif old.ai_patient_conversation_id is distinct from new.ai_patient_conversation_id
     or old.ai_workflow_run_id is distinct from new.ai_workflow_run_id
     or old.ai_workflow_step_id is distinct from new.ai_workflow_step_id
     or old.ai_action_receipt_id is distinct from new.ai_action_receipt_id
     or old.expires_at is distinct from new.expires_at then
    raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appointments_guard_ai_metadata on public.appointments;
create trigger trg_appointments_guard_ai_metadata before insert or update of
  ai_patient_conversation_id, ai_workflow_run_id, ai_workflow_step_id,
  ai_action_receipt_id, expires_at
  on public.appointments for each row execute function public.protect_ai_booking_metadata();

create or replace function public.enforce_ai_pending_booking_policy()
returns trigger language plpgsql set search_path = '' as $$
declare v_slot_cap integer; v_ttl_minutes integer; v_patient_pending integer; v_slot_pending integer;
  v_conversation_patient uuid; v_receipt public.ai_action_receipts%rowtype; v_is_ai boolean; v_old_is_active boolean := false;
begin
  v_is_ai := new.ai_patient_conversation_id is not null or new.ai_workflow_run_id is not null or new.ai_action_receipt_id is not null;
  if not v_is_ai or new.status <> 'pending'::public.appointment_status or new.deleted_at is not null then return new; end if;
  if tg_op = 'UPDATE' then
    v_old_is_active := (old.ai_patient_conversation_id is not null or old.ai_workflow_run_id is not null or old.ai_action_receipt_id is not null)
      and old.status = 'pending'::public.appointment_status and old.deleted_at is null;
    if v_old_is_active and old.patient_id = new.patient_id and old.doctor_id = new.doctor_id and old.scheduled_at = new.scheduled_at
       and old.ai_patient_conversation_id is not distinct from new.ai_patient_conversation_id
       and old.ai_workflow_run_id is not distinct from new.ai_workflow_run_id
       and old.ai_action_receipt_id is not distinct from new.ai_action_receipt_id then return new; end if;
  end if;
  select ai_pending_slot_cap, ai_pending_booking_ttl_minutes into v_slot_cap, v_ttl_minutes from public.clinics where id = new.clinic_id and is_active for share;
  if not found then raise exception 'AI_BOOKING_CLINIC_UNAVAILABLE' using errcode = 'P0001'; end if;
  if new.ai_patient_conversation_id is not null then
    select patient_id into v_conversation_patient from public.conversations where id = new.ai_patient_conversation_id and clinic_id = new.clinic_id and status = 'open'::public.conversation_status;
    if not found or v_conversation_patient is null or v_conversation_patient <> new.patient_id or new.created_by is not null then raise exception 'AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH' using errcode = '42501'; end if;
  end if;
  if new.ai_action_receipt_id is not null then
    select * into v_receipt from public.ai_action_receipts where id = new.ai_action_receipt_id and clinic_id = new.clinic_id and actor_id = new.created_by and action_id = 'appointments.create_pending' and phase = 'execute';
    if not found then raise exception 'AI_BOOKING_ACTION_RECEIPT_MISMATCH' using errcode = '42501'; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('p5a-ai-booking:' || new.clinic_id::text, 0));
  new.expires_at := coalesce(new.expires_at, clock_timestamp() + make_interval(mins => v_ttl_minutes));
  if new.expires_at <= clock_timestamp() then raise exception 'AI_BOOKING_INVALID_EXPIRY' using errcode = '22023'; end if;
  select count(*)::integer into v_patient_pending from public.appointments where clinic_id = new.clinic_id and patient_id = new.patient_id and status = 'pending'::public.appointment_status and deleted_at is null and expires_at > clock_timestamp() and (ai_patient_conversation_id is not null or ai_workflow_run_id is not null or ai_action_receipt_id is not null) and (tg_op = 'INSERT' or id <> new.id);
  if v_patient_pending >= 1 then raise exception 'AI_PENDING_PATIENT_CAP' using errcode = 'P0001'; end if;
  select count(*)::integer into v_slot_pending from public.appointments where clinic_id = new.clinic_id and doctor_id = new.doctor_id and scheduled_at = new.scheduled_at and status = 'pending'::public.appointment_status and deleted_at is null and expires_at > clock_timestamp() and (ai_patient_conversation_id is not null or ai_workflow_run_id is not null or ai_action_receipt_id is not null) and (tg_op = 'INSERT' or id <> new.id);
  if v_slot_pending >= v_slot_cap then raise exception 'AI_PENDING_SLOT_CAP' using errcode = 'P0001'; end if;
  return new;
end;
$$;

drop trigger if exists trg_appointments_ai_pending_policy on public.appointments;
create trigger trg_appointments_ai_pending_policy before insert or update of
  patient_id, doctor_id, scheduled_at, status, deleted_at, expires_at,
  ai_patient_conversation_id, ai_workflow_run_id, ai_action_receipt_id
  on public.appointments for each row execute function public.enforce_ai_pending_booking_policy();

comment on column public.appointments.ai_action_receipt_id is
  'Phase 4 action-receipt provenance for a confirmed Assistant pending booking; replaces new workflow-run writes.';

-- The normal agent loop and ai_action_receipts supersede ai_workflow_runs.
-- Historical rows remain readable for audit and keep their appointment foreign
-- keys intact; Phase 4 has no producer for new rows in this legacy ledger.
comment on table public.ai_workflow_runs is
  'Retired after Phase 4. Historical content-free workflow rows remain read-only for audit and appointment provenance; all new action attempts use ai_action_receipts.';
revoke insert, update, delete on table public.ai_workflow_runs from service_role;

-- Keep the commercial step ceiling aligned with the largest certified Phase 4
-- policy. Runtime execution clamps each task policy to this plan-level limit.
update public.plans
set limits = jsonb_set(
      coalesce(limits, '{}'::jsonb),
      '{ai_turn_steps_max}',
      '25'::jsonb,
      true
    ),
    updated_at = clock_timestamp()
where coalesce((features ->> 'ai_assistant')::boolean, false);
