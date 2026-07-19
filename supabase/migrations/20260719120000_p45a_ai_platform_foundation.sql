-- P4.5A: ClinicFlow-owned AI policy accounting foundation.
--
-- This migration deliberately contains no tenant provider credentials, BYOK,
-- hybrid routing, catalog/plan mutations, operator UI, or patient AI. It adds
-- only the content-free managed-AI ledger and the transaction boundaries that
-- reserve the legacy request unit and a worst-case cost ceiling together.

-- ---------------------------------------------------------------------------
-- Monthly cost pool and durable reservations
-- ---------------------------------------------------------------------------

create table public.ai_budget_periods (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  period_start date not null,
  budget_limit_micros bigint not null check (budget_limit_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, period_start),
  check (period_start = date_trunc('month', period_start)::date)
);

create table public.ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  lease_token uuid not null,
  clinic_id uuid not null,
  actor_id uuid not null,
  period_start date not null,
  surface text not null check (length(surface) between 1 and 80),
  persona text not null check (length(persona) between 1 and 80),
  task text not null check (length(task) between 1 and 100),
  credential_mode text not null default 'managed'
    check (credential_mode = 'managed'),
  transport text not null check (length(transport) between 1 and 80),
  expected_provider text not null check (length(expected_provider) between 1 and 80),
  expected_model text not null check (length(expected_model) between 1 and 200),
  model_alias text not null check (length(model_alias) between 1 and 100),
  fallback_model_aliases text[] not null default '{}',
  policy_version text not null check (length(policy_version) between 1 and 100),
  certification_version text not null check (length(certification_version) between 1 and 100),
  privacy_policy_version text not null check (length(privacy_policy_version) between 1 and 100),
  reserved_cost_micros bigint not null check (reserved_cost_micros > 0),
  actual_cost_micros bigint check (
    actual_cost_micros is null
    or (actual_cost_micros >= 0 and actual_cost_micros <= reserved_cost_micros)
  ),
  legacy_usage_amount integer not null default 1 check (legacy_usage_amount > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'reconciled', 'released', 'expired')),
  outcome text check (outcome is null or outcome in ('success', 'failed', 'aborted', 'expired')),
  error_class text check (error_class is null or length(error_class) between 1 and 100),
  reserved_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ai_budget_reservations_period_fkey
    foreign key (clinic_id, period_start)
    references public.ai_budget_periods(clinic_id, period_start)
    on delete cascade,
  unique (clinic_id, request_id),
  unique (id, clinic_id)
);

create index ai_budget_reservations_active_idx
  on public.ai_budget_reservations (clinic_id, period_start, expires_at)
  where status = 'reserved';

-- Provider-reported spend is authoritative even if a future prompt/provider
-- behavior exceeds the conservative reservation. Keep the reservation column
-- within its declared ceiling while allowing reconciliation to book and ledger
-- the complete observed cost instead of failing and later refunding the turn.
create or replace function public.clamp_ai_reservation_actual_cost()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.actual_cost_micros is not null then
    new.actual_cost_micros := least(
      new.actual_cost_micros,
      new.reserved_cost_micros
    );
  end if;
  return new;
end;
$$;

create trigger trg_ai_budget_reservations_clamp_actual
  before insert or update of actual_cost_micros
  on public.ai_budget_reservations
  for each row execute function public.clamp_ai_reservation_actual_cost();

-- ---------------------------------------------------------------------------
-- Immutable, content-free usage/cost ledger
-- ---------------------------------------------------------------------------

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique,
  reservation_id uuid not null,
  request_id uuid not null,
  clinic_id uuid not null,
  actor_id uuid not null,
  attempt_sequence smallint not null check (attempt_sequence >= 0),
  fallback_parent_attempt_id uuid,
  surface text not null check (length(surface) between 1 and 80),
  persona text not null check (length(persona) between 1 and 80),
  task text not null check (length(task) between 1 and 100),
  credential_mode text not null check (credential_mode = 'managed'),
  transport text not null check (length(transport) between 1 and 80),
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  model_alias text not null check (length(model_alias) between 1 and 100),
  policy_version text not null check (length(policy_version) between 1 and 100),
  certification_version text not null check (length(certification_version) between 1 and 100),
  privacy_policy_version text not null check (length(privacy_policy_version) between 1 and 100),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens is null or cached_input_tokens >= 0),
  cache_write_tokens bigint check (cache_write_tokens is null or cache_write_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens is null or reasoning_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  status text not null check (status in ('success', 'failed', 'aborted', 'expired')),
  error_class text check (error_class is null or length(error_class) between 1 and 100),
  estimated_cost_micros bigint not null check (estimated_cost_micros >= 0),
  final_cost_micros bigint not null check (final_cost_micros >= 0),
  billing_disposition text not null
    check (billing_disposition in ('managed_included', 'nonbillable_failed')),
  created_at timestamptz not null default clock_timestamp(),
  constraint ai_usage_events_reservation_fkey
    foreign key (reservation_id, clinic_id)
    references public.ai_budget_reservations(id, clinic_id)
    on delete cascade,
  unique (reservation_id, attempt_sequence)
);

create index ai_usage_events_clinic_period_idx
  on public.ai_usage_events (clinic_id, created_at desc);
create index ai_usage_events_request_idx
  on public.ai_usage_events (clinic_id, request_id);

-- Application roles, including service_role, cannot mutate or directly delete
-- usage events. A tenant hard-delete may still cascade through the FK so the
-- platform can honor whole-tenant deletion obligations.
create or replace function public.prevent_ai_usage_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'AI_USAGE_EVENTS_IMMUTABLE' using errcode = '55000';
end;
$$;

create trigger trg_ai_usage_events_immutable
  before update or delete on public.ai_usage_events
  for each row execute function public.prevent_ai_usage_event_mutation();

alter table public.ai_budget_periods enable row level security;
alter table public.ai_budget_reservations enable row level security;
alter table public.ai_usage_events enable row level security;

-- P4.5A has no clinic/operator usage UI. There are intentionally no
-- authenticated policies: all three tables fail closed until P4.5C adds safe
-- aggregate projections. The reviewed server boundary uses service_role RPCs.
revoke all on table public.ai_budget_periods from public, anon, authenticated;
revoke all on table public.ai_budget_reservations from public, anon, authenticated;
revoke all on table public.ai_usage_events from public, anon, authenticated;
revoke all on function public.clamp_ai_reservation_actual_cost()
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.ai_budget_periods to service_role;
grant select, insert, update, delete on table public.ai_budget_reservations to service_role;
grant select, insert on table public.ai_usage_events to service_role;

-- ---------------------------------------------------------------------------
-- Atomic reservation: cost pool + legacy ai_messages unit in one transaction
-- ---------------------------------------------------------------------------

create or replace function public.reserve_ai_budget(
  p_request_id uuid,
  p_lease_token uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_period_start date,
  p_surface text,
  p_persona text,
  p_task text,
  p_transport text,
  p_expected_provider text,
  p_expected_model text,
  p_model_alias text,
  p_fallback_model_aliases text[],
  p_policy_version text,
  p_certification_version text,
  p_privacy_policy_version text,
  p_reserved_cost_micros bigint,
  p_budget_limit_micros bigint,
  p_lease_seconds integer
)
returns table (
  reservation_id uuid,
  returned_lease_token uuid,
  acquired boolean,
  reservation_status text,
  legacy_used integer,
  legacy_limit integer,
  reserved_cost_micros bigint,
  budget_limit_micros bigint,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_existing public.ai_budget_reservations%rowtype;
  v_created public.ai_budget_reservations%rowtype;
  v_stale public.ai_budget_reservations%rowtype;
  v_period public.ai_budget_periods%rowtype;
  v_stale_count integer := 0;
  v_stale_cost bigint := 0;
  v_legacy_used integer := 0;
  v_legacy_limit integer := 0;
  v_authoritative_budget_limit bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_request_id is null or p_lease_token is null or p_clinic_id is null or p_actor_id is null then
    raise exception 'AI_BUDGET_INVALID_ID';
  end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_BUDGET_INVALID_PERIOD';
  end if;
  if p_reserved_cost_micros <= 0 or p_budget_limit_micros <= 0 then
    raise exception 'AI_BUDGET_INVALID_AMOUNT';
  end if;
  if p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'AI_BUDGET_INVALID_LEASE';
  end if;
  if coalesce(length(btrim(p_surface)), 0) = 0
     or coalesce(length(btrim(p_persona)), 0) = 0
     or coalesce(length(btrim(p_task)), 0) = 0
     or coalesce(length(btrim(p_transport)), 0) = 0
     or coalesce(length(btrim(p_expected_provider)), 0) = 0
     or coalesce(length(btrim(p_expected_model)), 0) = 0
     or coalesce(length(btrim(p_model_alias)), 0) = 0
     or coalesce(length(btrim(p_policy_version)), 0) = 0
     or coalesce(length(btrim(p_certification_version)), 0) = 0
     or coalesce(length(btrim(p_privacy_policy_version)), 0) = 0 then
    raise exception 'AI_BUDGET_INVALID_POLICY';
  end if;

  -- Resolve the same grandfathered plan/counter limit used by increment_usage
  -- inside this transaction. The caller-supplied pool limit is retained in the
  -- signature for backward compatibility, but cannot become authoritative.
  select greatest(
      coalesce((plan.limits ->> 'ai_messages_month')::integer, 0),
      coalesce(counter.limit_snapshot, 0)
    )
  into v_legacy_limit
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  left join public.usage_counters as counter
    on counter.clinic_id = subscription.clinic_id
   and counter.period_start = p_period_start
   and counter.metric = 'ai_messages'::public.usage_metric
  where subscription.clinic_id = p_clinic_id;
  if not found then
    raise exception 'Clinic has no subscription' using errcode = 'P0002';
  end if;
  if v_legacy_limit <= 0 then
    raise exception 'USAGE_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;
  v_authoritative_budget_limit := v_legacy_limit::bigint * p_reserved_cost_micros;

  insert into public.ai_budget_periods (
    clinic_id, period_start, budget_limit_micros
  ) values (
    p_clinic_id, p_period_start, v_authoritative_budget_limit
  )
  on conflict (clinic_id, period_start) do update
  set budget_limit_micros = greatest(
        public.ai_budget_periods.budget_limit_micros,
        excluded.budget_limit_micros
      ),
      updated_at = clock_timestamp();

  select * into v_period
  from public.ai_budget_periods
  where clinic_id = p_clinic_id and period_start = p_period_start
  for update;

  -- Reclaim crashed/abandoned leases before evaluating the next request. Each
  -- stale reservation gets a content-free terminal event and releases its
  -- legacy request unit in the same transaction.
  for v_stale in
    update public.ai_budget_reservations
    set status = 'expired',
        outcome = 'expired',
        error_class = 'reservation_expired',
        actual_cost_micros = 0,
        finalized_at = clock_timestamp()
    where clinic_id = p_clinic_id
      and period_start = p_period_start
      and status = 'reserved'
      and expires_at <= clock_timestamp()
    returning *
  loop
    v_stale_count := v_stale_count + v_stale.legacy_usage_amount;
    v_stale_cost := v_stale_cost + v_stale.reserved_cost_micros;
    insert into public.ai_usage_events (
      attempt_id, reservation_id, request_id, clinic_id, actor_id,
      attempt_sequence, surface, persona, task, credential_mode, transport,
      provider, model, model_alias, policy_version, certification_version,
      privacy_policy_version, status, error_class, estimated_cost_micros,
      final_cost_micros, billing_disposition
    ) values (
      gen_random_uuid(), v_stale.id, v_stale.request_id, v_stale.clinic_id,
      v_stale.actor_id, 0, v_stale.surface, v_stale.persona, v_stale.task,
      v_stale.credential_mode, v_stale.transport, v_stale.expected_provider,
      v_stale.expected_model, v_stale.model_alias, v_stale.policy_version,
      v_stale.certification_version, v_stale.privacy_policy_version, 'expired',
      'reservation_expired', v_stale.reserved_cost_micros, 0,
      'nonbillable_failed'
    );
  end loop;

  if v_stale_cost > 0 then
    update public.ai_budget_periods
    set reserved_micros = greatest(reserved_micros - v_stale_cost, 0),
        updated_at = clock_timestamp()
    where clinic_id = p_clinic_id and period_start = p_period_start;
    perform public.release_usage(
      p_clinic_id,
      'ai_messages'::public.usage_metric,
      v_stale_count,
      p_period_start
    );
  end if;

  select * into v_existing
  from public.ai_budget_reservations
  where clinic_id = p_clinic_id and request_id = p_request_id;
  if found then
    select used, limit_snapshot into v_legacy_used, v_legacy_limit
    from public.usage_counters
    where clinic_id = p_clinic_id
      and period_start = p_period_start
      and metric = 'ai_messages'::public.usage_metric;
    return query select
      v_existing.id,
      v_existing.lease_token,
      false,
      v_existing.status,
      coalesce(v_legacy_used, 0),
      coalesce(v_legacy_limit, 0),
      v_existing.reserved_cost_micros,
      v_period.budget_limit_micros,
      v_existing.expires_at;
    return;
  end if;

  select * into v_period
  from public.ai_budget_periods
  where clinic_id = p_clinic_id and period_start = p_period_start;
  if v_period.spent_micros + v_period.reserved_micros + p_reserved_cost_micros
       > v_period.budget_limit_micros then
    raise exception 'AI_BUDGET_EXCEEDED' using errcode = 'P0001';
  end if;

  -- increment_usage resolves the authoritative plan snapshot itself. Because
  -- it runs inside this function's transaction, a later budget/insert failure
  -- rolls the legacy reservation back as well.
  v_legacy_used := public.increment_usage(
    p_clinic_id,
    'ai_messages'::public.usage_metric,
    1,
    p_period_start
  );
  select limit_snapshot into v_legacy_limit
  from public.usage_counters
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = 'ai_messages'::public.usage_metric;

  insert into public.ai_budget_reservations (
    request_id, lease_token, clinic_id, actor_id, period_start, surface,
    persona, task, transport, expected_provider, expected_model, model_alias,
    fallback_model_aliases, policy_version, certification_version,
    privacy_policy_version, reserved_cost_micros, expires_at
  ) values (
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, coalesce(p_fallback_model_aliases, '{}'),
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros,
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  ) returning * into v_created;

  update public.ai_budget_periods
  set reserved_micros = reserved_micros + p_reserved_cost_micros,
      updated_at = clock_timestamp()
  where clinic_id = p_clinic_id and period_start = p_period_start;

  return query select
    v_created.id,
    v_created.lease_token,
    true,
    v_created.status,
    v_legacy_used,
    coalesce(v_legacy_limit, 0),
    v_created.reserved_cost_micros,
    v_period.budget_limit_micros,
    v_created.expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic reconciliation: immutable attempts + pool + legacy compensation
-- ---------------------------------------------------------------------------

create or replace function public.reconcile_ai_budget(
  p_reservation_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_attempts jsonb,
  p_actual_cost_micros bigint,
  p_error_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_budget_reservations%rowtype;
  v_attempt_count integer;
  v_attempt_cost bigint;
  v_disposition text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_reservation_id is null or p_lease_token is null then
    raise exception 'AI_BUDGET_INVALID_ID';
  end if;
  if p_outcome not in ('success', 'failed', 'aborted') then
    raise exception 'AI_BUDGET_INVALID_OUTCOME';
  end if;
  if p_actual_cost_micros < 0 then
    raise exception 'AI_BUDGET_INVALID_AMOUNT';
  end if;
  if jsonb_typeof(p_attempts) is distinct from 'array'
     or jsonb_array_length(p_attempts) < 1
     or jsonb_array_length(p_attempts) > 16 then
    raise exception 'AI_BUDGET_INVALID_ATTEMPTS';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_attempts) element
    cross join lateral jsonb_object_keys(element) key
    where key not in (
      'attempt_id', 'attempt_sequence', 'fallback_parent_attempt_id',
      'provider', 'model', 'model_alias', 'input_tokens', 'output_tokens',
      'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens',
      'latency_ms', 'status', 'error_class', 'estimated_cost_micros',
      'final_cost_micros'
    )
  ) then
    raise exception 'AI_BUDGET_ATTEMPT_CONTENT_FORBIDDEN';
  end if;

  select * into v_reservation
  from public.ai_budget_reservations
  where id = p_reservation_id
  for update;
  if not found or v_reservation.lease_token <> p_lease_token then
    raise exception 'AI_BUDGET_RESERVATION_NOT_FOUND' using errcode = '42501';
  end if;
  if v_reservation.status <> 'reserved' then
    return false;
  end if;

  select count(*), coalesce(sum(attempt.final_cost_micros), 0)
    into v_attempt_count, v_attempt_cost
  from jsonb_to_recordset(p_attempts) as attempt(
    attempt_id uuid,
    attempt_sequence smallint,
    fallback_parent_attempt_id uuid,
    provider text,
    model text,
    model_alias text,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    latency_ms integer,
    status text,
    error_class text,
    estimated_cost_micros bigint,
    final_cost_micros bigint
  )
  where attempt.attempt_id is not null
    and attempt.attempt_sequence >= 0
    and coalesce(length(btrim(attempt.provider)), 0) > 0
    and coalesce(length(btrim(attempt.model)), 0) > 0
    and attempt.model_alias = v_reservation.model_alias
    and attempt.status in ('success', 'failed', 'aborted')
    and coalesce(attempt.input_tokens, 0) >= 0
    and coalesce(attempt.output_tokens, 0) >= 0
    and coalesce(attempt.cached_input_tokens, 0) >= 0
    and coalesce(attempt.cache_write_tokens, 0) >= 0
    and coalesce(attempt.reasoning_tokens, 0) >= 0
    and coalesce(attempt.latency_ms, 0) >= 0
    and attempt.estimated_cost_micros >= 0
    and attempt.final_cost_micros >= 0;

  if v_attempt_count <> jsonb_array_length(p_attempts)
     or v_attempt_cost <> p_actual_cost_micros then
    raise exception 'AI_BUDGET_INVALID_ATTEMPTS';
  end if;

  v_disposition := case
    when p_outcome = 'success' then 'managed_included'
    else 'nonbillable_failed'
  end;

  insert into public.ai_usage_events (
    attempt_id, reservation_id, request_id, clinic_id, actor_id,
    attempt_sequence, fallback_parent_attempt_id, surface, persona, task,
    credential_mode, transport, provider, model, model_alias, policy_version,
    certification_version, privacy_policy_version, input_tokens, output_tokens,
    cached_input_tokens, cache_write_tokens, reasoning_tokens, latency_ms,
    status, error_class, estimated_cost_micros, final_cost_micros,
    billing_disposition
  )
  select
    attempt.attempt_id, v_reservation.id, v_reservation.request_id,
    v_reservation.clinic_id, v_reservation.actor_id,
    attempt.attempt_sequence, attempt.fallback_parent_attempt_id,
    v_reservation.surface, v_reservation.persona, v_reservation.task,
    v_reservation.credential_mode, v_reservation.transport,
    attempt.provider, attempt.model, attempt.model_alias,
    v_reservation.policy_version, v_reservation.certification_version,
    v_reservation.privacy_policy_version, attempt.input_tokens,
    attempt.output_tokens, attempt.cached_input_tokens,
    attempt.cache_write_tokens, attempt.reasoning_tokens, attempt.latency_ms,
    attempt.status, attempt.error_class, attempt.estimated_cost_micros,
    attempt.final_cost_micros, v_disposition
  from jsonb_to_recordset(p_attempts) as attempt(
    attempt_id uuid,
    attempt_sequence smallint,
    fallback_parent_attempt_id uuid,
    provider text,
    model text,
    model_alias text,
    input_tokens bigint,
    output_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    reasoning_tokens bigint,
    latency_ms integer,
    status text,
    error_class text,
    estimated_cost_micros bigint,
    final_cost_micros bigint
  );

  update public.ai_budget_periods
  set reserved_micros = greatest(
        reserved_micros - v_reservation.reserved_cost_micros,
        0
      ),
      spent_micros = spent_micros + p_actual_cost_micros,
      updated_at = clock_timestamp()
  where clinic_id = v_reservation.clinic_id
    and period_start = v_reservation.period_start;

  update public.ai_budget_reservations
  set status = case when p_outcome = 'success' then 'reconciled' else 'released' end,
      outcome = p_outcome,
      error_class = case
        when p_error_class is null then null
        else left(p_error_class, 100)
      end,
      actual_cost_micros = p_actual_cost_micros,
      finalized_at = clock_timestamp()
  where id = v_reservation.id;

  if p_outcome <> 'success' then
    perform public.release_usage(
      v_reservation.clinic_id,
      'ai_messages'::public.usage_metric,
      v_reservation.legacy_usage_amount,
      v_reservation.period_start
    );
  end if;

  return true;
end;
$$;

revoke all on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer
) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer
) to service_role;

revoke all on function public.reconcile_ai_budget(
  uuid, uuid, text, jsonb, bigint, text
) from public, anon, authenticated;
grant execute on function public.reconcile_ai_budget(
  uuid, uuid, text, jsonb, bigint, text
) to service_role;

comment on table public.ai_usage_events is
  'P4.5A immutable, content-free AI provider-attempt usage and cost ledger. Never stores prompts, completions, tool payloads, patient ids, message bodies, or credentials.';
comment on table public.ai_budget_reservations is
  'P4.5A durable AI cost reservations; managed mode only until P4.5B adds explicit tenant credential modes.';
