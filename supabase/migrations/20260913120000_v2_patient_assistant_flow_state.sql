-- ---------------------------------------------------------------------------
-- V2 patient assistant — flow state, package reads, document reads
--
-- AUTHORED, NOT APPLIED. Nothing in this file has been run against any hosted
-- database. The application fails closed when these objects are absent: the V2
-- engine refuses to take a turn and the legacy path answers it, so a build that
-- ships ahead of its migration loses the new engine rather than the
-- conversation. See `lib/ai/v2/store.ts`.
--
-- Three independent pieces, in dependency order:
--
--   1. `conversations.ai_flow_state` — the V2 engine's own column. Deliberately
--      *beside* `ai_collected_data` and `ai_booking_stage` rather than
--      replacing them: the two engines coexist behind a flag, and a
--      destructive change to the legacy columns before V2 is proven would make
--      the rollback a data-loss event rather than an env var.
--
--   2. `list_patient_ai_packages` / `list_clinic_public_packages` — the two
--      package reads the assistant needs. Neither writes; session consumption
--      stays with `create_patient_preliminary_booking` and the existing
--      `enforce_appointment_package_integrity` trigger.
--
--   3. `list_patient_ai_documents` — issued documents belonging to one patient.
--      Read-only by construction: it selects `status = 'issued'` and cannot
--      create, finalize or alter a document. The AI has no issuance path.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Flow state
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists ai_flow_state jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversations_ai_flow_state_object'
  ) then
    alter table public.conversations
      add constraint conversations_ai_flow_state_object
      check (
        ai_flow_state is null
        or (
          jsonb_typeof(ai_flow_state) = 'object'
          -- Bounded for the same reason `ai_collected_data` is: a conversation
          -- record is not a place for unbounded growth, and a stack that needs
          -- more than this has gone wrong in a way a size limit should catch.
          and pg_column_size(ai_flow_state) <= 16384
        )
      );
  end if;
end;
$$;

comment on column public.conversations.ai_flow_state is
  'V2 patient assistant flow stack. Written only by the V2 flow engine; the legacy ai_collected_data/ai_booking_stage columns are untouched by it.';

/**
 * Reads and writes the V2 flow stack, under a row lock.
 *
 * Replace semantics, never merge. The stack is internally consistent — frames,
 * their slots and the offer that belongs to the top one — so merging two
 * partial snapshots could produce a state that was never true. That is the same
 * reasoning `set_conversation_ai_state` applies to `p_stage`, and the opposite
 * of what it does for `p_collected`, deliberately.
 *
 * The lock is what makes two workers racing the same inbound message safe: the
 * second one reads the first one's committed stack rather than overwriting it.
 */
create or replace function public.set_conversation_flow_state(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_flow_state jsonb
)
returns table (flow_state jsonb)
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
  if p_flow_state is not null and jsonb_typeof(p_flow_state) <> 'object' then
    raise exception 'INVALID_FLOW_STATE';
  end if;

  select c.* into v_row
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  update public.conversations c
  set ai_flow_state = p_flow_state
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  returning c.ai_flow_state into flow_state;

  return next;
end;
$$;

revoke all on function public.set_conversation_flow_state(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_conversation_flow_state(uuid, uuid, jsonb)
  to service_role;

-- The episode reset paths must clear the V2 stack exactly as they clear the
-- legacy state. A new episode with the previous episode's flow stack in it
-- would be the same defect this rebuild exists to close, one column over.
create or replace function public.reset_conversation_flow_state(
  p_clinic_id uuid,
  p_conversation_id uuid
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

  update public.conversations
  set ai_flow_state = null
  where id = p_conversation_id
    and clinic_id = p_clinic_id;
end;
$$;

revoke all on function public.reset_conversation_flow_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reset_conversation_flow_state(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Packages
-- ---------------------------------------------------------------------------

/**
 * The clinic's package offering, as a member of the public may ask about it.
 *
 * Takes no patient and returns no patient. This is the answer to "what packages
 * do you have?" from a stranger, and it is deliberately a different function
 * from the one below so that no argument mistake can turn a public question
 * into a disclosure.
 */
create or replace function public.list_clinic_public_packages(
  p_clinic_id uuid,
  p_department_id uuid default null
)
returns table (
  template_id uuid,
  name text,
  department_id uuid,
  department_name text,
  total_sessions integer,
  price_per_session numeric,
  total_price numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The same guard every other function in this file carries. The grants below
  -- already restrict execution to the service role, so this is defence in
  -- depth — but a `security definer` function whose only protection is its
  -- grant is one `grant execute` away from being public, and being the single
  -- exception in the file is exactly how that grant gets written.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  return query
  select t.id,
         t.name,
         t.department_id,
         d.name,
         t.total_sessions,
         t.price_per_session,
         t.total_price
  from public.package_templates t
  join public.departments d on d.id = t.department_id
  where t.clinic_id = p_clinic_id
    and t.is_active
    and d.is_active
    and (p_department_id is null or t.department_id = p_department_id)
  order by d.name, t.name;
end;
$$;

revoke all on function public.list_clinic_public_packages(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.list_clinic_public_packages(uuid, uuid)
  to service_role;

/**
 * One patient's usable packages, resolved from the conversation.
 *
 * Takes `p_conversation_id` rather than a patient id, for the same reason every
 * other patient-facing RPC here does: the thread's own linkage is the identity,
 * and a patient id supplied by a caller is a patient id a model could have
 * influenced. An unlinked conversation returns nothing — not an error, which
 * would itself disclose something.
 *
 * "Usable" is enforced here rather than in the application: active, unexhausted
 * and not expired. The booking write re-checks all of it, so this is
 * presentation and the trigger is the guarantee.
 */
create or replace function public.list_patient_ai_packages(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_department_id uuid default null,
  p_service_id uuid default null
)
returns table (
  package_id uuid,
  name text,
  department_id uuid,
  service_id uuid,
  total_sessions integer,
  used_sessions integer,
  remaining_sessions integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_patient uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  -- The thread's own verified linkage, and nothing a caller passed in.
  select c.patient_id into v_patient
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.patient_id is not null;

  if v_patient is null then
    return;
  end if;

  return query
  select p.id,
         p.name,
         p.department_id,
         p.service_id,
         p.total_sessions,
         p.used_sessions,
         (p.total_sessions - p.used_sessions)
  from public.patient_packages p
  where p.clinic_id = p_clinic_id
    and p.patient_id = v_patient
    and p.is_active
    and p.used_sessions < p.total_sessions
    -- A package scoped to a department or a service is only offerable for that
    -- department or service. A package with a null scope is general.
    and (p_department_id is null or p.department_id is null or p.department_id = p_department_id)
    and (p_service_id is null or p.service_id is null or p.service_id = p_service_id)
  order by (p.total_sessions - p.used_sessions) asc, p.created_at asc;
end;
$$;

revoke all on function public.list_patient_ai_packages(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.list_patient_ai_packages(uuid, uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Booking against a package
-- ---------------------------------------------------------------------------

/**
 * `create_patient_preliminary_booking`, with an optional package.
 *
 * The signature gains one nullable argument and nothing else changes, so the
 * existing three-argument call sites keep working. When a package is supplied:
 *
 *   * it must belong to the same patient the conversation is linked to, be
 *     active and have a session left — re-checked here, inside the same
 *     transaction as the insert, because the read that offered it happened on
 *     an earlier turn and may be stale;
 *   * the session number is derived from `used_sessions` under the row lock,
 *     so two racing turns cannot both claim session 4;
 *   * `enforce_appointment_package_integrity` — the existing trigger — remains
 *     the authority on the appointment/package relationship. Nothing here
 *     bypasses it.
 *
 * **Why a retried webhook cannot decrement twice.** Not because of any
 * per-conversation pending-booking uniqueness — there is none, and
 * `create_patient_preliminary_booking` inserts unconditionally. The guarantee
 * is `appointments_patient_active_slot_key`, the partial unique index on
 * (patient_id, scheduled_at) excluding cancelled / no_show / replaced rows: a
 * replay of the same confirmation targets the same instant, the insert raises
 * unique_violation, and because the decrement above happens inside this same
 * transaction it rolls back with it. A retry at a *different* instant is a
 * different appointment and consumes a second session, which is correct.
 *
 * The distinction matters because the two have different failure modes: drop
 * that index and this function silently starts double-spending packages.
 */
create or replace function public.create_patient_preliminary_booking_v2(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_doctor_id uuid,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_service_id uuid default null,
  p_package_id uuid default null
)
returns table (appointment_id uuid, package_session_number integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient uuid;
  v_package public.patient_packages%rowtype;
  v_session integer := null;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.patient_id into v_patient
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;
  if v_patient is null then
    raise exception 'PATIENT_NOT_LINKED';
  end if;

  if p_package_id is not null then
    -- Locked, then re-validated. The offer the patient accepted was made on an
    -- earlier turn against an earlier read; only this check, inside this
    -- transaction, can say the session is still there.
    select * into v_package
    from public.patient_packages p
    where p.id = p_package_id
      and p.clinic_id = p_clinic_id
      and p.patient_id = v_patient
    for update;

    if not found then
      raise exception 'PACKAGE_NOT_FOUND';
    end if;
    if not v_package.is_active then
      raise exception 'PACKAGE_INACTIVE';
    end if;
    if v_package.used_sessions >= v_package.total_sessions then
      raise exception 'PACKAGE_EXHAUSTED';
    end if;

    v_session := v_package.used_sessions + 1;
    update public.patient_packages
    set used_sessions = used_sessions + 1
    where id = p_package_id;
  end if;

  -- The existing preliminary-booking function still performs every slot,
  -- notice and ownership check. This wrapper adds the package and nothing else.
  select b.appointment_id into appointment_id
  from public.create_patient_preliminary_booking(
    p_clinic_id,
    p_conversation_id,
    p_doctor_id,
    p_scheduled_at,
    p_duration_minutes,
    p_service_id
  ) b;

  if appointment_id is null then
    -- The booking did not happen, so the session must not be spent. Raising
    -- rolls the decrement above back with it, which is the whole reason the
    -- two live in one function.
    raise exception 'BOOKING_FAILED';
  end if;

  if p_package_id is not null then
    update public.appointments
    set package_id = p_package_id,
        package_session_number = v_session
    where id = appointment_id
      and clinic_id = p_clinic_id;
  end if;

  package_session_number := v_session;
  return next;
end;
$$;

revoke all on function public.create_patient_preliminary_booking_v2(
  uuid, uuid, uuid, timestamptz, integer, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.create_patient_preliminary_booking_v2(
  uuid, uuid, uuid, timestamptz, integer, uuid, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Issued documents
-- ---------------------------------------------------------------------------

/**
 * Documents already issued to the patient this conversation is linked to.
 *
 * Retrieval only, and the shape of the function is the guarantee:
 *
 *   * `status = 'issued'` and `voided_at is null` — a draft, a failed render
 *     and a voided document are all invisible;
 *   * `issued_by is not null` — every row was finalized by an authorized
 *     ClinicFlow user. There is no branch here that creates one, and the AI has
 *     no other path to `documents`;
 *   * the patient comes from the conversation's linkage, never from an
 *     argument, so no caller can ask for somebody else's records;
 *   * nothing about another patient can leak, because nothing about another
 *     patient is selected.
 *
 * The storage path is returned so the application can mint a short-lived signed
 * URL. The bytes are never returned through this function.
 */
create or replace function public.list_patient_ai_documents(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_doc_type text default null,
  p_limit integer default 10
)
returns table (
  document_id uuid,
  doc_type text,
  document_number text,
  issued_at timestamptz,
  pdf_storage_path text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_patient uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.patient_id into v_patient
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.patient_id is not null;

  if v_patient is null then
    return;
  end if;

  return query
  select d.id,
         d.doc_type,
         d.document_number,
         d.issued_at,
         d.pdf_storage_path
  from public.documents d
  where d.clinic_id = p_clinic_id
    and d.patient_id = v_patient
    and d.status = 'issued'
    and d.voided_at is null
    -- Finalized by an authorized ClinicFlow user. Stated as a predicate rather
    -- than as a comment: the contract above and `lib/ai/v2/tools.ts` both cite
    -- this as the guarantee that nothing the AI could have produced is
    -- reachable here, and a guarantee that lives only in prose is not one.
    and d.issued_by is not null
    and d.pdf_storage_path is not null
    and (p_doc_type is null or d.doc_type = p_doc_type)
  order by d.issued_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 25));
end;
$$;

revoke all on function public.list_patient_ai_documents(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_patient_ai_documents(uuid, uuid, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. The episode boundary the application cannot reach
--
-- Three of the four episode boundaries run in TypeScript and go through
-- `resetConversationAssistantState`, which clears the stack via
-- `reset_conversation_flow_state` above. The fourth — the idle sweep — closes
-- threads entirely in SQL, on a schedule, with no process involved. So it has
-- to clear the new column itself.
--
-- Replaced here rather than by editing P11S, because P11S is applied: this file
-- introduces `ai_flow_state`, so this file owns teaching the sweeper about it.
-- The body below is P11S's, with one line added and nothing else changed.
-- ---------------------------------------------------------------------------

create or replace function public.close_idle_patient_ai_episodes(
  p_now timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_closed integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with due as (
    select c.id
    from public.conversations c
    where c.ai_auto_close_after is not null
      and c.ai_auto_close_after <= v_now
      and c.status = 'open'::public.conversation_status
      -- A human is holding this thread, or has been handed it. Neither is a
      -- finished episode, whatever the timer says.
      and c.ai_paused_at is null
      and c.ai_escalated_at is null
      -- The stale-timer guard. Anything the patient said after the offer was
      -- made means the episode continued, and the timer describes a state the
      -- conversation has already left.
      and not exists (
        select 1
        from public.inbound_messages im
        where im.conversation_id = c.id
          and im.received_at > coalesce(c.ai_auto_close_armed_at, c.ai_auto_close_after)
      )
    for update skip locked
  )
  update public.conversations c
  set status = 'closed'::public.conversation_status,
      status_updated_at = v_now,
      ai_auto_close_after = null,
      ai_auto_close_armed_at = null,
      -- The same episode reset "Close thread" performs, minus the parts that
      -- belong to the person: patient_id, patient_link_status,
      -- identity_verified_at and every message row are untouched.
      ai_collected_data = '{}'::jsonb,
      ai_pending_clarification = null,
      ai_booking_stage = null,
      -- The V2 flow stack. Added by the V2 migration: this sweep is the one
      -- episode boundary the application cannot reach, because it closes
      -- threads in SQL without any process running `resetConversationAssistantState`.
      -- Without this line an idle-closed episode kept its stack, and the next
      -- episode could be invited to resume a booking from the previous one.
      ai_flow_state = null,
      ai_paused_at = null,
      ai_last_replied_at = null,
      ai_context_reset_at = v_now
  from due
  where c.id = due.id;
  get diagnostics v_closed = row_count;

  -- A draft written for a finished exchange must never become sendable.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.status = 'pending'
    and exists (
      select 1 from public.conversations c
      where c.id = s.conversation_id
        and c.status = 'closed'::public.conversation_status
        and c.ai_context_reset_at = v_now
    );

  return v_closed;
end;
$$;

revoke all on function public.close_idle_patient_ai_episodes(timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_idle_patient_ai_episodes(timestamptz)
  to service_role;
