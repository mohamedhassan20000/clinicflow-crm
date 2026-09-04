-- Exact linked-device account isolation.
--
-- The Baileys PN JID, normalized to E.164, is the stable account key. LIDs are
-- aliases only. Existing NULL-scoped rows are deliberately NOT backfilled:
-- their owning account cannot be proved, so inventing one would be a data leak.

create table if not exists public.whatsapp_linked_accounts (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  authenticated_account_id text not null
    check (authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$'),
  authenticated_account_lid text
    check (authenticated_account_lid is null or authenticated_account_lid ~ '^[0-9]{3,30}@lid$'),
  inbound_active_from timestamptz not null,
  first_linked_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (clinic_id, authenticated_account_id)
);

alter table public.whatsapp_linked_accounts enable row level security;
grant all on table public.whatsapp_linked_accounts to service_role;
revoke all on table public.whatsapp_linked_accounts from public, anon, authenticated;

alter table public.whatsapp_linked_device_sessions
  add column if not exists authenticated_account_id text
    check (authenticated_account_id is null or authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$'),
  add column if not exists authenticated_account_lid text
    check (authenticated_account_lid is null or authenticated_account_lid ~ '^[0-9]{3,30}@lid$');

-- Session rows remain service-role-only. This helper exposes only the current
-- clinic's account key so authenticated RLS policies can enforce the boundary
-- without granting staff direct access to worker/session state.
create or replace function public.current_whatsapp_linked_account_id()
returns text language sql stable security definer set search_path = '' as $$
  select s.authenticated_account_id
  from public.whatsapp_linked_device_sessions s
  where s.clinic_id = public.auth_clinic_id()
$$;
revoke all on function public.current_whatsapp_linked_account_id()
  from public, anon;
grant execute on function public.current_whatsapp_linked_account_id()
  to authenticated, service_role;

alter table public.conversations
  add column if not exists whatsapp_account_id text
    check (whatsapp_account_id is null or whatsapp_account_id ~ '^\+[1-9][0-9]{5,19}$');

drop index if exists public.conversations_participant_unique_idx;
create unique index if not exists conversations_participant_legacy_unique_idx
  on public.conversations (clinic_id, channel, participant_address)
  where participant_address is not null and whatsapp_account_id is null;
create unique index if not exists conversations_participant_account_unique_idx
  on public.conversations (clinic_id, channel, whatsapp_account_id, participant_address)
  where participant_address is not null and whatsapp_account_id is not null;
create index if not exists conversations_whatsapp_account_idx
  on public.conversations (clinic_id, whatsapp_account_id, last_message_at desc);

alter table public.whatsapp_contacts
  add column if not exists authenticated_account_id text
    check (authenticated_account_id is null or authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$');
alter table public.whatsapp_contacts drop constraint if exists whatsapp_contacts_unique;
alter table public.whatsapp_contacts drop constraint if exists whatsapp_contacts_account_unique;
alter table public.whatsapp_contacts
  add constraint whatsapp_contacts_account_unique
  unique nulls not distinct (clinic_id, authenticated_account_id, participant_address);
drop index if exists public.whatsapp_contacts_clinic_name_idx;
create index whatsapp_contacts_clinic_name_idx
  on public.whatsapp_contacts (clinic_id, authenticated_account_id, display_name);

alter table public.whatsapp_lid_mappings
  add column if not exists authenticated_account_id text
    check (authenticated_account_id is null or authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$');
alter table public.whatsapp_lid_mappings
  drop constraint if exists whatsapp_lid_mappings_identity_unique;
alter table public.whatsapp_lid_mappings
  drop constraint if exists whatsapp_lid_mappings_account_identity_unique;
alter table public.whatsapp_lid_mappings
  add constraint whatsapp_lid_mappings_account_identity_unique
  unique nulls not distinct (clinic_id, authenticated_account_id, lid_jid);

alter table public.whatsapp_pending_history_chats
  add column if not exists authenticated_account_id text
    check (authenticated_account_id is null or authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$');
alter table public.whatsapp_pending_history_chats
  drop constraint if exists whatsapp_pending_history_chats_unique;
alter table public.whatsapp_pending_history_chats
  drop constraint if exists whatsapp_pending_history_chats_account_unique;
alter table public.whatsapp_pending_history_chats
  add constraint whatsapp_pending_history_chats_account_unique
  unique nulls not distinct (clinic_id, authenticated_account_id, lid_jid);

alter table public.whatsapp_pending_history_messages
  add column if not exists authenticated_account_id text
    check (authenticated_account_id is null or authenticated_account_id ~ '^\+[1-9][0-9]{5,19}$');
alter table public.whatsapp_pending_history_messages
  drop constraint if exists whatsapp_pending_history_messages_unique;
alter table public.whatsapp_pending_history_messages
  drop constraint if exists whatsapp_pending_history_messages_account_unique;
alter table public.whatsapp_pending_history_messages
  add constraint whatsapp_pending_history_messages_account_unique
  unique nulls not distinct (clinic_id, authenticated_account_id, provider_message_id);

-- Old-account batches are retained for audit/recovery, but can never be claimed.
alter table public.whatsapp_history_delivery_batches
  drop constraint if exists whatsapp_history_delivery_batches_status_check;
alter table public.whatsapp_history_delivery_batches
  add constraint whatsapp_history_delivery_batches_status_check
  check (status in ('pending', 'delivered', 'failed', 'superseded'));

-- Authenticated clients only see the directory of the currently authenticated
-- linked account. Service-role worker access remains unaffected.
drop policy if exists "inbox_staff_read_whatsapp_contacts" on public.whatsapp_contacts;
create policy "inbox_staff_read_whatsapp_contacts"
on public.whatsapp_contacts for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (array['admin'::public.user_role, 'receptionist'::public.user_role])
  and authenticated_account_id = public.current_whatsapp_linked_account_id()
);

-- These restrictive policies close direct/deep-link reads as well as the list
-- RPC. NULL legacy rows are intentionally hidden while linked-device is active.
drop policy if exists "whatsapp_account_isolation_conversations" on public.conversations;
create policy "whatsapp_account_isolation_conversations"
on public.conversations as restrictive for select to authenticated
using (
  channel <> 'whatsapp'::public.message_channel
  or case when exists (
    select 1 from public.clinic_channels cc
    where cc.clinic_id = public.auth_clinic_id()
      and cc.channel = 'whatsapp'::public.message_channel
      and cc.provider = 'linked_device'::public.messaging_provider
      and cc.status = 'active'::public.clinic_channel_status
  ) then whatsapp_account_id = public.current_whatsapp_linked_account_id()
  else whatsapp_account_id is null end
);

drop policy if exists "whatsapp_account_isolation_inbound_messages" on public.inbound_messages;
create policy "whatsapp_account_isolation_inbound_messages"
on public.inbound_messages as restrictive for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.id = inbound_messages.conversation_id
    and c.clinic_id = inbound_messages.clinic_id
    and (
      c.channel <> 'whatsapp'::public.message_channel
      or case when exists (
        select 1 from public.clinic_channels cc
        where cc.clinic_id = public.auth_clinic_id()
          and cc.channel = 'whatsapp'::public.message_channel
          and cc.provider = 'linked_device'::public.messaging_provider
          and cc.status = 'active'::public.clinic_channel_status
      ) then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
      else c.whatsapp_account_id is null end
    )
));

drop policy if exists "whatsapp_account_isolation_outbound_messages" on public.outbound_messages;
create policy "whatsapp_account_isolation_outbound_messages"
on public.outbound_messages as restrictive for select to authenticated
using (
  related_type <> 'manual'::public.outbound_related_type
  or exists (
    select 1 from public.conversations c
    where c.id = outbound_messages.related_id and c.clinic_id = outbound_messages.clinic_id
      and (
        c.channel <> 'whatsapp'::public.message_channel
        or case when exists (
          select 1 from public.clinic_channels cc
          where cc.clinic_id = public.auth_clinic_id()
            and cc.channel = 'whatsapp'::public.message_channel
            and cc.provider = 'linked_device'::public.messaging_provider
            and cc.status = 'active'::public.clinic_channel_status
        ) then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
        else c.whatsapp_account_id is null end
      )
  )
);

drop policy if exists "whatsapp_account_isolation_inbound_attachments" on public.inbound_message_attachments;
create policy "whatsapp_account_isolation_inbound_attachments"
on public.inbound_message_attachments as restrictive for select to authenticated
using (exists (
  select 1 from public.inbound_messages im
  join public.conversations c on c.id = im.conversation_id and c.clinic_id = im.clinic_id
  where im.id = inbound_message_attachments.inbound_message_id
    and im.clinic_id = inbound_message_attachments.clinic_id
    and (c.channel <> 'whatsapp'::public.message_channel or case when exists (
      select 1 from public.clinic_channels cc
      where cc.clinic_id = public.auth_clinic_id()
        and cc.channel = 'whatsapp'::public.message_channel
        and cc.provider = 'linked_device'::public.messaging_provider
        and cc.status = 'active'::public.clinic_channel_status
    ) then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
    else c.whatsapp_account_id is null end)
));

drop policy if exists "whatsapp_account_isolation_outbound_media" on public.outbound_message_media;
create policy "whatsapp_account_isolation_outbound_media"
on public.outbound_message_media as restrictive for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.id = outbound_message_media.conversation_id
    and c.clinic_id = outbound_message_media.clinic_id
    and (c.channel <> 'whatsapp'::public.message_channel or case when exists (
      select 1 from public.clinic_channels cc
      where cc.clinic_id = public.auth_clinic_id()
        and cc.channel = 'whatsapp'::public.message_channel
        and cc.provider = 'linked_device'::public.messaging_provider
        and cc.status = 'active'::public.clinic_channel_status
    ) then c.whatsapp_account_id = public.current_whatsapp_linked_account_id()
    else c.whatsapp_account_id is null end)
));

create or replace function public.bind_whatsapp_linked_account(
  p_clinic_id uuid,
  p_authenticated_account_id text,
  p_authenticated_account_lid text default null,
  p_proposed_boundary timestamptz default now()
)
returns table (inbound_active_from timestamptz, account_changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.whatsapp_linked_device_sessions%rowtype;
  v_previous text;
  v_boundary timestamptz;
  v_changed boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or (p_authenticated_account_lid is not null and p_authenticated_account_lid !~ '^[0-9]{3,30}@lid$') then
    raise exception 'INVALID_LINKED_ACCOUNT';
  end if;

  select s.* into v_session from public.whatsapp_linked_device_sessions s
  where s.clinic_id = p_clinic_id for update;
  if not found then raise exception 'LINKED_DEVICE_SESSION_NOT_FOUND'; end if;

  -- phone_number is a live Baileys-derived value from versions before this
  -- migration; it is safe for change detection, but is never used to backfill.
  v_previous := coalesce(v_session.authenticated_account_id, v_session.phone_number);
  v_changed := v_previous is not null and v_previous <> p_authenticated_account_id;

  insert into public.whatsapp_linked_accounts (
    clinic_id, authenticated_account_id, authenticated_account_lid,
    inbound_active_from, first_linked_at, last_seen_at
  ) values (
    p_clinic_id, p_authenticated_account_id, p_authenticated_account_lid,
    case
      when v_previous = p_authenticated_account_id
        then coalesce(v_session.inbound_active_from, p_proposed_boundary, pg_catalog.now())
      else coalesce(p_proposed_boundary, pg_catalog.now())
    end,
    pg_catalog.now(), pg_catalog.now()
  ) on conflict (clinic_id, authenticated_account_id) do update
    set authenticated_account_lid = coalesce(excluded.authenticated_account_lid,
                                               whatsapp_linked_accounts.authenticated_account_lid),
        last_seen_at = pg_catalog.now()
  returning whatsapp_linked_accounts.inbound_active_from into v_boundary;

  update public.whatsapp_linked_device_sessions
  set authenticated_account_id = p_authenticated_account_id,
      authenticated_account_lid = p_authenticated_account_lid,
      inbound_active_from = v_boundary,
      history_status = case when v_changed then 'idle' else history_status end,
      history_started_at = case when v_changed then null else history_started_at end,
      history_completed_at = case when v_changed then null else history_completed_at end,
      history_chats_imported = case when v_changed then 0 else history_chats_imported end,
      history_messages_imported = case when v_changed then 0 else history_messages_imported end,
      history_final_batch_seen = case when v_changed then false else history_final_batch_seen end,
      history_last_error = case when v_changed then null else history_last_error end,
      history_chats_received = case when v_changed then 0 else history_chats_received end,
      history_messages_received = case when v_changed then 0 else history_messages_received end,
      history_messages_deduplicated = case when v_changed then 0 else history_messages_deduplicated end,
      history_messages_pending = case when v_changed then 0 else history_messages_pending end,
      history_messages_unsupported = case when v_changed then 0 else history_messages_unsupported end
  where clinic_id = p_clinic_id;

  inbound_active_from := v_boundary;
  account_changed := v_changed;
  return next;
end;
$$;
revoke all on function public.bind_whatsapp_linked_account(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.bind_whatsapp_linked_account(uuid, text, text, timestamptz)
  to service_role;

create or replace function public.supersede_whatsapp_history_batches(
  p_clinic_id uuid, p_active_session_phone text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update public.whatsapp_history_delivery_batches
  set status = 'superseded', claimed_by = null, claimed_at = null,
      last_error = 'authenticated account changed', updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and status = 'pending'
    and session_phone <> p_active_session_phone;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.supersede_whatsapp_history_batches(uuid, text)
  from public, anon, authenticated;
grant execute on function public.supersede_whatsapp_history_batches(uuid, text) to service_role;

create or replace function public.upsert_linked_device_contacts(
  p_clinic_id uuid, p_authenticated_account_id text, p_contacts jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or jsonb_typeof(p_contacts) <> 'array' then raise exception 'INVALID_CONTACT_BATCH'; end if;
  if not exists (select 1 from public.whatsapp_linked_accounts a
    where a.clinic_id = p_clinic_id and a.authenticated_account_id = p_authenticated_account_id)
  then raise exception 'LINKED_ACCOUNT_NOT_BOUND'; end if;
  with candidate as (
    select nullif(btrim(item->>'participantAddress'), '') address,
           left(nullif(btrim(item->>'displayName'), ''), 120) display_name
    from jsonb_array_elements(p_contacts) item limit 2000
  ), deduped as (
    select distinct on (address) address, display_name from candidate
    where address ~ '^\+[1-9][0-9]{5,19}$'
    order by address, (display_name is null)
  ), written as (
    insert into public.whatsapp_contacts as existing
      (clinic_id, authenticated_account_id, participant_address, display_name)
    select p_clinic_id, p_authenticated_account_id, address, display_name from deduped
    on conflict on constraint whatsapp_contacts_account_unique do update
      set display_name = coalesce(excluded.display_name, existing.display_name),
          updated_at = pg_catalog.now()
    returning 1
  ) select count(*)::integer into v_count from written;
  return v_count;
end;
$$;
revoke all on function public.upsert_linked_device_contacts(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_linked_device_contacts(uuid, text, jsonb) to service_role;

create or replace function public.upsert_linked_device_lid_mappings(
  p_clinic_id uuid, p_authenticated_account_id text, p_mappings jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or jsonb_typeof(p_mappings) <> 'array' then raise exception 'INVALID_LID_MAPPINGS'; end if;
  if exists (
    with supplied as (
      select item->>'lid' lid, item->>'participant' participant
      from jsonb_array_elements(p_mappings) item
      where item->>'lid' ~ '^[0-9]{3,30}@lid$'
        and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    )
    select 1 from supplied group by lid having count(distinct participant) > 1
  ) then raise exception 'LID_MAPPING_CONFLICT'; end if;
  if exists (
    with supplied as (select item->>'lid' lid, item->>'participant' participant
      from jsonb_array_elements(p_mappings) item)
    select 1 from supplied s join public.whatsapp_lid_mappings m
      on m.clinic_id = p_clinic_id and m.authenticated_account_id = p_authenticated_account_id
       and m.lid_jid = s.lid where m.participant_address <> s.participant
  ) then raise exception 'LID_MAPPING_CONFLICT'; end if;
  with supplied as (
    select distinct on (item->>'lid') item->>'lid' lid, item->>'participant' participant
    from jsonb_array_elements(p_mappings) item
    where item->>'lid' ~ '^[0-9]{3,30}@lid$'
      and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    order by item->>'lid', item->>'participant'
  ), written as (
    insert into public.whatsapp_lid_mappings as existing
      (clinic_id, authenticated_account_id, lid_jid, participant_address)
    select p_clinic_id, p_authenticated_account_id, lid, participant from supplied
    on conflict on constraint whatsapp_lid_mappings_account_identity_unique do update
      set last_asserted_at = pg_catalog.now()
      where existing.participant_address = excluded.participant_address
    returning 1
  ) select count(*)::integer into v_count from written;
  return v_count;
end;
$$;
revoke all on function public.upsert_linked_device_lid_mappings(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_linked_device_lid_mappings(uuid, text, jsonb) to service_role;

-- Keep the pre-account-scoping worker RPCs callable during a rolling deploy.
-- Once an authenticated account is known they write into that account's scope;
-- before the first authoritative binding they retain the old NULL scope rather
-- than inventing an account owner for legacy data.
create or replace function public.upsert_whatsapp_contacts(
  p_clinic_id uuid, p_contacts jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_account_id text;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_contacts) <> 'array' then raise exception 'INVALID_CONTACT_BATCH'; end if;
  select s.authenticated_account_id into v_account_id
  from public.whatsapp_linked_device_sessions s where s.clinic_id = p_clinic_id;
  if v_account_id is not null then
    return public.upsert_linked_device_contacts(p_clinic_id, v_account_id, p_contacts);
  end if;
  with candidate as (
    select nullif(btrim(item->>'participantAddress'), '') address,
           left(nullif(btrim(item->>'displayName'), ''), 120) display_name
    from jsonb_array_elements(p_contacts) item limit 2000
  ), deduped as (
    select distinct on (address) address, display_name from candidate
    where address ~ '^\+[1-9][0-9]{5,19}$'
    order by address, (display_name is null)
  ), written as (
    insert into public.whatsapp_contacts as existing
      (clinic_id, authenticated_account_id, participant_address, display_name)
    select p_clinic_id, null, address, display_name from deduped
    on conflict on constraint whatsapp_contacts_account_unique do update
      set display_name = coalesce(excluded.display_name, existing.display_name),
          updated_at = pg_catalog.now()
    returning 1
  ) select count(*)::integer into v_count from written;
  return v_count;
end;
$$;
revoke all on function public.upsert_whatsapp_contacts(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_contacts(uuid, jsonb) to service_role;

create or replace function public.upsert_whatsapp_lid_mappings(
  p_clinic_id uuid, p_mappings jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_account_id text;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_mappings) <> 'array' then raise exception 'INVALID_LID_MAPPINGS'; end if;
  select s.authenticated_account_id into v_account_id
  from public.whatsapp_linked_device_sessions s where s.clinic_id = p_clinic_id;
  if v_account_id is not null then
    return public.upsert_linked_device_lid_mappings(p_clinic_id, v_account_id, p_mappings);
  end if;
  if exists (
    with supplied as (
      select item->>'lid' lid, item->>'participant' participant
      from jsonb_array_elements(p_mappings) item
      where item->>'lid' ~ '^[0-9]{3,30}@lid$'
        and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    )
    select 1 from supplied group by lid having count(distinct participant) > 1
  ) then raise exception 'LID_MAPPING_CONFLICT'; end if;
  if exists (
    with supplied as (
      select item->>'lid' lid, item->>'participant' participant
      from jsonb_array_elements(p_mappings) item
    )
    select 1 from supplied s join public.whatsapp_lid_mappings m
      on m.clinic_id = p_clinic_id and m.authenticated_account_id is null
       and m.lid_jid = s.lid where m.participant_address <> s.participant
  ) then raise exception 'LID_MAPPING_CONFLICT'; end if;
  with supplied as (
    select distinct on (item->>'lid') item->>'lid' lid, item->>'participant' participant
    from jsonb_array_elements(p_mappings) item
    where item->>'lid' ~ '^[0-9]{3,30}@lid$'
      and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    order by item->>'lid', item->>'participant'
  ), written as (
    insert into public.whatsapp_lid_mappings as existing
      (clinic_id, authenticated_account_id, lid_jid, participant_address)
    select p_clinic_id, null, lid, participant from supplied
    on conflict on constraint whatsapp_lid_mappings_account_identity_unique do update
      set last_asserted_at = pg_catalog.now()
      where existing.participant_address = excluded.participant_address
    returning 1
  ) select count(*)::integer into v_count from written;
  return v_count;
end;
$$;
revoke all on function public.upsert_whatsapp_lid_mappings(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_lid_mappings(uuid, jsonb) to service_role;

create or replace function public.upsert_linked_device_history_chat(
  p_clinic_id uuid,
  p_authenticated_account_id text,
  p_participant text,
  p_display_name text default null,
  p_last_message_at timestamptz default null
)
returns table (conversation_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or p_participant !~ '^\+[1-9][0-9]{5,19}$' then raise exception 'INVALID_HISTORY_CHAT'; end if;
  if not exists (select 1 from public.whatsapp_linked_accounts a
    where a.clinic_id = p_clinic_id and a.authenticated_account_id = p_authenticated_account_id)
  then raise exception 'LINKED_ACCOUNT_NOT_BOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':whatsapp:' || p_authenticated_account_id || ':' || p_participant, 0));
  select c.* into v_conversation from public.conversations c
  where c.clinic_id = p_clinic_id and c.channel = 'whatsapp'::public.message_channel
    and c.whatsapp_account_id = p_authenticated_account_id
    and c.participant_address = p_participant for update;
  if found then
    if v_display_name is not null and v_conversation.display_name is null then
      update public.conversations set display_name = v_display_name
      where id = v_conversation.id returning * into v_conversation;
    end if;
    conversation_id := v_conversation.id; created := false; return next; return;
  end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_patient_id, v_patient_count from public.patients p
  where p.clinic_id = p_clinic_id and p.phone = p_participant
    and not p.is_deleted and p.deleted_at is null;
  if v_patient_count <> 1 then v_patient_id := null; end if;
  insert into public.conversations (
    clinic_id, patient_id, channel, participant_address, whatsapp_account_id,
    display_name, patient_link_status, window_expires_at, status,
    status_updated_at, last_message_at
  ) values (
    p_clinic_id, v_patient_id, 'whatsapp'::public.message_channel, p_participant,
    p_authenticated_account_id, v_display_name,
    case when v_patient_id is null then 'unlinked' else 'automatic' end,
    null, 'open'::public.conversation_status,
    coalesce(p_last_message_at, pg_catalog.now()), p_last_message_at
  ) returning * into v_conversation;
  conversation_id := v_conversation.id; created := true; return next;
end;
$$;
revoke all on function public.upsert_linked_device_history_chat(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_linked_device_history_chat(uuid, text, text, text, timestamptz)
  to service_role;

create or replace function public.persist_linked_device_inbound(
  p_clinic_id uuid,
  p_authenticated_account_id text,
  p_sender text,
  p_body text,
  p_provider_message_id text,
  p_received_at timestamptz,
  p_display_name text default null,
  p_historical boolean default false
)
returns table (inserted boolean, conversation_id uuid, inbound_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_window_expires_at timestamptz := p_received_at + interval '24 hours';
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
  v_message_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or p_sender !~ '^\+[1-9][0-9]{5,19}$'
     or p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'INVALID_INBOUND_MESSAGE';
  end if;
  if not exists (select 1 from public.whatsapp_linked_accounts a
    where a.clinic_id = p_clinic_id and a.authenticated_account_id = p_authenticated_account_id)
  then raise exception 'LINKED_ACCOUNT_NOT_BOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':whatsapp:' || p_authenticated_account_id || ':' || p_sender, 0));
  select im.conversation_id, im.id into conversation_id, inbound_message_id
  from public.inbound_messages im where im.clinic_id = p_clinic_id
    and im.provider_message_id = p_provider_message_id;
  if found then inserted := false; return next; return; end if;

  select c.* into v_conversation from public.conversations c
  where c.clinic_id = p_clinic_id and c.channel = 'whatsapp'::public.message_channel
    and c.whatsapp_account_id = p_authenticated_account_id
    and c.participant_address = p_sender for update;
  if not found then
    select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
      into v_patient_id, v_patient_count from public.patients p
    where p.clinic_id = p_clinic_id and p.phone = p_sender
      and not p.is_deleted and p.deleted_at is null;
    if v_patient_count <> 1 then v_patient_id := null; end if;
    insert into public.conversations (
      clinic_id, patient_id, channel, participant_address, whatsapp_account_id,
      display_name, patient_link_status, window_expires_at, status,
      status_updated_at, last_message_at
    ) values (
      p_clinic_id, v_patient_id, 'whatsapp'::public.message_channel, p_sender,
      p_authenticated_account_id, v_display_name,
      case when v_patient_id is null then 'unlinked' else 'automatic' end,
      case when p_historical then null else v_window_expires_at end,
      'open'::public.conversation_status, p_received_at, p_received_at
    ) returning * into v_conversation;
  else
    if v_conversation.patient_link_status = 'automatic' and v_conversation.patient_id is null then
      select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
        into v_patient_id, v_patient_count from public.patients p
      where p.clinic_id = p_clinic_id and p.phone = p_sender
        and not p.is_deleted and p.deleted_at is null;
      if v_patient_count = 1 then
        update public.conversations set patient_id = v_patient_id
        where id = v_conversation.id returning * into v_conversation;
      end if;
    end if;
    if v_display_name is not null and (v_conversation.display_name is null or not p_historical) then
      update public.conversations set display_name = v_display_name
      where id = v_conversation.id returning * into v_conversation;
    end if;
  end if;

  insert into public.inbound_messages (
    clinic_id, channel, sender, patient_id, conversation_id, body,
    provider_message_id, received_at
  ) values (
    p_clinic_id, 'whatsapp'::public.message_channel, p_sender,
    v_conversation.patient_id, v_conversation.id,
    coalesce(nullif(p_body, ''), '[Empty message]'), p_provider_message_id, p_received_at
  ) returning id into v_message_id;
  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at, p_received_at), p_received_at),
      window_expires_at = case when p_historical then window_expires_at
        else greatest(coalesce(window_expires_at, v_window_expires_at), v_window_expires_at) end,
      status = case when p_historical then status
        when status = 'open'::public.conversation_status or p_received_at >= status_updated_at
          then 'open'::public.conversation_status else status end,
      status_updated_at = case when not p_historical and status = 'closed'::public.conversation_status
        and p_received_at >= status_updated_at then p_received_at else status_updated_at end
  where id = v_conversation.id;
  inserted := true; conversation_id := v_conversation.id;
  inbound_message_id := v_message_id; return next;
exception when unique_violation then
  select im.conversation_id, im.id into conversation_id, inbound_message_id
  from public.inbound_messages im where im.clinic_id = p_clinic_id
    and im.provider_message_id = p_provider_message_id;
  if not found then raise; end if;
  inserted := false; return next;
end;
$$;
revoke all on function public.persist_linked_device_inbound(uuid, text, text, text, text, timestamptz, text, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_linked_device_inbound(uuid, text, text, text, text, timestamptz, text, boolean)
  to service_role;

create or replace function public.open_linked_device_conversation(
  p_clinic_id uuid,
  p_authenticated_account_id text,
  p_participant text,
  p_display_name text default null,
  p_actor_id uuid default null
)
returns table (conversation_id uuid, created boolean, patient_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
  v_now timestamptz := pg_catalog.now();
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_authenticated_account_id !~ '^\+[1-9][0-9]{5,19}$'
     or p_participant !~ '^\+[1-9][0-9]{5,19}$' then raise exception 'INVALID_PARTICIPANT'; end if;
  if p_actor_id is not null and not exists (select 1 from public.profiles pr
    where pr.id = p_actor_id and pr.clinic_id = p_clinic_id) then raise exception 'ACTOR_NOT_IN_CLINIC'; end if;
  if not exists (select 1 from public.whatsapp_linked_accounts a
    where a.clinic_id = p_clinic_id and a.authenticated_account_id = p_authenticated_account_id)
  then raise exception 'LINKED_ACCOUNT_NOT_BOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':whatsapp:' || p_authenticated_account_id || ':' || p_participant, 0));
  select c.* into v_conversation from public.conversations c
  where c.clinic_id = p_clinic_id and c.channel = 'whatsapp'::public.message_channel
    and c.whatsapp_account_id = p_authenticated_account_id
    and c.participant_address = p_participant for update;
  if found then
    update public.conversations set status = 'open'::public.conversation_status,
      status_updated_at = case when status = 'closed'::public.conversation_status then v_now else status_updated_at end,
      display_name = coalesce(display_name, v_display_name), assigned_to = coalesce(assigned_to, p_actor_id)
    where id = v_conversation.id returning * into v_conversation;
    conversation_id := v_conversation.id; created := false;
    patient_id := v_conversation.patient_id; return next; return;
  end if;
  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_patient_id, v_patient_count from public.patients p
  where p.clinic_id = p_clinic_id and p.phone = p_participant
    and not p.is_deleted and p.deleted_at is null;
  if v_patient_count <> 1 then v_patient_id := null; end if;
  insert into public.conversations (
    clinic_id, patient_id, channel, participant_address, whatsapp_account_id,
    display_name, patient_link_status, window_expires_at, status,
    status_updated_at, assigned_to
  ) values (
    p_clinic_id, v_patient_id, 'whatsapp'::public.message_channel, p_participant,
    p_authenticated_account_id,
    coalesce(v_display_name, (select wc.display_name from public.whatsapp_contacts wc
      where wc.clinic_id = p_clinic_id
        and wc.authenticated_account_id = p_authenticated_account_id
        and wc.participant_address = p_participant)),
    case when v_patient_id is null then 'unlinked' else 'automatic' end,
    null, 'open'::public.conversation_status, v_now, p_actor_id
  ) returning * into v_conversation;
  conversation_id := v_conversation.id; created := true;
  patient_id := v_conversation.patient_id; return next;
end;
$$;
revoke all on function public.open_linked_device_conversation(uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.open_linked_device_conversation(uuid, text, text, text, uuid)
  to service_role;

create or replace function public.get_inbox_conversation_summaries(
  p_requested_conversation_id uuid default null,
  p_limit integer default 100,
  p_search text default null
)
returns table (
  id uuid, channel public.message_channel, status public.conversation_status,
  patient_id uuid, participant_address text, assigned_to uuid,
  last_message_at timestamptz, last_inbound_at timestamptz,
  window_expires_at timestamptz, preview text, unread_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_clinic uuid;
  v_role public.user_role;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_linked boolean := false;
  v_account text;
begin
  v_clinic := public.auth_clinic_id();
  v_role := public.auth_role();
  if v_clinic is null or v_role is null
     or v_role not in ('admin'::public.user_role, 'receptionist'::public.user_role) then return; end if;
  select exists (select 1 from public.clinic_channels cc
      where cc.clinic_id = v_clinic and cc.channel = 'whatsapp'::public.message_channel
        and cc.provider = 'linked_device'::public.messaging_provider
        and cc.status = 'active'::public.clinic_channel_status),
    (select s.authenticated_account_id from public.whatsapp_linked_device_sessions s
      where s.clinic_id = v_clinic)
    into v_linked, v_account;
  -- A linked channel without a proved Baileys identity is fail-closed.
  if v_linked and v_account is null then return; end if;

  return query
  with recent as (
    select c.id from public.conversations c
    where c.clinic_id = v_clinic and c.channel = 'whatsapp'::public.message_channel
      and (case when v_linked then c.whatsapp_account_id = v_account
                else c.whatsapp_account_id is null end)
      and (v_term is null or c.participant_address ilike '%' || v_term || '%'
           or c.display_name ilike '%' || v_term || '%')
    order by c.last_message_at desc nulls last, c.created_at desc limit v_limit
  ), chosen as (
    select recent.id from recent
    union
    select c.id from public.conversations c
    where p_requested_conversation_id is not null and c.id = p_requested_conversation_id
      and c.clinic_id = v_clinic and c.channel = 'whatsapp'::public.message_channel
      and (case when v_linked then c.whatsapp_account_id = v_account
                else c.whatsapp_account_id is null end)
  )
  select c.id, c.channel, c.status, c.patient_id, c.participant_address,
    c.assigned_to, c.last_message_at, inbound_latest.received_at,
    c.window_expires_at, coalesce(latest.body, ''), coalesce(unread.count, 0)
  from chosen join public.conversations c on c.id = chosen.id and c.clinic_id = v_clinic
  left join lateral (
    select im.received_at from public.inbound_messages im
    where im.conversation_id = c.id and im.clinic_id = v_clinic
    order by im.received_at desc, im.id desc limit 1
  ) inbound_latest on true
  left join lateral (
    select event.body from (
      select im.body, im.received_at occurred_at, im.id from public.inbound_messages im
      where im.conversation_id = c.id and im.clinic_id = v_clinic
      union all
      select coalesce(om.body, om.body_preview, ''), om.created_at, om.id
      from public.outbound_messages om
      where om.related_type = 'manual'::public.outbound_related_type
        and om.related_id = c.id and om.clinic_id = v_clinic
    ) event order by event.occurred_at desc, event.id desc limit 1
  ) latest on true
  left join lateral (
    select count(*) from public.inbound_messages im
    where im.conversation_id = c.id and im.clinic_id = v_clinic
      and im.received_at > coalesce((select max(om.created_at)
        from public.outbound_messages om
        where om.related_type = 'manual'::public.outbound_related_type
          and om.related_id = c.id and om.clinic_id = v_clinic
          and om.status in ('sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status)), '-infinity'::timestamptz)
  ) unread on true
  order by c.last_message_at desc nulls last, c.created_at desc;
end;
$$;
revoke all on function public.get_inbox_conversation_summaries(uuid, integer, text)
  from public, anon;
grant execute on function public.get_inbox_conversation_summaries(uuid, integer, text)
  to authenticated;

comment on function public.get_inbox_conversation_summaries(uuid, integer, text) is
  'Inbox list restricted to the current proved linked-device account; ambiguous legacy rows are never attributed.';

-- Delivery bookkeeping is also account-scoped. An in-flight acknowledgement
-- from A after B becomes active is accepted but superseded, never counted as B.
create or replace function public.record_whatsapp_history_delivery(
  p_clinic_id uuid, p_batch_id uuid default null, p_delivered boolean default null,
  p_chats integer default 0, p_messages integer default 0, p_error text default null,
  p_final_batch_seen boolean default false, p_max_attempts integer default 8
)
returns table (history_status text, pending_batches integer, failed_batches integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.whatsapp_linked_device_sessions%rowtype;
  v_batch_phone text;
  v_pending integer := 0;
  v_failed integer := 0;
  v_final boolean;
  v_status text;
  v_chats integer;
  v_messages integer;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select s.* into v_session from public.whatsapp_linked_device_sessions s
  where s.clinic_id = p_clinic_id for update;
  if not found then raise exception 'LINKED_DEVICE_SESSION_NOT_FOUND'; end if;
  if p_batch_id is not null then
    select b.session_phone into v_batch_phone from public.whatsapp_history_delivery_batches b
    where b.id = p_batch_id and b.clinic_id = p_clinic_id for update;
    if v_batch_phone is distinct from v_session.authenticated_account_id then
      update public.whatsapp_history_delivery_batches set status = 'superseded',
        claimed_by = null, claimed_at = null, last_error = 'authenticated account changed',
        updated_at = pg_catalog.now()
      where id = p_batch_id and clinic_id = p_clinic_id;
      history_status := v_session.history_status; pending_batches := 0; failed_batches := 0;
      return next; return;
    end if;
    update public.whatsapp_history_delivery_batches b set
      status = case when p_delivered then 'delivered'
        when b.attempts + 1 >= p_max_attempts then 'failed' else 'pending' end,
      attempts = least(b.attempts + 1, 100), claimed_by = null, claimed_at = null,
      last_error = case when p_delivered then null else left(p_error, 200) end,
      updated_at = pg_catalog.now()
    where b.id = p_batch_id and b.clinic_id = p_clinic_id;
  end if;
  select count(*) filter (where b.status = 'pending')::integer,
         count(*) filter (where b.status = 'failed')::integer into v_pending, v_failed
  from public.whatsapp_history_delivery_batches b
  where b.clinic_id = p_clinic_id
    and b.session_phone = v_session.authenticated_account_id;
  v_final := v_session.history_final_batch_seen or coalesce(p_final_batch_seen, false);
  v_chats := v_session.history_chats_imported + greatest(coalesce(p_chats, 0), 0);
  v_messages := v_session.history_messages_imported + greatest(coalesce(p_messages, 0), 0);
  v_status := case when not v_final or v_pending > 0 then 'importing'
    when v_failed > 0 then 'partial'
    when v_chats = 0 and v_messages = 0 then 'unavailable' else 'complete' end;
  update public.whatsapp_linked_device_sessions set history_status = v_status,
    history_final_batch_seen = v_final, history_chats_imported = v_chats,
    history_messages_imported = v_messages,
    history_last_error = case when v_failed > 0 then left(p_error, 200) else null end,
    history_completed_at = case when v_status in ('complete','partial','unavailable')
      then pg_catalog.now() else history_completed_at end
  where clinic_id = p_clinic_id;
  history_status := v_status; pending_batches := v_pending; failed_batches := v_failed;
  return next;
end;
$$;
revoke all on function public.record_whatsapp_history_delivery(uuid, uuid, boolean, integer, integer, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_history_delivery(uuid, uuid, boolean, integer, integer, text, boolean, integer)
  to service_role;

create or replace function public.record_whatsapp_history_metrics(
  p_clinic_id uuid, p_batch_id uuid, p_chats_received integer default 0,
  p_messages_received integer default 0, p_deduplicated integer default 0,
  p_unsupported integer default 0
)
returns table (history_status text, messages_pending integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.whatsapp_linked_device_sessions%rowtype;
  v_record boolean := false;
  v_pending integer := 0;
  v_failed integer := 0;
  v_spool_pending integer := 0;
  v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select s.* into v_session from public.whatsapp_linked_device_sessions s
  where s.clinic_id = p_clinic_id for update;
  if not found then raise exception 'LINKED_DEVICE_SESSION_NOT_FOUND'; end if;
  update public.whatsapp_history_delivery_batches b set metrics_recorded = true,
    updated_at = pg_catalog.now()
  where b.id = p_batch_id and b.clinic_id = p_clinic_id and not b.metrics_recorded
    and b.session_phone = v_session.authenticated_account_id
  returning true into v_record;
  select count(*)::integer into v_pending from public.whatsapp_pending_history_messages p
  where p.clinic_id = p_clinic_id and p.status = 'pending'
    and p.authenticated_account_id = v_session.authenticated_account_id;
  select count(*) filter (where b.status = 'pending')::integer,
         count(*) filter (where b.status = 'failed')::integer into v_spool_pending, v_failed
  from public.whatsapp_history_delivery_batches b where b.clinic_id = p_clinic_id
    and b.session_phone = v_session.authenticated_account_id;
  v_status := case when not v_session.history_final_batch_seen or v_spool_pending > 0 then 'importing'
    when v_failed > 0 or v_pending > 0 then 'partial'
    when v_session.history_messages_imported = 0 and v_session.history_chats_imported = 0
      then 'unavailable' else 'complete' end;
  update public.whatsapp_linked_device_sessions set
    history_chats_received = history_chats_received + case when v_record then greatest(coalesce(p_chats_received,0),0) else 0 end,
    history_messages_received = history_messages_received + case when v_record then greatest(coalesce(p_messages_received,0),0) else 0 end,
    history_messages_deduplicated = history_messages_deduplicated + case when v_record then greatest(coalesce(p_deduplicated,0),0) else 0 end,
    history_messages_unsupported = history_messages_unsupported + case when v_record then greatest(coalesce(p_unsupported,0),0) else 0 end,
    history_messages_pending = v_pending, history_status = v_status,
    history_completed_at = case when v_status in ('complete','partial','unavailable')
      then pg_catalog.now() else history_completed_at end
  where clinic_id = p_clinic_id;
  history_status := v_status; messages_pending := v_pending; return next;
end;
$$;
revoke all on function public.record_whatsapp_history_metrics(uuid, uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_history_metrics(uuid, uuid, integer, integer, integer, integer)
  to service_role;
