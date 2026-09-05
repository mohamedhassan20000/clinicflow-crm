-- Phase 5f: privileged clinic-tenant action controls only.
--
-- Adds no plan, subscription, billing, document, export, retention, or
-- platform-operator mutation. Privileged domain writes still run through the
-- authenticated caller and existing RLS; this migration extends only the
-- server-owned confirmation/rate-limit control plane.

alter table public.ai_action_confirmations
  add column risk_class text not null default 'normal'
    check (risk_class in ('normal', 'sensitive', 'destructive', 'bulk', 'privileged')),
  add column target_user_id uuid,
  add column before_digest text
    check (before_digest is null or before_digest ~ '^[0-9a-f]{64}$'),
  add column after_digest text
    check (after_digest is null or after_digest ~ '^[0-9a-f]{64}$'),
  add column step_up_verified_at timestamptz,
  add column reauth_nonce_hash text
    check (reauth_nonce_hash is null or reauth_nonce_hash ~ '^[0-9a-f]{64}$'),
  add constraint ai_action_confirmations_target_clinic_fkey
    foreign key (target_user_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  add constraint ai_action_confirmations_privileged_binding_check
    check (
      (risk_class <> 'privileged'
        and target_user_id is null
        and before_digest is null
        and after_digest is null
        and step_up_verified_at is null
        and reauth_nonce_hash is null)
      or
      (risk_class = 'privileged'
        and target_user_id is not null
        and before_digest is not null
        and after_digest is not null)
    );

create index ai_action_confirmations_privileged_target_idx
  on public.ai_action_confirmations
  (clinic_id, target_user_id, created_at desc)
  where risk_class = 'privileged';

create table public.ai_privileged_action_rate_limits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid not null,
  conversation_id uuid not null,
  action_date date not null,
  preview_count integer not null default 0 check (preview_count between 0 and 5),
  execute_count integer not null default 0 check (execute_count between 0 and 3),
  updated_at timestamptz not null default clock_timestamp(),
  constraint ai_privileged_rate_actor_clinic_fkey
    foreign key (actor_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  constraint ai_privileged_rate_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.agent_conversations(id, clinic_id)
    on delete cascade,
  unique (clinic_id, actor_id, conversation_id, action_date)
);

create index ai_privileged_action_rate_daily_idx
  on public.ai_privileged_action_rate_limits
  (clinic_id, actor_id, action_date);

alter table public.ai_privileged_action_rate_limits enable row level security;
revoke all on table public.ai_privileged_action_rate_limits
  from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_privileged_action_rate_limits
  to service_role;

comment on table public.ai_privileged_action_rate_limits is
  'Server-only Phase 5f counters: at most 5 previews and 3 executes per conversation/day, and 20 previews and 10 executes per actor/day.';

create function public.issue_ai_action_confirmation(
  p_token_hash text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_action_id text,
  p_input_digest text,
  p_expires_at timestamptz,
  p_risk_class text,
  p_target_user_id uuid,
  p_before_digest text,
  p_after_digest text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to issue AI action confirmations'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.agent_conversations c
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id
      and c.user_id = p_actor_id
  ) then
    raise exception 'Invalid AI action confirmation owner'
      using errcode = '42501';
  end if;
  if p_risk_class = 'privileged' and (
    p_expires_at > clock_timestamp() + interval '2 minutes 5 seconds'
    or p_target_user_id is null
    or p_target_user_id = p_actor_id
    or not exists (
      select 1 from public.profiles target
      where target.id = p_target_user_id
        and target.clinic_id = p_clinic_id
    )
  ) then
    raise exception 'Invalid privileged AI action binding'
      using errcode = '42501';
  end if;

  insert into public.ai_action_confirmations (
    token_hash, clinic_id, actor_id, conversation_id, action_id, input_digest,
    expires_at, risk_class, target_user_id, before_digest, after_digest
  ) values (
    p_token_hash, p_clinic_id, p_actor_id, p_conversation_id, p_action_id,
    p_input_digest, p_expires_at, p_risk_class, p_target_user_id,
    p_before_digest, p_after_digest
  ) returning id into v_id;
  return v_id;
end;
$$;

create function public.verify_ai_action_step_up(
  p_token_hash text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_reauth_nonce_hash text,
  p_verified_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to verify AI action step-up'
      using errcode = '42501';
  end if;
  update public.ai_action_confirmations
  set step_up_verified_at = p_verified_at,
      reauth_nonce_hash = p_reauth_nonce_hash
  where token_hash = p_token_hash
    and clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and risk_class = 'privileged'
    and consumed_at is null
    and expires_at > p_verified_at;
  return found;
end;
$$;

create function public.claim_ai_action_confirmation(
  p_token_hash text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_action_id text,
  p_input_digest text,
  p_consumed_at timestamptz,
  p_target_user_id uuid,
  p_before_digest text,
  p_after_digest text,
  p_reauth_nonce_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmation public.ai_action_confirmations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to claim AI action confirmations'
      using errcode = '42501';
  end if;

  update public.ai_action_confirmations
  set consumed_at = p_consumed_at
  where token_hash = p_token_hash
    and clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and conversation_id = p_conversation_id
    and action_id = p_action_id
    and input_digest = p_input_digest
    and target_user_id is not distinct from p_target_user_id
    and before_digest is not distinct from p_before_digest
    and after_digest is not distinct from p_after_digest
    and (
      risk_class <> 'privileged'
      or (
        reauth_nonce_hash = p_reauth_nonce_hash
        and step_up_verified_at is not null
        and step_up_verified_at >= p_consumed_at - interval '2 minutes'
        and step_up_verified_at <= p_consumed_at
      )
    )
    and consumed_at is null
    and expires_at > p_consumed_at
  returning * into v_confirmation;

  if found then return 'claimed'; end if;

  select * into v_confirmation
  from public.ai_action_confirmations
  where token_hash = p_token_hash;
  if not found
    or v_confirmation.clinic_id <> p_clinic_id
    or v_confirmation.actor_id <> p_actor_id
    or v_confirmation.conversation_id <> p_conversation_id
    or v_confirmation.action_id <> p_action_id
    or v_confirmation.input_digest <> p_input_digest
  then return 'invalid'; end if;
  if v_confirmation.consumed_at is not null then return 'replayed'; end if;
  if v_confirmation.expires_at <= p_consumed_at then return 'expired'; end if;
  return 'invalid';
end;
$$;

create function public.consume_ai_privileged_action_rate_limit(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_phase text,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := (p_occurred_at at time zone 'UTC')::date;
  v_conversation_preview integer := 0;
  v_conversation_execute integer := 0;
  v_daily_preview integer := 0;
  v_daily_execute integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to consume AI privileged rate limits'
      using errcode = '42501';
  end if;
  if p_phase not in ('preview', 'execute') then
    raise exception 'Invalid AI privileged rate-limit phase'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.agent_conversations c
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id
      and c.user_id = p_actor_id
  ) then
    raise exception 'Invalid AI privileged rate-limit owner'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_actor_id::text || ':' || v_date::text, 0)
  );

  select coalesce(sum(preview_count), 0), coalesce(sum(execute_count), 0)
  into v_daily_preview, v_daily_execute
  from public.ai_privileged_action_rate_limits
  where clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and action_date = v_date;

  select preview_count, execute_count
  into v_conversation_preview, v_conversation_execute
  from public.ai_privileged_action_rate_limits
  where clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and conversation_id = p_conversation_id
    and action_date = v_date;

  if p_phase = 'preview' and (
    coalesce(v_conversation_preview, 0) >= 5 or v_daily_preview >= 20
  ) then return false; end if;
  if p_phase = 'execute' and (
    coalesce(v_conversation_execute, 0) >= 3 or v_daily_execute >= 10
  ) then return false; end if;

  insert into public.ai_privileged_action_rate_limits (
    clinic_id, actor_id, conversation_id, action_date,
    preview_count, execute_count
  ) values (
    p_clinic_id, p_actor_id, p_conversation_id, v_date,
    case when p_phase = 'preview' then 1 else 0 end,
    case when p_phase = 'execute' then 1 else 0 end
  )
  on conflict (clinic_id, actor_id, conversation_id, action_date)
  do update set
    preview_count = public.ai_privileged_action_rate_limits.preview_count
      + case when p_phase = 'preview' then 1 else 0 end,
    execute_count = public.ai_privileged_action_rate_limits.execute_count
      + case when p_phase = 'execute' then 1 else 0 end,
    updated_at = clock_timestamp();
  return true;
end;
$$;

-- Keep the Phase 3 non-privileged RPC signature for in-flight ordinary
-- confirmations and older clients, but make it structurally incapable of
-- consuming a privileged row.
create or replace function public.claim_ai_action_confirmation(
  p_token_hash text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_action_id text,
  p_input_digest text,
  p_consumed_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmation public.ai_action_confirmations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to claim AI action confirmations'
      using errcode = '42501';
  end if;
  update public.ai_action_confirmations
  set consumed_at = p_consumed_at
  where token_hash = p_token_hash
    and clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and conversation_id = p_conversation_id
    and action_id = p_action_id
    and input_digest = p_input_digest
    and risk_class <> 'privileged'
    and consumed_at is null
    and expires_at > p_consumed_at
  returning * into v_confirmation;
  if found then return 'claimed'; end if;
  select * into v_confirmation
  from public.ai_action_confirmations
  where token_hash = p_token_hash;
  if not found
    or v_confirmation.clinic_id <> p_clinic_id
    or v_confirmation.actor_id <> p_actor_id
    or v_confirmation.conversation_id <> p_conversation_id
    or v_confirmation.action_id <> p_action_id
    or v_confirmation.input_digest <> p_input_digest
    or v_confirmation.risk_class = 'privileged'
  then return 'invalid'; end if;
  if v_confirmation.consumed_at is not null then return 'replayed'; end if;
  if v_confirmation.expires_at <= p_consumed_at then return 'expired'; end if;
  return 'invalid';
end;
$$;

revoke all on function public.issue_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz, text, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.verify_ai_action_step_up(
  text, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.claim_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.claim_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_ai_privileged_action_rate_limit(
  uuid, uuid, uuid, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.issue_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz, text, uuid, text, text
) to service_role;
grant execute on function public.verify_ai_action_step_up(
  text, uuid, uuid, text, timestamptz
) to service_role;
grant execute on function public.claim_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid, text, text, text
) to service_role;
grant execute on function public.claim_ai_action_confirmation(
  text, uuid, uuid, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.consume_ai_privileged_action_rate_limit(
  uuid, uuid, uuid, text, timestamptz
) to service_role;
