-- P12: direct-Anthropic transport + per-clinic managed allowance separation.
--
-- Additive only. No already-applied migration is edited, no clinic/tenant data
-- is rewritten, and every existing security invariant is preserved: the budget
-- tables remain service-role-only, ai_usage_events remains append-only and
-- content-free, and every RPC below re-asserts `auth.role() = 'service_role'`.
--
-- Three defects from the provider audit are fixed here.
--
--   G1  Managed exhaustion required a human to switch the clinic's provider mode
--       before AI could resume. Provider resolution becomes ORDERED: a clinic
--       whose managed allowance runs out and which already has a healthy
--       Anthropic key of its own continues on that key automatically. Gated by
--       an explicit, auditable per-clinic policy flag (default on) and by the
--       same `ai.byok` entitlement a manual switch would need.
--
--   G2  BYOK turns were refused when ClinicFlow's MONETARY allowance was
--       exhausted, even though a BYOK turn spends none of it. `byok_strict`
--       reservations no longer touch the managed pool at all — not the cost
--       ceiling, not the reserved balance, not the ai_messages request unit.
--
--   G3  The ai_messages request unit was doing double duty as a fair-use cap and
--       as a commercial managed-AI allowance, so a BYOK clinic was cut off by a
--       ClinicFlow-funded number. Split explicitly:
--
--         * ai_credits_month      — MONETARY managed allowance. Managed only.
--         * ai_messages_month     — managed request units. Managed only.
--         * ai_byok_requests_month— platform fair-use/abuse ceiling for BYOK.
--         * ai_concurrent_requests— concurrency. Applies to EVERY mode, always.
--
--       BYOK is not unlimited: it keeps concurrency, the fair-use ceiling,
--       authorization, safety gates and rate limiting. It is simply no longer
--       bounded by money ClinicFlow is not spending.

-- ---------------------------------------------------------------------------
-- 1. Schema: allowance separation, fallback policy, BYOK observability
-- ---------------------------------------------------------------------------

alter table public.ai_clinic_provider_policies
  add column if not exists auto_byok_fallback_enabled boolean not null default true;

comment on column public.ai_clinic_provider_policies.auto_byok_fallback_enabled is
  'When the ClinicFlow-managed allowance is exhausted and the clinic has a healthy Anthropic credential, continue on that credential instead of denying the turn. Default on; the clinic key is only ever used for turns ClinicFlow would otherwise have refused.';

alter table public.ai_budget_periods
  add column if not exists byok_spent_micros bigint not null default 0
    check (byok_spent_micros >= 0);

comment on column public.ai_budget_periods.byok_spent_micros is
  'ClinicFlow''s internal estimate of provider cost billed DIRECTLY to the clinic (strict BYOK, and the pre-fallback leg of hybrid). Observability and audit only: it is never compared against any ClinicFlow allowance, and it is not the clinic''s provider invoice.';

alter table public.ai_budget_reservations
  add column if not exists consumes_managed_budget boolean not null default true,
  add column if not exists resolution_reason text not null default 'policy';

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_budget_reservations'::regclass
      and conname = 'ai_budget_reservations_resolution_reason_check'
  ) then
    alter table public.ai_budget_reservations
      add constraint ai_budget_reservations_resolution_reason_check
      check (resolution_reason in ('policy', 'auto_byok_fallback', 'hybrid_degraded_to_byok'));
  end if;
  -- A managed turn ALWAYS consumes the managed allowance. Encoding it as a
  -- constraint rather than a convention means no future code path can create a
  -- managed reservation that spends ClinicFlow money without reserving it.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_budget_reservations'::regclass
      and conname = 'ai_budget_reservations_managed_consumes_check'
  ) then
    alter table public.ai_budget_reservations
      add constraint ai_budget_reservations_managed_consumes_check
      check (credential_mode <> 'managed' or consumes_managed_budget);
  end if;
end;
$constraints$;

comment on column public.ai_budget_reservations.consumes_managed_budget is
  'True when this turn draws on ClinicFlow''s funded allowance (managed, and hybrid which may fall back to it). False for direct BYOK, which reserves no cost ceiling and no ai_messages request unit.';

-- The fair-use counter for BYOK turns is derived from reservations rather than
-- usage_counters, so the ai_messages counter keeps meaning exactly one thing:
-- ClinicFlow-funded requests.
create index if not exists ai_budget_reservations_byok_period_idx
  on public.ai_budget_reservations (clinic_id, period_start)
  where not consumes_managed_budget;

-- Durable per-clinic/per-period/per-threshold notification state. `notifications`
-- dedupes only while a row is UNREAD, so an admin who reads the 75% notice would
-- otherwise be re-notified on the next turn. This table is the durable record.
create table if not exists public.ai_usage_threshold_notifications (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  period_start date not null,
  threshold smallint not null check (threshold in (75, 90, 100)),
  used_percent smallint not null check (used_percent between 0 and 100),
  notified_at timestamptz not null default clock_timestamp(),
  primary key (clinic_id, period_start, threshold),
  check (period_start = date_trunc('month', period_start)::date)
);

alter table public.ai_usage_threshold_notifications enable row level security;
revoke all on table public.ai_usage_threshold_notifications from public, anon, authenticated;
grant select, insert, delete on table public.ai_usage_threshold_notifications to service_role;

comment on table public.ai_usage_threshold_notifications is
  'P12 durable dedupe for included-AI-usage threshold notices. One row per clinic/period/threshold; content-free.';

-- ---------------------------------------------------------------------------
-- 2. Catalog: an explicit BYOK fair-use ceiling, distinct from the paid pool
-- ---------------------------------------------------------------------------

-- Deliberately NOT a commercial number and deliberately far above the funded
-- request pool: this is the point at which BYOK traffic stops looking like a
-- clinic and starts looking like abuse. The funded allowance stays configurable
-- through ai_credits_month + the per-clinic override; this key is a safety rail.
update public.plans
set limits = limits || jsonb_build_object('ai_byok_requests_month', 20000),
    updated_at = clock_timestamp()
where slug = 'pro_ai'
  and coalesce((limits ->> 'ai_byok_requests_month')::integer, 0) <> 20000;

-- ---------------------------------------------------------------------------
-- 3. Commercial resolution that can serve a BYOK-only clinic
-- ---------------------------------------------------------------------------

create or replace function public.resolve_ai_commercial_limits_v2(
  p_clinic_id uuid,
  p_period_start date,
  p_require_managed_budget boolean
)
returns table (
  included_limit_micros bigint,
  addon_limit_micros bigint,
  overage_limit_micros bigint,
  total_limit_micros bigint,
  request_limit integer,
  concurrency_limit integer,
  byok_request_limit integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan_limits jsonb;
  v_plan_credit_limit bigint := 0;
  v_counter_limit integer := 0;
  v_terms public.ai_commercial_terms%rowtype;
begin
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_BUDGET_INVALID_PERIOD';
  end if;

  -- Deliberately identical to `resolve_ai_commercial_limits` (the plan-decoupled
  -- version from 20260813130000) in every entitlement respect. This function is
  -- that one plus a BYOK-aware relaxation, NOT a second commercial authority:
  -- the feature gate, the active-subscription requirement, the accepted-terms
  -- requirement and the plan-owned allowance rule are all reproduced unchanged.
  -- The only thing `p_require_managed_budget = false` removes is the demand for
  -- a non-zero pool of ClinicFlow's own money, which a BYOK turn does not spend.
  if not public.effective_ai_feature(p_clinic_id, 'ai_assistant') then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select plan.limits into v_plan_limits
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  where subscription.clinic_id = p_clinic_id
    and plan.is_active
    and (
      (
        subscription.status = 'trialing'
        and subscription.trial_ends_at > clock_timestamp()
      )
      or (
        subscription.status = 'active'
        and (
          subscription.current_period_end is null
          or subscription.current_period_end > clock_timestamp()
        )
      )
    );
  if not found then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  -- Every feature-granting plan owns its allowance. Missing, malformed, or
  -- zero credit configuration is an entitlement failure for a MANAGED turn --
  -- never an implicit zero/unlimited fallback and never inherited from another
  -- catalog row. A BYOK-only turn is exempt: it is not drawing on that pool, and
  -- refusing it for a zero pool was audit finding G2.
  if p_require_managed_budget then
    if not coalesce(v_plan_limits ? 'ai_credits_month', false)
       or coalesce(jsonb_typeof(v_plan_limits -> 'ai_credits_month'), 'null') <> 'number' then
      raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
    end if;
    v_plan_credit_limit := (v_plan_limits ->> 'ai_credits_month')::bigint;
    if v_plan_credit_limit <= 0 then
      raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
    end if;
  else
    v_plan_credit_limit := greatest(
      coalesce((v_plan_limits ->> 'ai_credits_month')::bigint, 0),
      0
    );
  end if;

  select coalesce(limit_snapshot, 0) into v_counter_limit
  from public.usage_counters
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = 'ai_messages'::public.usage_metric;

  -- Accepted commercial terms remain required in EVERY mode. BYOK changes who
  -- pays the provider; it does not remove the clinic's agreement to use
  -- ClinicFlow AI at all.
  select * into strict v_terms
  from public.ai_commercial_terms
  where clinic_id = p_clinic_id
    and accepted_at is not null;

  -- Plan default, optionally overridden per clinic by the platform owner. This
  -- is the only place an effective included allowance is computed, so the owner
  -- console and the enforcement path can never disagree about it.
  included_limit_micros := coalesce(
    v_terms.included_budget_override_micros,
    v_plan_credit_limit
  );
  addon_limit_micros := coalesce(v_terms.addon_budget_micros, 0);
  overage_limit_micros := case
    when v_terms.overage_mode = 'contracted'
      then coalesce(v_terms.overage_budget_micros, 0)
    else 0
  end;
  total_limit_micros :=
    included_limit_micros + addon_limit_micros + overage_limit_micros;
  request_limit := greatest(
    coalesce((v_plan_limits ->> 'ai_requests_month')::integer, 0),
    coalesce((v_plan_limits ->> 'ai_messages_month')::integer, 0),
    v_counter_limit
  );
  concurrency_limit := coalesce(
    (v_plan_limits ->> 'ai_concurrent_requests')::integer,
    0
  );
  byok_request_limit := coalesce(
    nullif((v_plan_limits ->> 'ai_byok_requests_month')::integer, 0),
    20000
  );

  -- Concurrency is a platform protection and is required in EVERY mode. The
  -- monetary and funded-request limits are required only when the turn is
  -- actually going to spend ClinicFlow's money: demanding a non-zero funded
  -- allowance from a BYOK-only clinic was defect G2/G3.
  if concurrency_limit <= 0 then
    raise exception 'AI_BUDGET_INVALID_COMMERCIAL_LIMITS';
  end if;
  if p_require_managed_budget
     and (total_limit_micros <= 0 or request_limit <= 0) then
    raise exception 'AI_BUDGET_INVALID_COMMERCIAL_LIMITS';
  end if;
  return next;
exception
  when no_data_found then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
end;
$$;

revoke all on function public.resolve_ai_commercial_limits_v2(uuid, date, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Reservation transaction, BYOK-aware
-- ---------------------------------------------------------------------------

create or replace function public.reserve_ai_budget_v2_internal(
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
  p_lease_seconds integer,
  p_credential_mode text,
  p_consumes_managed_budget boolean,
  p_resolution_reason text
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
  v_limits record;
  v_stale_count integer := 0;
  v_stale_cost bigint := 0;
  v_legacy_used integer := 0;
  v_legacy_limit integer := 0;
  v_active_reservations integer := 0;
  v_byok_used integer := 0;
  v_disposition text;
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
  if p_reserved_cost_micros <= 0 then
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

  select * into v_limits
  from public.resolve_ai_commercial_limits_v2(
    p_clinic_id, p_period_start, p_consumes_managed_budget
  );
  v_legacy_limit := v_limits.request_limit;

  -- The period row is created for BYOK turns too. It is the per-clinic,
  -- per-billing-period accounting anchor, and a clinic that runs entirely on its
  -- own key must still have a byok_spent_micros ledger and a reset date.
  insert into public.ai_budget_periods (
    clinic_id, period_start, budget_limit_micros,
    included_limit_micros, addon_limit_micros, overage_limit_micros
  ) values (
    p_clinic_id, p_period_start, v_limits.total_limit_micros,
    v_limits.included_limit_micros, v_limits.addon_limit_micros,
    v_limits.overage_limit_micros
  )
  on conflict (clinic_id, period_start) do update
  set budget_limit_micros = greatest(
        public.ai_budget_periods.budget_limit_micros,
        excluded.budget_limit_micros
      ),
      included_limit_micros = greatest(
        public.ai_budget_periods.included_limit_micros,
        excluded.included_limit_micros
      ),
      addon_limit_micros = greatest(
        public.ai_budget_periods.addon_limit_micros,
        excluded.addon_limit_micros
      ),
      overage_limit_micros = greatest(
        public.ai_budget_periods.overage_limit_micros,
        excluded.overage_limit_micros
      ),
      updated_at = clock_timestamp();

  select * into v_period
  from public.ai_budget_periods
  where clinic_id = p_clinic_id and period_start = p_period_start
  for update;

  -- Reclaim crashed/abandoned leases. A stale BYOK lease releases no request
  -- unit and no reserved cost, because it never claimed either.
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
    if v_stale.consumes_managed_budget then
      v_stale_count := v_stale_count + v_stale.legacy_usage_amount;
      v_stale_cost := v_stale_cost + v_stale.reserved_cost_micros;
    end if;
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
  end if;
  if v_stale_count > 0 then
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

  -- Concurrency: a platform protection, enforced identically in every mode.
  select count(*) into v_active_reservations
  from public.ai_budget_reservations
  where clinic_id = p_clinic_id
    and status = 'reserved'
    and expires_at > clock_timestamp();
  if v_active_reservations >= v_limits.concurrency_limit then
    raise exception 'AI_BUDGET_CONCURRENCY_EXCEEDED' using errcode = 'P0001';
  end if;

  select * into v_period
  from public.ai_budget_periods
  where clinic_id = p_clinic_id and period_start = p_period_start;

  if p_consumes_managed_budget then
    if v_period.spent_micros + v_period.reserved_micros + p_reserved_cost_micros
         > v_period.budget_limit_micros then
      raise exception 'AI_BUDGET_EXCEEDED' using errcode = 'P0001';
    end if;

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
  else
    -- BYOK fair use. Not money, not the funded request pool: an abuse ceiling.
    select count(*) into v_byok_used
    from public.ai_budget_reservations
    where clinic_id = p_clinic_id
      and period_start = p_period_start
      and not consumes_managed_budget;
    if v_byok_used >= v_limits.byok_request_limit then
      raise exception 'AI_FAIR_USE_LIMIT_EXCEEDED' using errcode = 'P0001';
    end if;
    select coalesce(used, 0), coalesce(limit_snapshot, 0)
    into v_legacy_used, v_legacy_limit
    from public.usage_counters
    where clinic_id = p_clinic_id
      and period_start = p_period_start
      and metric = 'ai_messages'::public.usage_metric;
  end if;

  v_disposition := case
    when not p_consumes_managed_budget then 'managed_included'
    when v_period.spent_micros + v_period.reserved_micros + p_reserved_cost_micros
           <= v_period.included_limit_micros
      then 'managed_included'
    when v_period.spent_micros + v_period.reserved_micros + p_reserved_cost_micros
           <= v_period.included_limit_micros + v_period.addon_limit_micros
      then 'managed_addon'
    else 'managed_overage'
  end;

  insert into public.ai_budget_reservations (
    request_id, lease_token, clinic_id, actor_id, period_start, surface,
    persona, task, transport, expected_provider, expected_model, model_alias,
    fallback_model_aliases, policy_version, certification_version,
    privacy_policy_version, reserved_cost_micros, expires_at, credential_mode,
    managed_billing_disposition, consumes_managed_budget, resolution_reason
  ) values (
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, coalesce(p_fallback_model_aliases, '{}'),
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros,
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    p_credential_mode, v_disposition, p_consumes_managed_budget,
    p_resolution_reason
  ) returning * into v_created;

  if p_consumes_managed_budget then
    update public.ai_budget_periods
    set reserved_micros = reserved_micros + p_reserved_cost_micros,
        updated_at = clock_timestamp()
    where clinic_id = p_clinic_id and period_start = p_period_start;
  end if;

  return query select
    v_created.id,
    v_created.lease_token,
    true,
    v_created.status,
    coalesce(v_legacy_used, 0),
    coalesce(v_legacy_limit, 0),
    v_created.reserved_cost_micros,
    v_period.budget_limit_micros,
    v_created.expires_at;
end;
$$;

revoke all on function public.reserve_ai_budget_v2_internal(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, integer, text, boolean, text
) from public, anon, authenticated, service_role;

-- Public entry point. Same 20-argument signature as P4.5C, so every existing
-- caller, wrapper and test keeps working; the ordered-resolution and BYOK rules
-- are applied inside.
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
  p_lease_seconds integer,
  p_credential_mode text
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
declare
  v_policy_mode text;
  v_auto_fallback boolean := true;
  v_connection_healthy boolean;
  v_consumes boolean;
  v_reason text := 'policy';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  -- `p_budget_limit_micros` is a backward-compatible caller HINT: the
  -- authoritative pool is re-resolved inside this transaction. It is still
  -- validated rather than ignored, so a caller passing nonsense fails loudly
  -- instead of having a silently unused argument.
  if p_budget_limit_micros <= 0 then
    raise exception 'AI_BUDGET_INVALID_AMOUNT';
  end if;
  if p_credential_mode not in ('managed', 'byok_strict', 'hybrid') then
    raise exception 'AI_BUDGET_INVALID_CREDENTIAL_MODE';
  end if;
  if p_credential_mode = 'managed'
     and not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.managed'), false) then
    raise exception 'AI_PROVIDER_MODE_NOT_ENTITLED' using errcode = '42501';
  end if;
  if p_credential_mode in ('byok_strict', 'hybrid')
     and not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.byok'), false) then
    raise exception 'AI_PROVIDER_MODE_NOT_ENTITLED' using errcode = '42501';
  end if;
  if p_credential_mode = 'hybrid'
     and not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.hybrid_fallback'), false) then
    raise exception 'AI_PROVIDER_MODE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select coalesce(policy.credential_mode, 'managed'),
         coalesce(policy.auto_byok_fallback_enabled, true)
  into v_policy_mode, v_auto_fallback
  from public.ai_clinic_provider_policies as policy
  where policy.clinic_id = p_clinic_id;
  if not found then
    v_policy_mode := 'managed';
    v_auto_fallback := true;
  end if;

  -- G1: ordered resolution. The ONLY divergence from the clinic's configured
  -- mode that is permitted is "fall back to the clinic's own key", and only in
  -- the direction that spends less of ClinicFlow's money. The reverse — a BYOK
  -- clinic silently served from the platform's key — is impossible here.
  if v_policy_mode <> p_credential_mode then
    if p_credential_mode = 'byok_strict'
       and v_policy_mode in ('managed', 'hybrid')
       and v_auto_fallback then
      v_reason := case
        when v_policy_mode = 'hybrid' then 'hybrid_degraded_to_byok'
        else 'auto_byok_fallback'
      end;
    else
      raise exception 'AI_PROVIDER_POLICY_MISMATCH' using errcode = '42501';
    end if;
  end if;

  if p_credential_mode <> 'managed' then
    select exists (
      select 1
      from public.ai_provider_connections as connection
      where connection.clinic_id = p_clinic_id
        and connection.lifecycle_status = 'active'
        and connection.health_status = 'valid'
        and connection.credential_encrypted is not null
    ) into v_connection_healthy;
    if not v_connection_healthy then
      raise exception 'AI_PROVIDER_CONNECTION_NOT_HEALTHY' using errcode = '42501';
    end if;
  end if;

  -- G2/G3. Strict BYOK draws on no ClinicFlow allowance. Hybrid still does,
  -- because its fallback leg can spend one.
  v_consumes := p_credential_mode <> 'byok_strict';

  return query
  select *
  from public.reserve_ai_budget_v2_internal(
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, p_fallback_model_aliases,
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros, p_lease_seconds, p_credential_mode, v_consumes,
    v_reason
  );
end;
$$;

revoke all on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer, text
) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Reconciliation that keeps managed and BYOK spend on separate books
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
    attempt.final_cost_micros, 'managed_included'
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

  -- The managed pool moves only for turns that reserved against it. A direct
  -- BYOK turn books its estimated provider cost to its own column, which no
  -- allowance check ever reads.
  if v_reservation.consumes_managed_budget then
    update public.ai_budget_periods
    set reserved_micros = greatest(
          reserved_micros - v_reservation.reserved_cost_micros,
          0
        ),
        spent_micros = spent_micros + p_actual_cost_micros,
        updated_at = clock_timestamp()
    where clinic_id = v_reservation.clinic_id
      and period_start = v_reservation.period_start;
  else
    update public.ai_budget_periods
    set byok_spent_micros = byok_spent_micros + p_actual_cost_micros,
        updated_at = clock_timestamp()
    where clinic_id = v_reservation.clinic_id
      and period_start = v_reservation.period_start;
  end if;

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

  if p_outcome <> 'success' and v_reservation.consumes_managed_budget then
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

revoke all on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, text)
  to service_role;

create or replace function public.reconcile_ai_budget(
  p_reservation_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_attempts jsonb,
  p_actual_cost_micros bigint,
  p_managed_cost_micros bigint,
  p_error_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_budget_reservations%rowtype;
  v_period public.ai_budget_periods%rowtype;
  v_reconciled boolean;
  v_direct_cost_micros bigint;
  v_managed_cost_micros bigint;
  v_should_adjust boolean;
  v_corrected_disposition text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_actual_cost_micros is null
     or p_managed_cost_micros is null
     or p_managed_cost_micros < 0
     or p_managed_cost_micros > p_actual_cost_micros then
    raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
  end if;

  select * into v_reservation
  from public.ai_budget_reservations
  where id = p_reservation_id
    and lease_token = p_lease_token
  for update;
  if not found then
    raise exception 'AI_BUDGET_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_should_adjust := v_reservation.status = 'reserved';

  if v_reservation.credential_mode = 'managed'
     and p_managed_cost_micros <> p_actual_cost_micros then
    raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
  end if;
  -- The invariant that makes BYOK safe to route to automatically: a strict-BYOK
  -- reservation can never book a single micro against ClinicFlow's allowance.
  if v_reservation.credential_mode = 'byok_strict'
     and p_managed_cost_micros <> 0 then
    raise exception 'AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN' using errcode = '42501';
  end if;
  if not v_reservation.consumes_managed_budget and p_managed_cost_micros <> 0 then
    raise exception 'AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN' using errcode = '42501';
  end if;

  if v_should_adjust
     and v_reservation.consumes_managed_budget
     and p_managed_cost_micros > 0 then
    select * into v_period
    from public.ai_budget_periods
    where clinic_id = v_reservation.clinic_id
      and period_start = v_reservation.period_start
    for update;
    v_corrected_disposition := case
      when v_period.spent_micros + p_managed_cost_micros
             <= v_period.included_limit_micros
        then 'managed_included'
      when v_period.spent_micros + p_managed_cost_micros
             <= v_period.included_limit_micros + v_period.addon_limit_micros
        then 'managed_addon'
      else 'managed_overage'
    end;
    if v_corrected_disposition <> v_reservation.managed_billing_disposition then
      update public.ai_budget_reservations
      set managed_billing_disposition = v_corrected_disposition
      where id = v_reservation.id
        and status = 'reserved';
    end if;
  end if;

  v_reconciled := public.reconcile_ai_budget(
    p_reservation_id,
    p_lease_token,
    p_outcome,
    p_attempts,
    p_actual_cost_micros,
    p_error_class
  );

  v_managed_cost_micros := p_managed_cost_micros;
  if v_reservation.credential_mode = 'hybrid' and v_reconciled and v_should_adjust then
    select coalesce(sum(final_cost_micros), 0)
    into v_managed_cost_micros
    from public.ai_usage_events
    where reservation_id = p_reservation_id
      and billing_disposition in ('managed_included', 'managed_addon', 'managed_overage');
    if v_managed_cost_micros <> p_managed_cost_micros then
      raise exception 'AI_BUDGET_INVALID_MANAGED_COST';
    end if;
  end if;

  -- Hybrid's pre-fallback leg was booked to the managed pool by the inner
  -- function (it reserved against it); move that portion onto the BYOK books so
  -- the two ledgers stay exact. A reservation that never consumed the managed
  -- pool has nothing to move.
  v_direct_cost_micros := p_actual_cost_micros - v_managed_cost_micros;
  if v_reconciled and v_should_adjust
     and v_reservation.consumes_managed_budget
     and v_direct_cost_micros > 0 then
    update public.ai_budget_periods
    set spent_micros = spent_micros - v_direct_cost_micros,
        byok_spent_micros = byok_spent_micros + v_direct_cost_micros,
        updated_at = clock_timestamp()
    where clinic_id = v_reservation.clinic_id
      and period_start = v_reservation.period_start
      and spent_micros >= v_direct_cost_micros;
    if not found then
      raise exception 'AI_BUDGET_MANAGED_COST_RECONCILIATION_FAILED';
    end if;
  end if;

  return v_reconciled;
end;
$$;

revoke all on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, bigint, text)
  to service_role;

-- The disposition trigger continues to classify each attempt; it now also
-- recognizes a reservation that never drew on the managed pool.
create or replace function public.derive_ai_usage_billing_disposition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_budget_reservations%rowtype;
begin
  if new.status <> 'success' or new.final_cost_micros = 0 then
    new.billing_disposition := 'nonbillable_failed';
    return new;
  end if;
  select * into v_reservation
  from public.ai_budget_reservations as reservation
  where reservation.id = new.reservation_id
    and reservation.clinic_id = new.clinic_id;
  if not found then
    raise exception 'AI_BUDGET_RESERVATION_NOT_FOUND' using errcode = '42501';
  end if;
  if not v_reservation.consumes_managed_budget
     or new.credential_mode = 'byok_strict'
     or (new.credential_mode = 'hybrid' and new.fallback_parent_attempt_id is null) then
    new.billing_disposition := 'byok_provider_direct';
    return new;
  end if;
  new.billing_disposition := v_reservation.managed_billing_disposition;
  return new;
end;
$$;

revoke all on function public.derive_ai_usage_billing_disposition()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Threshold-notification claim (durable, idempotent, content-free)
-- ---------------------------------------------------------------------------

create or replace function public.claim_ai_usage_threshold_notice(
  p_clinic_id uuid,
  p_period_start date,
  p_threshold smallint,
  p_used_percent smallint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_threshold not in (75, 90, 100) then
    raise exception 'AI_USAGE_INVALID_THRESHOLD';
  end if;
  insert into public.ai_usage_threshold_notifications (
    clinic_id, period_start, threshold, used_percent
  ) values (
    p_clinic_id, p_period_start, p_threshold, least(greatest(p_used_percent, 0), 100)
  )
  on conflict (clinic_id, period_start, threshold) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.claim_ai_usage_threshold_notice(uuid, date, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.claim_ai_usage_threshold_notice(uuid, date, smallint, smallint)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Platform-owner allowance console
-- ---------------------------------------------------------------------------

create or replace function public.operator_ai_allowance_report(
  p_period_start date,
  p_clinic_id uuid default null
)
returns table (
  clinic_id uuid,
  clinic_name text,
  plan_slug text,
  plan_included_micros bigint,
  override_included_micros bigint,
  effective_included_micros bigint,
  addon_micros bigint,
  overage_micros bigint,
  total_allowance_micros bigint,
  managed_spent_micros bigint,
  managed_reserved_micros bigint,
  remaining_micros bigint,
  used_percent integer,
  byok_spent_micros bigint,
  request_used integer,
  request_limit integer,
  period_start date,
  period_reset_at date,
  credential_mode text,
  byok_configured boolean,
  auto_byok_fallback_enabled boolean,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_platform_admin() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_period_start is null
     or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_REPORT_INVALID_PERIOD';
  end if;

  return query
  with base as (
    select
      clinic.id as clinic_id,
      clinic.name as clinic_name,
      plan.slug as plan_slug,
      coalesce((plan.limits ->> 'ai_credits_month')::bigint, 0) as plan_included,
      terms.included_budget_override_micros as override_included,
      coalesce(terms.addon_budget_micros, 0) as addon,
      case
        when terms.overage_mode = 'contracted' then coalesce(terms.overage_budget_micros, 0)
        else 0
      end as overage,
      coalesce(period.spent_micros, 0) as spent,
      coalesce(period.reserved_micros, 0) as reserved,
      coalesce(period.byok_spent_micros, 0) as byok_spent,
      coalesce(counter.used, 0) as request_used,
      greatest(
        coalesce(counter.limit_snapshot, 0),
        coalesce((plan.limits ->> 'ai_requests_month')::integer, 0),
        coalesce((plan.limits ->> 'ai_messages_month')::integer, 0)
      ) as request_limit,
      coalesce(policy.credential_mode, 'managed') as credential_mode,
      coalesce(policy.auto_byok_fallback_enabled, true) as auto_fallback,
      exists (
        select 1
        from public.ai_provider_connections as connection
        where connection.clinic_id = clinic.id
          and connection.lifecycle_status = 'active'
          and connection.health_status = 'valid'
      ) as byok_configured
    from public.clinics as clinic
    join public.subscriptions as subscription on subscription.clinic_id = clinic.id
    join public.plans as plan on plan.id = subscription.plan_id
    left join public.ai_commercial_terms as terms on terms.clinic_id = clinic.id
    left join public.ai_budget_periods as period
      on period.clinic_id = clinic.id and period.period_start = p_period_start
    left join public.usage_counters as counter
      on counter.clinic_id = clinic.id
     and counter.period_start = p_period_start
     and counter.metric = 'ai_messages'::public.usage_metric
    left join public.ai_clinic_provider_policies as policy on policy.clinic_id = clinic.id
    where coalesce((plan.features ->> 'ai_assistant')::boolean, false)
      and (p_clinic_id is null or clinic.id = p_clinic_id)
  ),
  resolved as (
    select base.*,
           coalesce(base.override_included, base.plan_included) as effective_included
    from base
  ),
  totals as (
    select resolved.*,
           resolved.effective_included + resolved.addon + resolved.overage as total_allowance,
           resolved.spent + resolved.reserved as committed
    from resolved
  )
  select
    totals.clinic_id,
    totals.clinic_name,
    totals.plan_slug,
    totals.plan_included,
    totals.override_included,
    totals.effective_included,
    totals.addon,
    totals.overage,
    totals.total_allowance,
    totals.spent,
    totals.reserved,
    greatest(totals.total_allowance - totals.committed, 0),
    case
      when totals.total_allowance <= 0 then 0
      else least(100, floor((totals.committed::numeric / totals.total_allowance) * 100)::integer)
    end,
    totals.byok_spent,
    totals.request_used,
    totals.request_limit,
    p_period_start,
    (p_period_start + interval '1 month')::date,
    totals.credential_mode,
    totals.byok_configured,
    totals.auto_fallback,
    case
      when totals.credential_mode = 'byok_strict' then 'byok'
      when totals.total_allowance <= 0 then 'unconfigured'
      when totals.committed >= totals.total_allowance then 'exhausted'
      when totals.committed::numeric / totals.total_allowance >= 0.90 then 'critical'
      when totals.committed::numeric / totals.total_allowance >= 0.75 then 'warning'
      else 'healthy'
    end
  from totals
  order by totals.clinic_name asc;
end;
$$;

revoke all on function public.operator_ai_allowance_report(date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.operator_ai_allowance_report(date, uuid)
  to authenticated, service_role;

comment on function public.operator_ai_allowance_report(date, uuid) is
  'P12 platform-admin-only allowance console source. Plan default + optional per-clinic override, effective allowance, managed usage/reserved/remaining/percent, BYOK spend, reset date, provider mode and status. Content-free: no actor ids, prompts, or credentials.';

-- ---------------------------------------------------------------------------
-- 8. Clinic control over the automatic fallback
-- ---------------------------------------------------------------------------
--
-- The fallback defaults ON because the alternative default — AI silently
-- stopping mid-conversation for a clinic that already configured a working key
-- — is the worse failure. But the clinic is the one whose provider account pays
-- for it, so it must be able to say no, and the change must be audited like
-- every other provider-policy change.

create or replace function public.set_ai_auto_byok_fallback(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_PROVIDER_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_clinic_id is null or p_actor_id is null or p_enabled is null then
    raise exception 'AI_PROVIDER_INVALID_MODE';
  end if;

  insert into public.ai_clinic_provider_policies (
    clinic_id, credential_mode, provider, updated_by, auto_byok_fallback_enabled
  ) values (
    p_clinic_id, 'managed', null, p_actor_id, p_enabled
  )
  on conflict (clinic_id) do update
  set auto_byok_fallback_enabled = excluded.auto_byok_fallback_enabled,
      updated_by = excluded.updated_by,
      updated_at = clock_timestamp()
  returning auto_byok_fallback_enabled into v_previous;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, old_data, new_data
  ) values (
    p_actor_id,
    p_clinic_id,
    'AI_PROVIDER_AUTO_FALLBACK_CHANGED',
    'ai_clinic_provider_policies',
    p_clinic_id,
    null,
    jsonb_build_object('auto_byok_fallback_enabled', p_enabled)
  );

  return v_previous;
end;
$$;

revoke all on function public.set_ai_auto_byok_fallback(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_ai_auto_byok_fallback(uuid, uuid, boolean)
  to service_role;
