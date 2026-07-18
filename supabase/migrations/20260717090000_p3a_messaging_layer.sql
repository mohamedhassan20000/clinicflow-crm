-- P3A: Messaging layer schema — channel abstraction tables (§5.2 of docs/AI_AGENT_PLAN.md).
--
-- Five tenant tables: clinic_channels, conversations, inbound_messages,
-- outbound_messages, message_templates. All carry clinic_id and are RLS'd.
--
-- Trust boundaries in this migration:
--   * clinic_channels holds encrypted per-tenant provider credentials
--     (credentials_encrypted). It deliberately has NO authenticated policies —
--     not even clinic-member SELECT — so ciphertext never reaches a browser.
--     Credentials are encrypted/decrypted exclusively inside lib/messaging/
--     server code (§9.2); all reads/writes go through the service role.
--     P3B's connect flow adds a reviewed non-secret read path when the UI
--     needs channel status.
--   * The four content tables are clinic-member readable (own clinic only).
--     Writes happen only through lib/messaging/ server code (service role):
--     no authenticated write policies exist in P3A. P3C/P3D add the narrow
--     write policies their UIs require, each with its own review.
--   * No platform-admin policies: message bodies are patient-adjacent data
--     and stay invisible to the operator panel (§3.6). Delivery-health
--     aggregates arrive later through reviewed read RPCs.

create type public.message_channel as enum ('whatsapp', 'email');
create type public.messaging_provider as enum ('dialog360', 'meta', 'resend');
create type public.clinic_channel_status as enum ('pending', 'active', 'error');
create type public.outbound_message_status as enum ('queued', 'sent', 'delivered', 'read', 'failed');
create type public.conversation_status as enum ('open', 'closed');
create type public.template_approval_status as enum ('draft', 'submitted', 'approved', 'rejected');
create type public.outbound_related_type as enum ('appointment', 'invoice', 'agent', 'manual');

-- ---------------------------------------------------------------------------
-- clinic_channels — one configured channel per (clinic, channel)
-- ---------------------------------------------------------------------------

create table public.clinic_channels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  channel public.message_channel not null,
  provider public.messaging_provider not null,
  -- AES-256-GCM ciphertext produced by lib/messaging/crypto.ts. Nullable:
  -- the email channel uses the platform Resend key and stores no secret.
  credentials_encrypted bytea,
  sender_identity text not null check (length(btrim(sender_identity)) between 1 and 320),
  status public.clinic_channel_status not null default 'pending',
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, channel),
  constraint clinic_channels_provider_matches_channel check (
    (channel = 'whatsapp' and provider in ('dialog360', 'meta'))
    or (channel = 'email' and provider = 'resend')
  )
);

create index clinic_channels_clinic_status_idx
  on public.clinic_channels (clinic_id, status);
-- 360dialog messaging webhooks route by phone_number_id, stored as the
-- WhatsApp sender_identity. It must identify exactly one tenant globally.
create unique index clinic_channels_whatsapp_sender_unique_idx
  on public.clinic_channels (provider, sender_identity)
  where channel = 'whatsapp';

alter table public.clinic_channels enable row level security;
-- Intentionally NO policies: deny-all for anon and authenticated.
-- Service-role access only, from lib/messaging/ server code.

create trigger trg_clinic_channels_updated_at
  before update on public.clinic_channels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations — one per (clinic, patient/sender, channel) thread
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete set null,
  channel public.message_channel not null,
  -- Stable provider-side participant identity. It is the concurrency key for
  -- inbound threading; patient_id remains staff-reviewable metadata.
  participant_address text,
  patient_link_status text not null default 'automatic'
    check (patient_link_status in ('automatic', 'manual', 'unlinked')),
  window_expires_at timestamptz,          -- 24h service window (§5.4)
  status public.conversation_status not null default 'open',
  status_updated_at timestamptz not null default now(),
  assigned_to uuid references public.profiles(id) on delete set null,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_clinic_last_message_idx
  on public.conversations (clinic_id, last_message_at desc);
create index conversations_clinic_status_idx
  on public.conversations (clinic_id, status);
create unique index conversations_participant_unique_idx
  on public.conversations (clinic_id, channel, participant_address)
  where participant_address is not null;
-- Tenant-integrity anchor for composite FKs (P1A subscriptions precedent).
create unique index conversations_id_clinic_unique_idx
  on public.conversations (id, clinic_id);
create unique index patients_id_clinic_messaging_unique_idx
  on public.patients (id, clinic_id);
create unique index profiles_id_clinic_messaging_unique_idx
  on public.profiles (id, clinic_id);

alter table public.conversations
  add constraint conversations_patient_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id)
    on delete set null (patient_id),
  add constraint conversations_assignee_clinic_fkey
    foreign key (assigned_to, clinic_id)
    references public.profiles(id, clinic_id)
    on delete set null (assigned_to);

alter table public.conversations enable row level security;
create policy "inbox_staff_read_own_conversations"
on public.conversations for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

create trigger trg_conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- message_templates — per-clinic template bodies (§7.4 manages them in P3D)
-- ---------------------------------------------------------------------------

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  channel public.message_channel not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  -- text + check, not an enum: adding a locale must stay a registry change (§4.1).
  language text not null check (language in ('ar', 'en')),
  body text not null check (length(body) between 1 and 4096),
  variables jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  provider_template_id text,
  approval_status public.template_approval_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, channel, name, language)
);

create unique index message_templates_id_clinic_unique_idx
  on public.message_templates (id, clinic_id);
create index message_templates_clinic_channel_idx
  on public.message_templates (clinic_id, channel, approval_status);
create unique index message_templates_provider_id_unique_idx
  on public.message_templates (provider_template_id)
  where provider_template_id is not null;

alter table public.message_templates enable row level security;
create policy "inbox_staff_read_own_message_templates"
on public.message_templates for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

create trigger trg_message_templates_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- outbound_messages — every send of any kind, one row (§7.6)
-- ---------------------------------------------------------------------------

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  channel public.message_channel not null,
  provider public.messaging_provider not null,
  recipient text not null check (length(btrim(recipient)) between 1 and 320),
  template_id uuid,
  -- Truncated, redacted preview only — never the full body (§9.3).
  body_preview text check (body_preview is null or length(body_preview) <= 160),
  related_type public.outbound_related_type not null,
  related_id uuid,
  status public.outbound_message_status not null default 'queued',
  provider_message_id text,
  error text,
  cost_micro integer check (cost_micro is null or cost_micro >= 0),
  created_at timestamptz not null default now(),
  status_updated_at timestamptz not null default now(),
  constraint outbound_messages_template_clinic_fkey
    foreign key (template_id, clinic_id)
    references public.message_templates(id, clinic_id)
    on delete set null (template_id)
);

create index outbound_messages_clinic_created_idx
  on public.outbound_messages (clinic_id, created_at desc);
create index outbound_messages_clinic_status_idx
  on public.outbound_messages (clinic_id, status);
create index outbound_messages_related_idx
  on public.outbound_messages (related_type, related_id)
  where related_id is not null;
-- Webhook status updates address rows by provider id; unique so a delivery
-- callback can never fan out across clinics.
create unique index outbound_messages_provider_message_unique_idx
  on public.outbound_messages (provider, provider_message_id)
  where provider_message_id is not null;

alter table public.outbound_messages enable row level security;
create policy "inbox_staff_read_own_outbound_messages"
on public.outbound_messages for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

-- ---------------------------------------------------------------------------
-- inbound_messages — webhook-received patient messages (traffic lands in P3B)
-- ---------------------------------------------------------------------------

create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  channel public.message_channel not null,
  sender text not null check (length(btrim(sender)) between 1 and 320),
  patient_id uuid references public.patients(id) on delete set null,
  conversation_id uuid not null,
  body text not null,
  provider_message_id text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint inbound_messages_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete cascade,
  constraint inbound_messages_patient_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id)
    on delete set null (patient_id)
);

create index inbound_messages_conversation_received_idx
  on public.inbound_messages (conversation_id, received_at desc);
create index inbound_messages_clinic_received_idx
  on public.inbound_messages (clinic_id, received_at desc);
-- Webhook replay idempotency: same provider message id twice → one row (§10).
create unique index inbound_messages_provider_message_unique_idx
  on public.inbound_messages (clinic_id, provider_message_id)
  where provider_message_id is not null;

alter table public.inbound_messages enable row level security;
create policy "inbox_staff_read_own_inbound_messages"
on public.inbound_messages for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

-- ---------------------------------------------------------------------------
-- P3B/P3C transactional messaging boundaries
-- ---------------------------------------------------------------------------

-- One provider event atomically resolves the thread, inserts the idempotency
-- row, and advances conversation activity. The advisory lock serializes the
-- first two distinct events from a previously unseen sender without holding a
-- lock across clinics or senders.
create or replace function public.persist_whatsapp_inbound(
  p_clinic_id uuid,
  p_sender text,
  p_body text,
  p_provider_message_id text,
  p_received_at timestamptz
)
returns table (inserted boolean, conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_window_expires_at timestamptz := p_received_at + interval '24 hours';
begin
  if p_sender is null or btrim(p_sender) = ''
     or p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'INVALID_INBOUND_MESSAGE';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_sender, 0)
  );

  select im.conversation_id
    into conversation_id
  from public.inbound_messages im
  where im.clinic_id = p_clinic_id
    and im.provider_message_id = p_provider_message_id;
  if found then
    inserted := false;
    return next;
    return;
  end if;

  select c.*
    into v_conversation
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
      clinic_id,
      patient_id,
      channel,
      participant_address,
      patient_link_status,
      window_expires_at,
      status,
      status_updated_at,
      last_message_at
    ) values (
      p_clinic_id,
      v_patient_id,
      'whatsapp'::public.message_channel,
      p_sender,
      'automatic',
      v_window_expires_at,
      'open'::public.conversation_status,
      p_received_at,
      p_received_at
    )
    returning * into v_conversation;
  elsif v_conversation.patient_link_status = 'automatic'
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

  insert into public.inbound_messages (
    clinic_id,
    channel,
    sender,
    patient_id,
    conversation_id,
    body,
    provider_message_id,
    received_at
  ) values (
    p_clinic_id,
    'whatsapp'::public.message_channel,
    p_sender,
    v_conversation.patient_id,
    v_conversation.id,
    coalesce(nullif(p_body, ''), '[Empty message]'),
    p_provider_message_id,
    p_received_at
  );

  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at, p_received_at), p_received_at),
      window_expires_at = greatest(
        coalesce(window_expires_at, v_window_expires_at),
        v_window_expires_at
      ),
      status = case
        when status = 'open'::public.conversation_status
          or p_received_at >= status_updated_at
          then 'open'::public.conversation_status
        else status
      end,
      status_updated_at = case
        when status = 'closed'::public.conversation_status
          and p_received_at >= status_updated_at
          then p_received_at
        else status_updated_at
      end
  where id = v_conversation.id;

  inserted := true;
  conversation_id := v_conversation.id;
  return next;
exception
  when unique_violation then
    select im.conversation_id
      into conversation_id
    from public.inbound_messages im
    where im.clinic_id = p_clinic_id
      and im.provider_message_id = p_provider_message_id;
    inserted := false;
    return next;
end;
$$;

revoke all on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz)
  to service_role;

-- Staff triage and historical message relinking are one transaction and share
-- the sender lock with webhook persistence, so a concurrent inbound cannot
-- undo an explicit link or unlink decision.
create or replace function public.set_conversation_patient(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_patient_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participant text;
begin
  select c.participant_address
    into v_participant
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;
  if not found then return false; end if;

  if v_participant is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || v_participant, 0)
    );
  end if;

  if p_patient_id is not null and not exists (
    select 1
    from public.patients p
    where p.id = p_patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted
      and p.deleted_at is null
  ) then
    return false;
  end if;

  update public.conversations
  set patient_id = p_patient_id,
      patient_link_status = case when p_patient_id is null then 'unlinked' else 'manual' end
  where id = p_conversation_id
    and clinic_id = p_clinic_id;
  if not found then return false; end if;

  update public.inbound_messages
  set patient_id = p_patient_id
  where conversation_id = p_conversation_id
    and clinic_id = p_clinic_id;
  return true;
end;
$$;

revoke all on function public.set_conversation_patient(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.set_conversation_patient(uuid, uuid, uuid)
  to service_role;

-- Provider acceptance and conversation activity become durable together. A
-- caller retries this narrow RPC; callbacks can later repair correlation from
-- their opaque outbound UUID when the immediate response write was transient.
create or replace function public.finalize_outbound_message(
  p_clinic_id uuid,
  p_outbound_message_id uuid,
  p_status public.outbound_message_status,
  p_provider_message_id text,
  p_error text,
  p_cost_micro integer,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.outbound_messages%rowtype;
begin
  if p_status not in (
    'sent'::public.outbound_message_status,
    'failed'::public.outbound_message_status
  ) then
    raise exception 'INVALID_FINAL_OUTBOUND_STATUS';
  end if;

  select o.*
    into v_message
  from public.outbound_messages o
  where o.id = p_outbound_message_id
    and o.clinic_id = p_clinic_id
  for update;
  if not found then return false; end if;

  update public.outbound_messages
  set status = case
        when p_status = 'sent'::public.outbound_message_status
          and v_message.status in (
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status,
            'failed'::public.outbound_message_status
          ) then v_message.status
        when p_status = 'failed'::public.outbound_message_status
          and v_message.status in (
            'sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status
          ) then v_message.status
        else p_status
      end,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      error = case
        when p_status = 'failed'::public.outbound_message_status
          and v_message.status not in (
            'sent'::public.outbound_message_status,
            'delivered'::public.outbound_message_status,
            'read'::public.outbound_message_status
          ) then p_error
        when p_status = 'sent'::public.outbound_message_status
          and v_message.status <> 'failed'::public.outbound_message_status then null
        else error
      end,
      cost_micro = coalesce(p_cost_micro, cost_micro),
      status_updated_at = greatest(status_updated_at, coalesce(p_occurred_at, now()))
  where id = v_message.id;

  if p_status = 'sent'::public.outbound_message_status
     and v_message.related_type = 'manual'::public.outbound_related_type
     and v_message.related_id is not null then
    update public.conversations
    set last_message_at = greatest(
      coalesce(last_message_at, v_message.created_at),
      v_message.created_at
    )
    where id = v_message.related_id
      and clinic_id = p_clinic_id;
  end if;
  return true;
exception
  when unique_violation then return false;
end;
$$;

revoke all on function public.finalize_outbound_message(uuid, uuid, public.outbound_message_status, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_outbound_message(uuid, uuid, public.outbound_message_status, text, text, integer, timestamptz)
  to service_role;

-- Delivery callbacks advance status under one row lock. Rank checks prevent
-- concurrent or out-of-order callbacks from regressing provider state.
-- p_client_reference is accepted only with an authenticated clinic context;
-- it repairs lost correlation and lets a callback recover a local transport
-- failure, while a provider-correlated failed state remains terminal.
create or replace function public.advance_outbound_message_status(
  p_provider public.messaging_provider,
  p_provider_message_id text,
  p_client_reference uuid,
  p_expected_clinic_id uuid,
  p_status public.outbound_message_status,
  p_error text,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.outbound_messages%rowtype;
  v_current_rank integer;
  v_next_rank integer;
  v_recovering_local_failure boolean := false;
begin
  select o.*
    into v_message
  from public.outbound_messages o
  where o.provider = p_provider
    and o.provider_message_id = p_provider_message_id
  for update;

  if not found and p_client_reference is not null and p_expected_clinic_id is not null then
    select o.*
      into v_message
    from public.outbound_messages o
    where o.id = p_client_reference
      and o.clinic_id = p_expected_clinic_id
      and o.provider = p_provider
      and o.provider_message_id is null
    for update;
    if found then
      update public.outbound_messages
      set provider_message_id = p_provider_message_id
      where id = v_message.id;
      v_recovering_local_failure :=
        v_message.status = 'failed'::public.outbound_message_status
        and p_status in (
          'sent'::public.outbound_message_status,
          'delivered'::public.outbound_message_status,
          'read'::public.outbound_message_status
        );
    end if;
  end if;

  if not found then return false; end if;
  if p_expected_clinic_id is not null
     and v_message.clinic_id <> p_expected_clinic_id then
    return false;
  end if;

  if v_message.status = 'failed'::public.outbound_message_status
     and not v_recovering_local_failure then
    return true;
  end if;
  if p_status = 'failed'::public.outbound_message_status
     and v_message.status in (
       'delivered'::public.outbound_message_status,
       'read'::public.outbound_message_status
     ) then
    return true;
  end if;

  v_current_rank := case
    when v_recovering_local_failure then 0
    else case v_message.status
    when 'queued'::public.outbound_message_status then 0
    when 'sent'::public.outbound_message_status then 1
    when 'delivered'::public.outbound_message_status then 2
    when 'read'::public.outbound_message_status then 3
    when 'failed'::public.outbound_message_status then 4
    end
  end;
  v_next_rank := case p_status
    when 'queued'::public.outbound_message_status then 0
    when 'sent'::public.outbound_message_status then 1
    when 'delivered'::public.outbound_message_status then 2
    when 'read'::public.outbound_message_status then 3
    when 'failed'::public.outbound_message_status then 4
  end;
  if p_status <> 'failed'::public.outbound_message_status
     and v_next_rank < v_current_rank then
    return true;
  end if;

  update public.outbound_messages
  set status = p_status,
      error = case when p_status = 'failed' then p_error else null end,
      status_updated_at = greatest(status_updated_at, coalesce(p_occurred_at, now()))
  where id = v_message.id;
  return true;
exception
  when unique_violation then return false;
end;
$$;

revoke all on function public.advance_outbound_message_status(public.messaging_provider, text, uuid, uuid, public.outbound_message_status, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.advance_outbound_message_status(public.messaging_provider, text, uuid, uuid, public.outbound_message_status, text, timestamptz)
  to service_role;

-- Bounded list, exact summaries. Each conversation uses indexed lateral
-- lookups/counts, avoiding the former global oldest-2,000-message slice.
create or replace function public.get_inbox_conversation_summaries(
  p_requested_conversation_id uuid default null,
  p_limit integer default 100
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
  with recent as (
    select c.id
    from public.conversations c
    where c.channel = 'whatsapp'::public.message_channel
    order by c.last_message_at desc nulls last, c.created_at desc
    limit least(greatest(p_limit, 1), 100)
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
      select coalesce(om.body_preview, ''), om.created_at, om.id
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

revoke all on function public.get_inbox_conversation_summaries(uuid, integer)
  from public, anon;
grant execute on function public.get_inbox_conversation_summaries(uuid, integer)
  to authenticated;

-- P3C consumes Postgres Changes for inbox/thread updates. RLS still controls
-- which rows each authenticated browser can receive.
alter publication supabase_realtime add table
  public.conversations,
  public.inbound_messages,
  public.outbound_messages;

-- ---------------------------------------------------------------------------
-- Plan limits for messaging metrics
-- ---------------------------------------------------------------------------
-- checkUsageLimit() resolves each metric through plans.limits; the P1A seeds
-- carried no messaging keys, which would deny every send with limit 0. Add
-- defaults for the two messaging metrics. Existing keys win (operators may
-- have tuned them), because `||` takes the right-hand value on conflict.

update public.plans
set limits = case slug
  when 'basic' then '{"emails_month":1000,"wa_messages_month":0}'::jsonb || limits
  when 'pro' then '{"emails_month":3000,"wa_messages_month":3000}'::jsonb || limits
  when 'pro_ai' then '{"emails_month":5000,"wa_messages_month":10000}'::jsonb || limits
  else limits
end,
updated_at = now()
where slug in ('basic', 'pro', 'pro_ai');
