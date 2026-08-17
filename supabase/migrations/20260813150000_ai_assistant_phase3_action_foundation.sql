-- Phase 3: action confirmation and receipt foundation.
--
-- Action inputs, previews, prompts, and completions are intentionally absent
-- from both tables. Only one-way digests and server-derived identifiers cross
-- this persistence boundary. Domain writes continue to use the caller's RLS
-- session; these service-role-only RPCs maintain only the confirmation and
-- audit control plane.

create table public.ai_action_confirmations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid not null,
  conversation_id uuid not null,
  action_id text not null
    check (action_id ~ '^[a-z][a-z0-9_.]{0,99}$'),
  input_digest text not null
    check (input_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint ai_action_confirmations_actor_clinic_fkey
    foreign key (actor_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  constraint ai_action_confirmations_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.agent_conversations(id, clinic_id)
    on delete cascade,
  constraint ai_action_confirmations_expiry_check
    check (expires_at > created_at),
  constraint ai_action_confirmations_consumed_check
    check (consumed_at is null or consumed_at >= created_at)
);

create index ai_action_confirmations_owner_idx
  on public.ai_action_confirmations
  (clinic_id, actor_id, conversation_id, created_at desc);

create index ai_action_confirmations_expiry_idx
  on public.ai_action_confirmations (expires_at)
  where consumed_at is null;

alter table public.ai_action_confirmations enable row level security;

-- Tokens and their one-way hashes are server control-plane state. Browsers and
-- authenticated PostgREST callers receive no table privilege or RLS policy.
revoke all on table public.ai_action_confirmations
  from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_action_confirmations
  to service_role;

comment on table public.ai_action_confirmations is
  'Server-write-only, single-use Phase 3 action confirmations. Stores only a token hash and an input digest; never action arguments or preview content.';

create table public.ai_action_receipts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid not null,
  conversation_id uuid not null,
  ai_request_id uuid,
  action_id text not null
    check (action_id ~ '^[a-z][a-z0-9_.]{0,99}$'),
  risk_class text not null
    check (risk_class in ('normal', 'sensitive', 'destructive', 'bulk', 'privileged')),
  phase text not null check (phase in ('preview', 'execute')),
  authorization_outcome text not null
    check (authorization_outcome in ('allowed', 'denied')),
  denial_reason text
    check (denial_reason is null or length(denial_reason) between 1 and 100),
  input_digest text not null
    check (input_digest ~ '^[0-9a-f]{64}$'),
  target_table text
    check (target_table is null or length(target_table) between 1 and 100),
  target_record_ids uuid[] not null default '{}'::uuid[],
  before_digest text
    check (before_digest is null or before_digest ~ '^[0-9a-f]{64}$'),
  after_digest text
    check (after_digest is null or after_digest ~ '^[0-9a-f]{64}$'),
  outcome text not null
    check (outcome in ('success', 'business_rule_refused', 'error')),
  error_code text
    check (error_code is null or length(error_code) between 1 and 100),
  created_at timestamptz not null default clock_timestamp(),
  constraint ai_action_receipts_actor_clinic_fkey
    foreign key (actor_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  constraint ai_action_receipts_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.agent_conversations(id, clinic_id)
    on delete cascade,
  constraint ai_action_receipts_authorization_check
    check (
      (authorization_outcome = 'allowed' and denial_reason is null)
      or
      (authorization_outcome = 'denied' and denial_reason is not null)
    )
);

create index ai_action_receipts_clinic_created_idx
  on public.ai_action_receipts (clinic_id, created_at desc);
create index ai_action_receipts_actor_created_idx
  on public.ai_action_receipts (clinic_id, actor_id, created_at desc);
create index ai_action_receipts_conversation_created_idx
  on public.ai_action_receipts (conversation_id, created_at desc);

alter table public.ai_action_receipts enable row level security;

create policy "ai_action_receipts_admin_manager_read"
on public.ai_action_receipts for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'manager'::public.user_role]
  )
);

revoke all on table public.ai_action_receipts
  from public, anon, authenticated;
grant select on table public.ai_action_receipts to authenticated;
grant select, insert, update, delete on table public.ai_action_receipts
  to service_role;

comment on table public.ai_action_receipts is
  'Content-free Phase 3 action-attempt ledger. Stores digests and server-derived ids, never prompts, completions, action arguments, previews, or free-text clinical data.';

create or replace function public.issue_ai_action_confirmation(
  p_token_hash text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_action_id text,
  p_input_digest text,
  p_expires_at timestamptz
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
    select 1
    from public.agent_conversations c
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id
      and c.user_id = p_actor_id
  ) then
    raise exception 'Invalid AI action confirmation owner'
      using errcode = '42501';
  end if;

  insert into public.ai_action_confirmations (
    token_hash,
    clinic_id,
    actor_id,
    conversation_id,
    action_id,
    input_digest,
    expires_at
  ) values (
    p_token_hash,
    p_clinic_id,
    p_actor_id,
    p_conversation_id,
    p_action_id,
    p_input_digest,
    p_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$$;

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
    and consumed_at is null
    and expires_at > p_consumed_at
  returning * into v_confirmation;

  if found then
    return 'claimed';
  end if;

  select * into v_confirmation
  from public.ai_action_confirmations
  where token_hash = p_token_hash;

  if not found
    or v_confirmation.clinic_id <> p_clinic_id
    or v_confirmation.actor_id <> p_actor_id
    or v_confirmation.conversation_id <> p_conversation_id
    or v_confirmation.action_id <> p_action_id
    or v_confirmation.input_digest <> p_input_digest
  then
    return 'invalid';
  end if;
  if v_confirmation.consumed_at is not null then
    return 'replayed';
  end if;
  if v_confirmation.expires_at <= p_consumed_at then
    return 'expired';
  end if;
  return 'invalid';
end;
$$;

create or replace function public.begin_ai_action_receipt(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_ai_request_id uuid,
  p_action_id text,
  p_risk_class text,
  p_phase text,
  p_input_digest text
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
    raise exception 'Not authorized to write AI action receipts'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.agent_conversations c
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id
      and c.user_id = p_actor_id
  ) then
    raise exception 'Invalid AI action receipt owner'
      using errcode = '42501';
  end if;

  insert into public.ai_action_receipts (
    clinic_id,
    actor_id,
    conversation_id,
    ai_request_id,
    action_id,
    risk_class,
    phase,
    authorization_outcome,
    denial_reason,
    input_digest,
    outcome,
    error_code
  ) values (
    p_clinic_id,
    p_actor_id,
    p_conversation_id,
    p_ai_request_id,
    p_action_id,
    p_risk_class,
    p_phase,
    'denied',
    'attempt_started',
    p_input_digest,
    'error',
    'attempt_started'
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.finalize_ai_action_receipt(
  p_receipt_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_authorization_outcome text,
  p_denial_reason text,
  p_target_table text,
  p_target_record_ids uuid[],
  p_before_digest text,
  p_after_digest text,
  p_outcome text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to finalize AI action receipts'
      using errcode = '42501';
  end if;

  update public.ai_action_receipts
  set authorization_outcome = p_authorization_outcome,
      denial_reason = p_denial_reason,
      target_table = p_target_table,
      target_record_ids = coalesce(p_target_record_ids, '{}'::uuid[]),
      before_digest = p_before_digest,
      after_digest = p_after_digest,
      outcome = p_outcome,
      error_code = p_error_code
  where id = p_receipt_id
    and clinic_id = p_clinic_id
    and actor_id = p_actor_id
    and error_code = 'attempt_started';

  return found;
end;
$$;

revoke all on function public.issue_ai_action_confirmation(text, uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claim_ai_action_confirmation(text, uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.begin_ai_action_receipt(uuid, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_ai_action_receipt(uuid, uuid, uuid, text, text, text, uuid[], text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.issue_ai_action_confirmation(text, uuid, uuid, uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.claim_ai_action_confirmation(text, uuid, uuid, uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.begin_ai_action_receipt(uuid, uuid, uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.finalize_ai_action_receipt(uuid, uuid, uuid, text, text, text, uuid[], text, text, text, text)
  to service_role;
