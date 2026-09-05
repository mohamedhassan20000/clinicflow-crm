-- P8C — audible voice-note verification and lossless LID history reconciliation.
--
-- Audio validation is application/worker code. This migration owns the durable
-- identity and pending-history half of the fix. Opaque LID digits are never
-- interpreted as phone numbers; only WhatsApp-asserted pairs enter the mapping
-- table. Unresolved history remains service-role-only until such a pair arrives.

create table if not exists public.whatsapp_lid_mappings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  lid_jid text not null check (lid_jid ~ '^[0-9]{3,30}@lid$'),
  participant_address text not null check (participant_address ~ '^\+[1-9][0-9]{5,19}$'),
  first_asserted_at timestamptz not null default now(),
  last_asserted_at timestamptz not null default now(),
  constraint whatsapp_lid_mappings_identity_unique unique (clinic_id, lid_jid)
);

alter table public.whatsapp_lid_mappings enable row level security;
grant all on table public.whatsapp_lid_mappings to service_role;
revoke all on table public.whatsapp_lid_mappings from public, anon, authenticated;

create or replace function public.upsert_whatsapp_lid_mappings(
  p_clinic_id uuid,
  p_mappings jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if jsonb_typeof(p_mappings) <> 'array' then
    raise exception 'INVALID_LID_MAPPINGS';
  end if;

  if exists (
    with supplied as (
      select item->>'lid' as lid, item->>'participant' as participant
      from jsonb_array_elements(p_mappings) item
      where item->>'lid' ~ '^[0-9]{3,30}@lid$'
        and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    )
    select 1
    from supplied
    group by lid
    having count(distinct participant) > 1
  ) then
    raise exception 'LID_MAPPING_CONFLICT';
  end if;

  if exists (
    with supplied as (
      select item->>'lid' as lid, item->>'participant' as participant
      from jsonb_array_elements(p_mappings) item
    )
    select 1
    from supplied s
    join public.whatsapp_lid_mappings existing
      on existing.clinic_id = p_clinic_id and existing.lid_jid = s.lid
    where existing.participant_address <> s.participant
  ) then
    -- An asserted identity is immutable. Refusing a contradiction is safer
    -- than moving historical messages between people.
    raise exception 'LID_MAPPING_CONFLICT';
  end if;

  with supplied as (
    select distinct on (item->>'lid')
      item->>'lid' as lid,
      item->>'participant' as participant
    from jsonb_array_elements(p_mappings) item
    where item->>'lid' ~ '^[0-9]{3,30}@lid$'
      and item->>'participant' ~ '^\+[1-9][0-9]{5,19}$'
    order by item->>'lid', item->>'participant'
  ), written as (
    insert into public.whatsapp_lid_mappings as existing (
      clinic_id, lid_jid, participant_address
    )
    select p_clinic_id, supplied.lid, supplied.participant
    from supplied
    on conflict (clinic_id, lid_jid) do update
      set last_asserted_at = now()
      where existing.participant_address = excluded.participant_address
    returning 1
  )
  select count(*)::integer into v_count from written;

  return v_count;
end;
$$;

revoke all on function public.upsert_whatsapp_lid_mappings(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_lid_mappings(uuid, jsonb)
  to service_role;

create table if not exists public.whatsapp_pending_history_chats (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  lid_jid text not null check (lid_jid ~ '^[0-9]{3,30}@lid$'),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 120),
  last_message_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_at timestamptz,
  conversation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_pending_history_chats_unique unique (clinic_id, lid_jid),
  constraint whatsapp_pending_history_chats_conversation_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete set null (conversation_id)
);

create table if not exists public.whatsapp_pending_history_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  lid_jid text not null check (lid_jid ~ '^[0-9]{3,30}@lid$'),
  provider_message_id text not null check (length(btrim(provider_message_id)) between 1 and 255),
  direction text not null check (direction in ('inbound', 'outbound')),
  body text check (body is null or length(body) <= 8192),
  occurred_at timestamptz not null,
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 120),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_at timestamptz,
  conversation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_pending_history_messages_unique unique (clinic_id, provider_message_id),
  constraint whatsapp_pending_history_messages_conversation_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete set null (conversation_id)
);

create index if not exists whatsapp_pending_history_chats_reconcile_idx
  on public.whatsapp_pending_history_chats (clinic_id, lid_jid)
  where status = 'pending';
create index if not exists whatsapp_pending_history_messages_reconcile_idx
  on public.whatsapp_pending_history_messages (clinic_id, lid_jid, occurred_at, id)
  where status = 'pending';

alter table public.whatsapp_pending_history_chats enable row level security;
alter table public.whatsapp_pending_history_messages enable row level security;
grant all on table public.whatsapp_pending_history_chats to service_role;
grant all on table public.whatsapp_pending_history_messages to service_role;
revoke all on table public.whatsapp_pending_history_chats from public, anon, authenticated;
revoke all on table public.whatsapp_pending_history_messages from public, anon, authenticated;

alter table public.whatsapp_linked_device_sessions
  add column if not exists history_chats_received integer not null default 0 check (history_chats_received >= 0),
  add column if not exists history_messages_received integer not null default 0 check (history_messages_received >= 0),
  add column if not exists history_messages_deduplicated integer not null default 0 check (history_messages_deduplicated >= 0),
  add column if not exists history_messages_pending integer not null default 0 check (history_messages_pending >= 0),
  add column if not exists history_messages_unsupported integer not null default 0 check (history_messages_unsupported >= 0);

alter table public.whatsapp_history_delivery_batches
  add column if not exists metrics_recorded boolean not null default false;

create or replace function public.record_whatsapp_history_metrics(
  p_clinic_id uuid,
  p_batch_id uuid,
  p_chats_received integer default 0,
  p_messages_received integer default 0,
  p_deduplicated integer default 0,
  p_unsupported integer default 0
)
returns table (
  history_status text,
  messages_pending integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record boolean := false;
  v_pending integer := 0;
  v_failed integer := 0;
  v_spool_pending integer := 0;
  v_final boolean := false;
  v_imported integer := 0;
  v_chats_imported integer := 0;
  v_status text;
begin
  update public.whatsapp_history_delivery_batches batch
  set metrics_recorded = true,
      updated_at = now()
  where batch.id = p_batch_id
    and batch.clinic_id = p_clinic_id
    and not batch.metrics_recorded
  returning true into v_record;

  select count(*)::integer into v_pending
  from public.whatsapp_pending_history_messages pending
  where pending.clinic_id = p_clinic_id and pending.status = 'pending';

  select count(*) filter (where status = 'pending')::integer,
         count(*) filter (where status = 'failed')::integer
    into v_spool_pending, v_failed
  from public.whatsapp_history_delivery_batches batch
  where batch.clinic_id = p_clinic_id;

  select session.history_final_batch_seen,
         session.history_messages_imported,
         session.history_chats_imported
    into v_final, v_imported, v_chats_imported
  from public.whatsapp_linked_device_sessions session
  where session.clinic_id = p_clinic_id
  for update;
  if not found then raise exception 'LINKED_DEVICE_SESSION_NOT_FOUND'; end if;

  v_status := case
    when not v_final or v_spool_pending > 0 then 'importing'
    when v_failed > 0 or v_pending > 0 then 'partial'
    when v_imported = 0 and v_chats_imported = 0 then 'unavailable'
    else 'complete'
  end;

  update public.whatsapp_linked_device_sessions
  set history_chats_received = history_chats_received +
        case when v_record then greatest(coalesce(p_chats_received, 0), 0) else 0 end,
      history_messages_received = history_messages_received +
        case when v_record then greatest(coalesce(p_messages_received, 0), 0) else 0 end,
      history_messages_deduplicated = history_messages_deduplicated +
        case when v_record then greatest(coalesce(p_deduplicated, 0), 0) else 0 end,
      history_messages_unsupported = history_messages_unsupported +
        case when v_record then greatest(coalesce(p_unsupported, 0), 0) else 0 end,
      history_messages_pending = v_pending,
      history_status = v_status,
      history_completed_at = case
        when v_status in ('complete', 'partial', 'unavailable') then now()
        else history_completed_at
      end
  where clinic_id = p_clinic_id;

  history_status := v_status;
  messages_pending := v_pending;
  return next;
end;
$$;

revoke all on function public.record_whatsapp_history_metrics(uuid, uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_history_metrics(uuid, uuid, integer, integer, integer, integer)
  to service_role;
