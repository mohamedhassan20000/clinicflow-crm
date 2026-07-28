-- P6C review fixes: parallel-safe provider migration, provider-scoped template
-- provenance, and atomic connection/template transitions.
--
-- This migration is additive for deployed P3/P6C data. It preserves the existing
-- 360dialog row while a Meta row is pending, and keeps exactly one active
-- WhatsApp transport per clinic.

-- One row per provider allows 360dialog and Meta to coexist during migration.
alter table public.clinic_channels
  drop constraint if exists clinic_channels_clinic_id_channel_key;

alter table public.clinic_channels
  add constraint clinic_channels_clinic_channel_provider_key
  unique (clinic_id, channel, provider);

-- A provider identity may never be claimed by another provider/tenant boundary.
drop index if exists public.clinic_channels_whatsapp_sender_unique_idx;
create unique index clinic_channels_whatsapp_sender_unique_idx
  on public.clinic_channels (sender_identity)
  where channel = 'whatsapp';

alter table public.clinic_channels
  add column if not exists provider_account_id text,
  add column if not exists account_review_status text,
  add column if not exists webhook_subscribed boolean not null default false,
  add column if not exists last_signal_at timestamptz,
  add column if not exists last_sync_attempt_at timestamptz;

create unique index if not exists clinic_channels_provider_account_unique_idx
  on public.clinic_channels (provider, provider_account_id)
  where channel = 'whatsapp' and provider_account_id is not null;

-- Provider approval belongs to a provider account, not to the reusable local
-- template body. Keeping it in a binding table preserves 360dialog rollback
-- metadata while the same local template is submitted/synchronized with Meta.
create table if not exists public.message_template_provider_bindings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  template_id uuid not null,
  provider public.messaging_provider not null
    check (provider in ('dialog360', 'meta')),
  provider_account_id text,
  provider_template_id text,
  approval_status public.template_approval_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_template_provider_bindings_template_clinic_fkey
    foreign key (template_id, clinic_id)
    references public.message_templates(id, clinic_id)
    on delete cascade,
  unique (template_id, provider)
);

create unique index if not exists message_template_provider_bindings_provider_id_idx
  on public.message_template_provider_bindings (provider, provider_template_id)
  where provider_template_id is not null;
create index if not exists message_template_provider_bindings_clinic_provider_status_idx
  on public.message_template_provider_bindings
  (clinic_id, provider, provider_account_id, approval_status);

alter table public.message_template_provider_bindings enable row level security;
-- Intentionally no authenticated policies. Provider bindings are read/written
-- only through the reviewed server boundary, like clinic_channels.

drop trigger if exists trg_message_template_provider_bindings_updated_at
  on public.message_template_provider_bindings;
create trigger trg_message_template_provider_bindings_updated_at
  before update on public.message_template_provider_bindings
  for each row execute function public.set_updated_at();

-- Preserve legacy 360dialog approval/provenance without changing the reusable
-- template rows or their UI-facing status.
insert into public.message_template_provider_bindings (
  clinic_id,
  template_id,
  provider,
  provider_template_id,
  approval_status
)
select
  mt.clinic_id,
  mt.id,
  'dialog360'::public.messaging_provider,
  mt.provider_template_id,
  mt.approval_status
from public.message_templates mt
where mt.channel = 'whatsapp'
on conflict (template_id, provider) do nothing;

-- Atomic compare-and-set for Meta state. The row lock/update and audit insert
-- share one transaction, so an audit failure rolls the state write back and two
-- concurrent callbacks cannot both emit the same transition. The expected
-- updated_at value rejects an out-of-date application snapshot.
create or replace function public.apply_meta_channel_state(
  p_clinic_id uuid,
  p_channel_id uuid,
  p_expected_updated_at timestamptz,
  p_status public.clinic_channel_status,
  p_connection_state text,
  p_business_verification_status text,
  p_account_review_status text,
  p_phone_status text,
  p_quality_rating text,
  p_messaging_limit_tier text,
  p_webhook_subscribed boolean,
  p_last_state_reason text,
  p_last_synced_at timestamptz default null,
  p_last_signal_at timestamptz default null
)
returns table (
  applied boolean,
  transitioned boolean,
  connection_state text,
  state_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.clinic_channels%rowtype;
  v_transitioned boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to apply Meta channel state' using errcode = '42501';
  end if;

  select *
    into v_row
    from public.clinic_channels
   where id = p_channel_id
     and clinic_id = p_clinic_id
     and channel = 'whatsapp'
     and provider = 'meta'
   for update;

  if not found or v_row.updated_at is distinct from p_expected_updated_at then
    return query select false, false, null::text, null::text;
    return;
  end if;

  v_transitioned := v_row.connection_state is distinct from p_connection_state;

  if v_row.status is not distinct from p_status
     and v_row.connection_state is not distinct from p_connection_state
     and v_row.business_verification_status is not distinct from p_business_verification_status
     and v_row.account_review_status is not distinct from p_account_review_status
     and v_row.phone_status is not distinct from p_phone_status
     and v_row.quality_rating is not distinct from p_quality_rating
     and v_row.messaging_limit_tier is not distinct from p_messaging_limit_tier
     and v_row.webhook_subscribed is not distinct from p_webhook_subscribed
     and v_row.last_state_reason is not distinct from p_last_state_reason
     and (p_last_synced_at is null or v_row.last_synced_at is not distinct from p_last_synced_at)
     and (p_last_signal_at is null or v_row.last_signal_at is not distinct from p_last_signal_at)
  then
    return query
      select false, false, v_row.connection_state, v_row.last_state_reason;
    return;
  end if;

  update public.clinic_channels
     set status = p_status,
         connection_state = p_connection_state,
         business_verification_status = p_business_verification_status,
         account_review_status = p_account_review_status,
         phone_status = p_phone_status,
         quality_rating = p_quality_rating,
         messaging_limit_tier = p_messaging_limit_tier,
         webhook_subscribed = p_webhook_subscribed,
         last_state_reason = p_last_state_reason,
         last_synced_at = coalesce(p_last_synced_at, last_synced_at),
         last_signal_at = case
           when p_last_signal_at is null then last_signal_at
           when last_signal_at is null or p_last_signal_at >= last_signal_at
             then p_last_signal_at
           else last_signal_at
         end,
         connected_at = case
           when p_connection_state = 'connected' then coalesce(connected_at, now())
           else connected_at
         end
   where id = v_row.id;

  -- Cut over only after Meta is genuinely connected. If Meta later becomes
  -- unavailable, restore the retained 360dialog channel as the safe fallback.
  if p_connection_state = 'connected' then
    update public.clinic_channels
       set status = 'pending'
     where clinic_id = p_clinic_id
       and channel = 'whatsapp'
       and provider = 'dialog360'
       and status = 'active';
  elsif p_status = 'error' then
    update public.clinic_channels
       set status = 'active'
     where clinic_id = p_clinic_id
       and channel = 'whatsapp'
       and provider = 'dialog360'
       and status = 'pending';
  end if;

  if v_transitioned then
    insert into public.audit_logs (
      actor_id, clinic_id, action, table_name, record_id, new_data
    ) values (
      null,
      p_clinic_id,
      'messaging:connection_state',
      'clinic_channels',
      v_row.id,
      jsonb_build_object(
        'from', v_row.connection_state,
        'to', p_connection_state,
        'reason', p_last_state_reason
      )
    );
  end if;

  return query
    select true, v_transitioned, p_connection_state, p_last_state_reason;
end;
$$;

revoke all on function public.apply_meta_channel_state(
  uuid, uuid, timestamptz, public.clinic_channel_status, text, text, text,
  text, text, text, boolean, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_meta_channel_state(
  uuid, uuid, timestamptz, public.clinic_channel_status, text, text, text,
  text, text, text, boolean, text, timestamptz, timestamptz
) to service_role;

-- Atomically apply a provider template callback and its audit row. A failed
-- audit insert rolls the status update back.
create or replace function public.apply_message_template_provider_status(
  p_provider public.messaging_provider,
  p_provider_template_id text,
  p_status public.template_approval_status,
  p_allowed_from public.template_approval_status[]
)
returns table (template_id uuid, clinic_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.message_template_provider_bindings%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to apply template status' using errcode = '42501';
  end if;

  select *
    into v_binding
    from public.message_template_provider_bindings
   where provider = p_provider
     and provider_template_id = p_provider_template_id
   for update;

  if not found
     or v_binding.approval_status = p_status
     or not (v_binding.approval_status = any(p_allowed_from))
  then
    return;
  end if;

  update public.message_template_provider_bindings
     set approval_status = p_status
   where id = v_binding.id;

  -- Keep the legacy UI status synchronized for the currently active provider.
  if exists (
    select 1
      from public.clinic_channels cc
     where cc.clinic_id = v_binding.clinic_id
       and cc.channel = 'whatsapp'
       and cc.provider = p_provider
       and cc.status = 'active'
  ) then
    update public.message_templates
       set approval_status = p_status,
           provider_template_id = p_provider_template_id
     where id = v_binding.template_id
       and clinic_id = v_binding.clinic_id;
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    null,
    v_binding.clinic_id,
    'messaging:template_status',
    'message_templates',
    v_binding.template_id,
    jsonb_build_object('provider', p_provider, 'status', p_status)
  );

  return query
    select v_binding.template_id, v_binding.clinic_id, true;
end;
$$;

revoke all on function public.apply_message_template_provider_status(
  public.messaging_provider, text, public.template_approval_status,
  public.template_approval_status[]
) from public, anon, authenticated;
grant execute on function public.apply_message_template_provider_status(
  public.messaging_provider, text, public.template_approval_status,
  public.template_approval_status[]
) to service_role;

-- Fair, bounded reconciliation claiming. Failed rows are stamped before the
-- provider call, so they rotate behind channels not attempted recently.
create or replace function public.claim_meta_channels_for_reconciliation(
  p_limit integer default 120
)
returns table (id uuid, clinic_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to claim Meta channels' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select cc.id
      from public.clinic_channels cc
     where cc.channel = 'whatsapp'
       and cc.provider = 'meta'
       and cc.status in ('pending', 'active', 'error')
     order by cc.last_sync_attempt_at asc nulls first, cc.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 120), 500))
  ),
  claimed as (
    update public.clinic_channels cc
       set last_sync_attempt_at = now()
      from candidates c
     where cc.id = c.id
    returning cc.id, cc.clinic_id
  )
  select claimed.id, claimed.clinic_id from claimed;
end;
$$;

revoke all on function public.claim_meta_channels_for_reconciliation(integer)
  from public, anon, authenticated;
grant execute on function public.claim_meta_channels_for_reconciliation(integer)
  to service_role;

-- Explicit provider switch used by the existing 360dialog connect/reconnect
-- flow and rollback runbook. Credentials remain on both rows; only the selected
-- transport is active.
create or replace function public.activate_whatsapp_provider(
  p_clinic_id uuid,
  p_provider public.messaging_provider
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_provider not in ('dialog360', 'meta')
  then
    raise exception 'Not authorized to activate WhatsApp provider' using errcode = '42501';
  end if;

  select exists (
    select 1
      from public.clinic_channels
     where clinic_id = p_clinic_id
       and channel = 'whatsapp'
       and provider = p_provider
  ) into v_exists;
  if not v_exists then
    return false;
  end if;

  update public.clinic_channels
     set status = case when provider = p_provider then 'active' else 'pending' end
   where clinic_id = p_clinic_id
     and channel = 'whatsapp';
  return true;
end;
$$;

revoke all on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) from public, anon, authenticated;
grant execute on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) to service_role;
