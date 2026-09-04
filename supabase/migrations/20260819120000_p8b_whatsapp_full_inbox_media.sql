-- ===========================================================================
-- P8B — the linked device as a real inbox: full history, staff-initiated
--       conversations, outbound media, and conversational data collection.
--
-- This migration changes one product rule and adds three capabilities. It does
-- not touch the connection layer: no auth table, no session ownership column,
-- no QR/pairing object is referenced here.
--
-- ## The product rule that changes (§2 of the request)
--
-- P8/H4 admitted a history chat into the inbox only when its number matched
-- exactly one active patient, and *staged* everything else — number, WhatsApp
-- name and a message count, with the bodies deliberately dropped on the floor —
-- for a staff accept/dismiss decision.
--
-- That was the right call for an inbox whose contract was "this is the clinical
-- record". It is the wrong call for the contract the product now states: when a
-- clinic links *its own* WhatsApp account, ClinicFlow is that account's
-- workspace, and a workspace that hides most of the account's conversations and
-- silently discards their contents is not one.
--
-- So staging is removed, not disabled — two competing history models would be
-- worse than either. Every one-to-one chat the linked-device sync delivers now
-- opens an ordinary conversation, patient-linked or not.
--
-- What does **not** change, and is the whole reason this is safe:
--
--   * A conversation is WhatsApp communication history. It is **not** a medical
--     record and it is **not** identity verification. `patient_id` stays null
--     until something establishes the link, and `inbound_messages.patient_id`
--     is copied from the conversation, so an unlinked chat's messages and
--     attachments are stamped with no patient at all.
--   * Nothing here creates a patient. There is no path in this file that
--     inserts into `public.patients`.
--   * The identity rules of `register_patient_from_conversation` and
--     `verify_patient_conversation_dob` (P8/C1) are untouched. A thread
--     existing proves that a number wrote to the clinic — nothing more.
--   * Groups, broadcasts, status and newsletters are still refused a layer
--     earlier, by the worker's JID classifier.
--   * Tenant isolation is unchanged: every statement below is clinic-keyed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Conversational data collection state (§1)
--
-- The assistant kept re-asking for information the patient had already given,
-- because every tool call was stateless: "12/9/2000" came back ambiguous, the
-- patient answered "سبتمبر", and the next call had no idea what that referred
-- to. The fix is not a date-specific patch — it is somewhere to keep what has
-- been established and what is currently being clarified, for any field.
--
-- Two jsonb columns on the conversation, both written only by the reviewed RPC
-- below, both holding **normalized** values (never the patient's raw text) and
-- never anything the identity checks depend on being unforgeable — a collected
-- value is an input to a check, never a substitute for one.
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists ai_collected_data jsonb not null default '{}'::jsonb,
  add column if not exists ai_pending_clarification jsonb;

alter table public.conversations
  drop constraint if exists conversations_ai_collected_data_object;
alter table public.conversations
  add constraint conversations_ai_collected_data_object
  check (jsonb_typeof(ai_collected_data) = 'object'
         and pg_column_size(ai_collected_data) <= 8192);

alter table public.conversations
  drop constraint if exists conversations_ai_pending_clarification_object;
alter table public.conversations
  add constraint conversations_ai_pending_clarification_object
  check (ai_pending_clarification is null
         or (jsonb_typeof(ai_pending_clarification) = 'object'
             and pg_column_size(ai_pending_clarification) <= 4096));

comment on column public.conversations.ai_collected_data is
  'P8B: normalized values the patient has already supplied in this conversation '
  '(dates as YYYY-MM-DD, times as minutes past midnight, phones as E.164). '
  'Conversational memory only — never evidence of identity.';
comment on column public.conversations.ai_pending_clarification is
  'P8B: the one question currently outstanding, with the candidate readings, so '
  'a follow-up fragment ("September", "yes 2000") can be resolved against it '
  'instead of restarting the exchange.';

-- Collected state belongs to the person the thread is about. When the thread is
-- re-pointed at a different patient the state is stale by definition, so it is
-- cleared on exactly the same edge that already clears the identity stamps.
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
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Writing that state — one reviewed boundary
--
-- Deliberately a merge rather than a replace for the collected map, so two
-- concurrent turns cannot lose a field, and a hard replace for the pending
-- clarification, which is by definition singular. `p_clear_pending` exists
-- because "no outstanding question" has to be expressible, and a null argument
-- already means "leave it alone".
-- ---------------------------------------------------------------------------

create or replace function public.set_conversation_ai_state(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_collected jsonb default null,
  p_pending jsonb default null,
  p_clear_pending boolean default false
)
returns table (collected jsonb, pending jsonb)
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
      end
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  returning * into v_row;

  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  collected := v_row.ai_collected_data;
  pending := v_row.ai_pending_clarification;
  return next;
end;
$$;

revoke all on function public.set_conversation_ai_state(uuid, uuid, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.set_conversation_ai_state(uuid, uuid, jsonb, jsonb, boolean)
  to service_role;

-- The agent's context read gains the two columns, so a turn starts knowing what
-- has already been established without a second round trip.
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
  pending_clarification jsonb
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
    clinic.timezone,
    clinic.country::text,
    conversation.participant_address,
    conversation.ai_paused_at is not null,
    coalesce(conversation.ai_collected_data, '{}'::jsonb),
    conversation.ai_pending_clarification
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

-- ---------------------------------------------------------------------------
-- 3. History admission: every one-to-one chat, linked or not (§2)
--
-- `upsert_whatsapp_history_chat` no longer decides whether a chat is "clinic
-- traffic". A chat the linked account has is a conversation ClinicFlow shows.
-- The patient-number test survives, but only as an *attribution* rule — it
-- decides whether the thread arrives already linked, exactly as it does for a
-- live inbound message. It no longer decides whether the thread exists.
--
-- The signature drops `staged`, so the old one is removed first.
-- ---------------------------------------------------------------------------

drop function if exists public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz);

create or replace function public.upsert_whatsapp_history_chat(
  p_clinic_id uuid,
  p_participant text,
  p_display_name text default null,
  p_last_message_at timestamptz default null
)
returns table (conversation_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
begin
  if p_participant is null or btrim(p_participant) = '' then
    raise exception 'INVALID_HISTORY_CHAT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_participant, 0)
  );

  select c.* into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = p_participant
  for update;

  if found then
    if v_display_name is not null and v_conversation.display_name is null then
      update public.conversations
      set display_name = v_display_name
      where id = v_conversation.id;
    end if;
    conversation_id := v_conversation.id;
    created := false;
    return next;
    return;
  end if;

  -- Attribution, not admission. Exactly one active patient on this number means
  -- the thread opens already linked; anything else (nobody, or two records that
  -- would have to be guessed between) opens it unlinked, which is an ordinary
  -- WhatsApp conversation and nothing more.
  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_patient_id, v_patient_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and p.phone = p_participant
    and not p.is_deleted
    and p.deleted_at is null;
  if v_patient_count <> 1 then
    v_patient_id := null;
  end if;

  insert into public.conversations (
    clinic_id, patient_id, channel, participant_address, display_name,
    patient_link_status,
    -- No service window: the 24-hour window is a Cloud API rule keyed on a live
    -- inbound message, and an imported chat is not one.
    window_expires_at,
    status, status_updated_at, last_message_at
  ) values (
    p_clinic_id,
    v_patient_id,
    'whatsapp'::public.message_channel,
    p_participant,
    v_display_name,
    case when v_patient_id is null then 'unlinked' else 'automatic' end,
    null,
    'open'::public.conversation_status,
    coalesce(p_last_message_at, pg_catalog.now()),
    p_last_message_at
  )
  returning * into v_conversation;

  conversation_id := v_conversation.id;
  created := true;
  return next;
end;
$$;

revoke all on function public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Inbound persistence: a historical message opens its thread too (§2)
--
-- The `staged` OUT column and the staging branch are both gone. A historical
-- message whose chat was never listed now opens the thread itself, inert in
-- every way that matters (no service window, no reopen of a closed thread, no
-- status churn) — the properties H1/H4 established are kept; only the refusal
-- to store the body is dropped.
-- ---------------------------------------------------------------------------

drop function if exists public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean);

create or replace function public.persist_whatsapp_inbound(
  p_clinic_id uuid,
  p_sender text,
  p_body text,
  p_provider_message_id text,
  p_received_at timestamptz,
  p_display_name text default null,
  p_historical boolean default false
)
returns table (inserted boolean, conversation_id uuid, inbound_message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_window_expires_at timestamptz := p_received_at + interval '24 hours';
  v_display_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_message_id uuid;
begin
  if p_sender is null or btrim(p_sender) = ''
     or p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'INVALID_INBOUND_MESSAGE';
  end if;

  if v_display_name is not null and length(v_display_name) > 120 then
    v_display_name := left(v_display_name, 120);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_sender, 0)
  );

  select im.conversation_id, im.id
    into conversation_id, inbound_message_id
  from public.inbound_messages im
  where im.clinic_id = p_clinic_id
    and im.provider_message_id = p_provider_message_id;
  if found then
    inserted := false;
    return next;
    return;
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = p_sender
  for update;

  if not found then
    select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
      into v_patient_id, v_patient_count
    from public.patients p
    where p.clinic_id = p_clinic_id
      and p.phone = p_sender
      and not p.is_deleted
      and p.deleted_at is null;
    if v_patient_count <> 1 then
      v_patient_id := null;
    end if;

    insert into public.conversations (
      clinic_id, patient_id, channel, participant_address, display_name,
      patient_link_status, window_expires_at,
      status, status_updated_at, last_message_at
    ) values (
      p_clinic_id,
      v_patient_id,
      'whatsapp'::public.message_channel,
      p_sender,
      v_display_name,
      case when v_patient_id is null then 'unlinked' else 'automatic' end,
      case when p_historical then null else v_window_expires_at end,
      'open'::public.conversation_status,
      p_received_at,
      p_received_at
    )
    returning * into v_conversation;
  else
    if v_conversation.patient_link_status = 'automatic'
       and v_conversation.patient_id is null then
      select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
        into v_patient_id, v_patient_count
      from public.patients p
      where p.clinic_id = p_clinic_id
        and p.phone = p_sender
        and not p.is_deleted
        and p.deleted_at is null;
      if v_patient_count = 1 then
        update public.conversations
        set patient_id = v_patient_id
        where id = v_conversation.id
        returning * into v_conversation;
      end if;
    end if;
    if v_display_name is not null
       and (v_conversation.display_name is null or not p_historical) then
      update public.conversations
      set display_name = v_display_name
      where id = v_conversation.id
      returning * into v_conversation;
    end if;
  end if;

  insert into public.inbound_messages (
    clinic_id, channel, sender, patient_id, conversation_id,
    body, provider_message_id, received_at
  ) values (
    p_clinic_id,
    'whatsapp'::public.message_channel,
    p_sender,
    -- Null for an unlinked thread. This is the line that keeps WhatsApp
    -- communication history out of the medical record: a message is only ever
    -- stamped with the patient the *conversation* is linked to, and an
    -- ordinary WhatsApp chat is linked to nobody.
    v_conversation.patient_id,
    v_conversation.id,
    coalesce(nullif(p_body, ''), '[Empty message]'),
    p_provider_message_id,
    p_received_at
  )
  returning id into v_message_id;

  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at, p_received_at), p_received_at),
      window_expires_at = case
        when p_historical then window_expires_at
        else greatest(coalesce(window_expires_at, v_window_expires_at), v_window_expires_at)
      end,
      status = case
        when p_historical then status
        when status = 'open'::public.conversation_status
          or p_received_at >= status_updated_at
          then 'open'::public.conversation_status
        else status
      end,
      status_updated_at = case
        when not p_historical
          and status = 'closed'::public.conversation_status
          and p_received_at >= status_updated_at
          then p_received_at
        else status_updated_at
      end
  where id = v_conversation.id;

  inserted := true;
  conversation_id := v_conversation.id;
  inbound_message_id := v_message_id;
  return next;
exception
  when unique_violation then
    select im.conversation_id, im.id
      into conversation_id, inbound_message_id
    from public.inbound_messages im
    where im.clinic_id = p_clinic_id
      and im.provider_message_id = p_provider_message_id;
    if not found then
      raise;
    end if;
    inserted := false;
    return next;
end;
$$;

revoke all on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Retiring the staging model (§2)
--
-- Chats already staged are promoted to real conversations — that is the whole
-- point of the rule change, and leaving them behind would strand the one clinic
-- that already ran an import. Their message bodies are gone for good: they were
-- never written. A re-run of the history sync will carry what WhatsApp still
-- offers; nothing here pretends to recover more than that.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'whatsapp_history_pending_chats'
  ) then
    insert into public.conversations (
      clinic_id, patient_id, channel, participant_address, display_name,
      patient_link_status, window_expires_at, status, status_updated_at, last_message_at
    )
    select
      pending.clinic_id,
      null,
      'whatsapp'::public.message_channel,
      pending.participant_address,
      pending.display_name,
      'unlinked',
      null,
      'open'::public.conversation_status,
      coalesce(pending.last_message_at, pending.created_at),
      pending.last_message_at
    from public.whatsapp_history_pending_chats pending
    where pending.status = 'pending'
      and not exists (
        select 1 from public.conversations c
        where c.clinic_id = pending.clinic_id
          and c.channel = 'whatsapp'::public.message_channel
          and c.participant_address = pending.participant_address
      );
  end if;
end;
$$;

drop function if exists public.decide_whatsapp_history_chat(uuid, uuid, boolean, uuid);
drop table if exists public.whatsapp_history_pending_chats;

-- ---------------------------------------------------------------------------
-- 6. WhatsApp contacts the linked device knows about (§3)
--
-- Baileys delivers a contact list on the history sync and `contacts.upsert`
-- events afterwards. That list is the only "address book" a linked device
-- offers, and it is what makes "start a new conversation" something a staff
-- member can do by *picking a person* rather than by typing 13 digits.
--
-- It is address-book data, not clinical data: a row here says WhatsApp told the
-- linked account this number has this name. It never implies a patient, never
-- links one, and holds no message content. Staff of this clinic can read it;
-- only the worker (service role) writes it.
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- E.164 with the leading '+', the same normalized form conversations use, so
  -- a contact and a thread for the same person always join.
  participant_address text not null check (participant_address ~ '^\+[1-9][0-9]{5,19}$'),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_contacts_unique unique (clinic_id, participant_address)
);

create index if not exists whatsapp_contacts_clinic_name_idx
  on public.whatsapp_contacts (clinic_id, display_name);

alter table public.whatsapp_contacts enable row level security;
drop policy if exists "inbox_staff_read_whatsapp_contacts" on public.whatsapp_contacts;
create policy "inbox_staff_read_whatsapp_contacts"
on public.whatsapp_contacts for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

grant select on table public.whatsapp_contacts to authenticated;
grant all on table public.whatsapp_contacts to service_role;
revoke all on table public.whatsapp_contacts from anon;

create trigger trg_whatsapp_contacts_updated_at
  before update on public.whatsapp_contacts
  for each row execute function public.set_updated_at();

/**
 * Bulk contact upsert, one statement per callback batch.
 *
 * Rebuilt field by field from the jsonb rather than trusted: an address that is
 * not E.164 is dropped, a name is bounded, and a blank name never overwrites a
 * name already on file.
 */
create or replace function public.upsert_whatsapp_contacts(
  p_clinic_id uuid,
  p_contacts jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if jsonb_typeof(p_contacts) <> 'array' then
    raise exception 'INVALID_CONTACT_BATCH';
  end if;

  with candidate as (
    select
      nullif(btrim(item ->> 'participantAddress'), '') as address,
      left(nullif(btrim(item ->> 'displayName'), ''), 120) as display_name
    from jsonb_array_elements(p_contacts) as item
    limit 2000
  ),
  valid as (
    select address, display_name
    from candidate
    where address ~ '^\+[1-9][0-9]{5,19}$'
  ),
  -- One row per address: a batch may name the same contact twice, and
  -- ON CONFLICT cannot update the same row twice in one statement.
  deduped as (
    select distinct on (address) address, display_name
    from valid
    order by address, (display_name is null)
  ),
  upserted as (
    insert into public.whatsapp_contacts as existing (clinic_id, participant_address, display_name)
    select p_clinic_id, address, display_name from deduped
    on conflict (clinic_id, participant_address) do update
    set display_name = coalesce(excluded.display_name, existing.display_name),
        updated_at = pg_catalog.now()
    returning 1
  )
  select count(*)::integer into v_count from upserted;

  return v_count;
end;
$$;

revoke all on function public.upsert_whatsapp_contacts(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_contacts(uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Staff opening a conversation themselves (§3)
--
-- The inbox could only ever contain threads somebody else started. A clinic that
-- wants to message a number — a new enquiry, a supplier, a patient whose thread
-- has never existed — had no way to do it from ClinicFlow.
--
-- This opens the thread and nothing else:
--
--   * it takes a number, already normalized to E.164 by the caller, and never a
--     patient id — linking stays the separate, explicit staff action it is;
--   * it does **not** create a patient, and there is no branch here that could;
--   * it applies the same single-active-patient attribution the inbound path
--     applies, so messaging a number the clinic already has one patient for
--     lands in that patient's thread rather than beside it;
--   * it is idempotent: an existing thread is returned, reopened if staff had
--     closed it, because a staff member deliberately starting a conversation is
--     an unambiguous request for that thread to be open.
-- ---------------------------------------------------------------------------

create or replace function public.open_whatsapp_conversation(
  p_clinic_id uuid,
  p_participant text,
  p_display_name text default null,
  p_actor_id uuid default null
)
returns table (conversation_id uuid, created boolean, patient_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
  v_now timestamptz := pg_catalog.now();
begin
  if p_participant is null or p_participant !~ '^\+[1-9][0-9]{5,19}$' then
    raise exception 'INVALID_PARTICIPANT';
  end if;
  if p_actor_id is not null and not exists (
    select 1 from public.profiles pr
    where pr.id = p_actor_id and pr.clinic_id = p_clinic_id
  ) then
    raise exception 'ACTOR_NOT_IN_CLINIC';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_participant, 0)
  );

  select c.* into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = p_participant
  for update;

  if found then
    update public.conversations
    set status = 'open'::public.conversation_status,
        status_updated_at = case
          when status = 'closed'::public.conversation_status then v_now
          else status_updated_at
        end,
        display_name = coalesce(display_name, v_display_name),
        assigned_to = coalesce(assigned_to, p_actor_id)
    where id = v_conversation.id
    returning * into v_conversation;

    conversation_id := v_conversation.id;
    created := false;
    patient_id := v_conversation.patient_id;
    return next;
    return;
  end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_patient_id, v_patient_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and p.phone = p_participant
    and not p.is_deleted
    and p.deleted_at is null;
  if v_patient_count <> 1 then
    v_patient_id := null;
  end if;

  insert into public.conversations (
    clinic_id, patient_id, channel, participant_address, display_name,
    patient_link_status,
    -- No inbound message has arrived, so there is no service window. On a
    -- linked device that is irrelevant; on Meta/360dialog it is exactly right,
    -- and the send path will require an approved template as it always has.
    window_expires_at,
    status, status_updated_at, assigned_to
  ) values (
    p_clinic_id,
    v_patient_id,
    'whatsapp'::public.message_channel,
    p_participant,
    coalesce(
      v_display_name,
      (select wc.display_name from public.whatsapp_contacts wc
        where wc.clinic_id = p_clinic_id
          and wc.participant_address = p_participant)
    ),
    case when v_patient_id is null then 'unlinked' else 'automatic' end,
    null,
    'open'::public.conversation_status,
    v_now,
    p_actor_id
  )
  returning * into v_conversation;

  conversation_id := v_conversation.id;
  created := true;
  patient_id := v_conversation.patient_id;
  return next;
end;
$$;

revoke all on function public.open_whatsapp_conversation(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.open_whatsapp_conversation(uuid, text, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Outbound media (§5, §7)
--
-- Staff can send an image, a document, a file from their machine, an existing
-- ClinicFlow document, or a voice note. All five are *one* thing in this
-- schema: a row that names some bytes and the conversation they are going to.
--
-- Two decisions worth stating.
--
-- **Existing ClinicFlow documents are referenced, not copied.** A patient's
-- uploaded ID scan already lives in `patient-assets`; an issued PDF already
-- lives in `clinic-documents`. Sending one records the bucket and path it is
-- already at. Copying it would double the storage, split the retention story,
-- and create a second copy of a patient's file with no lifecycle attached — so
-- `bucket` is a small allow-list rather than a constant.
--
-- **A draft is a claim, not a URL.** The client never learns a storage path.
-- It uploads through a server action and gets back an id; the send takes that
-- id and re-derives everything from this row. So a client cannot ask for a file
-- it was not given, and cannot alter the type or size the server measured.
-- ---------------------------------------------------------------------------

-- The composite foreign key below needs a matching unique constraint. It is the
-- same tenant-pinning pattern every other cross-table reference in this schema
-- uses: a child row cannot name a parent in another clinic, because the key it
-- references carries the clinic id.
create unique index if not exists outbound_messages_id_clinic_unique_idx
  on public.outbound_messages (id, clinic_id);

create table if not exists public.outbound_message_media (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null,
  -- Set when the send succeeds. Null on a draft, and on a draft that was never
  -- sent — those are swept, not orphaned rows to reason about.
  outbound_message_id uuid,
  created_by uuid,
  -- Where the bytes came from. This is provenance, and it is what makes
  -- "a staff member deliberately sent this patient's document" auditable.
  source text not null check (
    source in ('upload', 'voice_note', 'patient_document', 'clinic_document')
  ),
  -- What WhatsApp will be asked to send it as.
  media_kind text not null check (media_kind in ('image', 'document', 'audio')),
  -- The type the *bytes* are, from a server-side sniff. Never the browser's word.
  mime_type text not null check (length(btrim(mime_type)) between 3 and 128),
  file_name text check (file_name is null or length(btrim(file_name)) between 1 and 255),
  byte_size integer not null check (byte_size > 0 and byte_size <= 104857600),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- Small allow-list: the only buckets a WhatsApp send may ever read from.
  bucket text not null check (bucket in ('whatsapp-outbound', 'patient-assets', 'clinic-documents')),
  storage_path text not null check (length(storage_path) between 1 and 512),
  caption text check (caption is null or length(caption) <= 1024),
  -- Which record this came from, when it came from one. Audit only; the send
  -- path re-authorizes from `bucket`/`storage_path` and never from this.
  source_record_id uuid,
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed')),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbound_message_media_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete cascade,
  constraint outbound_message_media_creator_clinic_fkey
    foreign key (created_by, clinic_id)
    references public.profiles(id, clinic_id)
    on delete set null (created_by),
  constraint outbound_message_media_outbound_clinic_fkey
    foreign key (outbound_message_id, clinic_id)
    references public.outbound_messages(id, clinic_id)
    on delete cascade,
  -- Uploads and voice notes are ours and live in our own bucket; a referenced
  -- document never does. Getting this backwards is how a "send this document"
  -- turns into a path traversal into somebody else's clinic.
  constraint outbound_message_media_bucket_source_check check (
    (source in ('upload', 'voice_note')) = (bucket = 'whatsapp-outbound')
  ),
  -- Our own bucket is clinic-partitioned by path, and the prefix is the tenant
  -- boundary the signing code checks. Enforce it here too, so a bad write can
  -- never produce a row the signer would accept.
  constraint outbound_message_media_own_path_scoped check (
    bucket <> 'whatsapp-outbound'
    or (storage_path like clinic_id::text || '/%' and storage_path not like '%..%')
  ),
  constraint outbound_message_media_voice_is_audio check (
    source <> 'voice_note' or media_kind = 'audio'
  ),
  constraint outbound_message_media_sent_has_message check (
    status <> 'sent' or outbound_message_id is not null
  )
);

create index if not exists outbound_message_media_message_idx
  on public.outbound_message_media (outbound_message_id)
  where outbound_message_id is not null;
create index if not exists outbound_message_media_conversation_idx
  on public.outbound_message_media (clinic_id, conversation_id, created_at desc);
-- Sweep target: drafts that were prepared and never sent.
create index if not exists outbound_message_media_stale_draft_idx
  on public.outbound_message_media (created_at)
  where status = 'draft';

alter table public.outbound_message_media enable row level security;
drop policy if exists "inbox_staff_read_outbound_media" on public.outbound_message_media;
create policy "inbox_staff_read_outbound_media"
on public.outbound_message_media for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);
-- No insert/update/delete policy at all. Every write goes through the reviewed
-- server actions on the clinic-scoped admin client, which is where the MIME
-- sniff, the size cap and the document authorization live.

grant select on table public.outbound_message_media to authenticated;
grant all on table public.outbound_message_media to service_role;
revoke all on table public.outbound_message_media from anon;

create trigger trg_outbound_message_media_updated_at
  before update on public.outbound_message_media
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. The outbound bucket
--
-- Private, and — like `whatsapp-inbound` — with *no* `authenticated` storage
-- policy whatsoever. Staff never read from it directly; the inbox renders a
-- server-minted signed URL for a path already proved to be their clinic's, and
-- the worker reads it with the service role.
--
-- The mime allow-list is the outer bound of what this stack will carry. The
-- server-side sniff is narrower and is the real gate; this is the backstop that
-- holds even if the sniff is bypassed by a future call site.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'whatsapp-outbound',
  'whatsapp-outbound',
  false,
  104857600,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/webm'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 10. Claiming a draft for a send, and finishing it (§7)
--
-- Idempotency and ordering are the reason this is an RPC and not two updates.
-- `claim` moves exactly one draft to 'sending' and returns everything the send
-- path needs; a second concurrent claim gets nothing, so one prepared file can
-- never be attached to two messages.
-- ---------------------------------------------------------------------------

create or replace function public.claim_outbound_media(
  p_clinic_id uuid,
  p_media_id uuid,
  p_conversation_id uuid
)
returns table (
  media_id uuid,
  source text,
  source_record_id uuid,
  media_kind text,
  mime_type text,
  file_name text,
  byte_size integer,
  bucket text,
  storage_path text,
  caption text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.outbound_message_media m
  set status = 'sending'
  where m.id = p_media_id
    and m.clinic_id = p_clinic_id
    and m.conversation_id = p_conversation_id
    and m.status = 'draft'
  returning m.id, m.source, m.source_record_id, m.media_kind, m.mime_type, m.file_name,
            m.byte_size, m.bucket, m.storage_path, m.caption;
end;
$$;

revoke all on function public.claim_outbound_media(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_outbound_media(uuid, uuid, uuid)
  to service_role;

create or replace function public.finalize_outbound_media(
  p_clinic_id uuid,
  p_media_id uuid,
  p_outbound_message_id uuid default null,
  p_failure_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.outbound_message_media m
  set status = case when p_outbound_message_id is null then 'failed' else 'sent' end,
      outbound_message_id = coalesce(p_outbound_message_id, m.outbound_message_id),
      failure_reason = left(p_failure_reason, 120)
  where m.id = p_media_id
    and m.clinic_id = p_clinic_id
    and m.status in ('draft', 'sending');
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.finalize_outbound_media(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_outbound_media(uuid, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 11. Finding a conversation once the inbox holds the whole account (§2, §8)
--
-- The summary RPC returned the 100 most recent threads and nothing else. That
-- was a complete list when the inbox only held traffic since the clinic joined;
-- with the account's history imported it is a window onto a much larger set,
-- and a thread that scrolled out of it became unreachable — the client-side
-- filter box could only filter what the server had already sent.
--
-- So the search moves to the server. `p_search` matches the participant number
-- and the WhatsApp display name; the patient-name half of the search stays on
-- the client, where the patient rows already are.
--
-- The signature changes, so the old one is dropped rather than replaced —
-- leaving both would make every existing two-argument call ambiguous.
-- ---------------------------------------------------------------------------

drop function if exists public.get_inbox_conversation_summaries(uuid, integer);

create or replace function public.get_inbox_conversation_summaries(
  p_requested_conversation_id uuid default null,
  p_limit integer default 100,
  p_search text default null
)
returns table (
  id uuid,
  channel public.message_channel,
  status public.conversation_status,
  patient_id uuid,
  participant_address text,
  assigned_to uuid,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  window_expires_at timestamptz,
  preview text,
  unread_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select
      least(greatest(coalesce(p_limit, 100), 1), 300) as row_limit,
      nullif(btrim(coalesce(p_search, '')), '') as term
  ), recent as (
    select c.id
    from public.conversations c, bounds b
    where c.channel = 'whatsapp'::public.message_channel
      and (
        b.term is null
        or c.participant_address ilike '%' || b.term || '%'
        or c.display_name ilike '%' || b.term || '%'
      )
    order by c.last_message_at desc nulls last, c.created_at desc
    limit (select row_limit from bounds)
  ), chosen as (
    select recent.id from recent
    union
    select c.id
    from public.conversations c
    where p_requested_conversation_id is not null
      and c.id = p_requested_conversation_id
      and c.channel = 'whatsapp'::public.message_channel
  )
  select
    c.id,
    c.channel,
    c.status,
    c.patient_id,
    c.participant_address,
    c.assigned_to,
    c.last_message_at,
    inbound_latest.received_at,
    c.window_expires_at,
    coalesce(latest.body, ''),
    coalesce(unread.count, 0)
  from chosen
  join public.conversations c on c.id = chosen.id
  left join lateral (
    select im.sender, im.received_at
    from public.inbound_messages im
    where im.conversation_id = c.id
    order by im.received_at desc, im.id desc
    limit 1
  ) inbound_latest on true
  left join lateral (
    select event.body
    from (
      select im.body, im.received_at as occurred_at, im.id
      from public.inbound_messages im
      where im.conversation_id = c.id
      union all
      -- P8 stores the full sent text on inbox threads; the redacted preview
      -- remains the fallback for rows written before that column existed.
      select coalesce(om.body, om.body_preview, ''), om.created_at, om.id
      from public.outbound_messages om
      where om.related_type = 'manual'::public.outbound_related_type
        and om.related_id = c.id
    ) event
    order by event.occurred_at desc, event.id desc
    limit 1
  ) latest on true
  left join lateral (
    select count(*)
    from public.inbound_messages im
    where im.conversation_id = c.id
      and im.received_at > coalesce((
        select max(om.created_at)
        from public.outbound_messages om
        where om.related_type = 'manual'::public.outbound_related_type
          and om.related_id = c.id
          and om.status in (
            'sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status
          )
      ), '-infinity'::timestamptz)
  ) unread on true
  order by c.last_message_at desc nulls last, c.created_at desc;
$$;

revoke all on function public.get_inbox_conversation_summaries(uuid, integer, text)
  from public, anon;
grant execute on function public.get_inbox_conversation_summaries(uuid, integer, text)
  to authenticated;

-- The imported account brings enough threads that the list query stops being a
-- trivial scan. One index for the ordering the RPC actually uses.
create index if not exists conversations_channel_recent_idx
  on public.conversations (channel, last_message_at desc nulls last, created_at desc);
