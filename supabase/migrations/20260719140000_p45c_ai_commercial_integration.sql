-- P4.5C: AI commercial catalog, namespaced entitlements, cost-weighted credit
-- terms, provider-mode enforcement, clinic/operator aggregate projections, and
-- billing-disposition snapshots. No payment processor or GA price is selected.

-- ---------------------------------------------------------------------------
-- Stable catalog slugs, final product names, and additive AI vocabulary
-- ---------------------------------------------------------------------------

update public.plans
set name_en = case slug
      when 'basic' then 'Basic'
      when 'pro' then 'Professional'
      when 'pro_ai' then 'Pro + AI'
    end,
    name_ar = case slug
      when 'basic' then 'الأساسية'
      when 'pro' then 'الاحترافية'
      when 'pro_ai' then 'الاحترافية مع الذكاء الاصطناعي'
    end,
    features = features || case slug
      when 'pro_ai' then jsonb_build_object(
        'ai_assistant', true,
        'ai.staff_assistant', true,
        'ai.patient_suggest', false,
        'ai.patient_auto', false,
        'ai.managed', true,
        'ai.byok', true,
        'ai.hybrid_fallback', false,
        'ai.staff_analytics', true,
        'ai.financial_insights', true,
        'ai.followup_generation', false,
        'ai.scheduling', false
      )
      else jsonb_build_object(
        'ai_assistant', false,
        'ai.staff_assistant', false,
        'ai.patient_suggest', false,
        'ai.patient_auto', false,
        'ai.managed', false,
        'ai.byok', false,
        'ai.hybrid_fallback', false,
        'ai.staff_analytics', false,
        'ai.financial_insights', false,
        'ai.followup_generation', false,
        'ai.scheduling', false
      )
    end,
    limits = limits || case slug
      when 'pro_ai' then jsonb_build_object(
        -- Bootstrap compatibility pool: 1,000 established staff turns at the
        -- current certified worst-case reservation. This is an enforcement
        -- seed, not a GA price or a promise of unlimited usage.
        'ai_credits_month', 1620000000,
        'ai_requests_month', 1000,
        'ai_messages_month', 1000,
        'ai_concurrent_requests', 4,
        'ai_turn_steps_max', 8,
        'ai_output_tokens_max', 1500
      )
      else jsonb_build_object(
        'ai_credits_month', 0,
        'ai_requests_month', 0,
        'ai_messages_month', 0,
        'ai_concurrent_requests', 0,
        'ai_turn_steps_max', 0,
        'ai_output_tokens_max', 0
      )
    end,
    updated_at = clock_timestamp()
where slug in ('basic', 'pro', 'pro_ai');

-- Manual, provider-neutral commercial terms. Amounts use the same integer
-- micro-unit as the authoritative AI cost ledger. The table stores allowance
-- policy only; it never stores card/payment data, provider keys, or PHI.
create table public.ai_commercial_terms (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  included_budget_override_micros bigint
    check (included_budget_override_micros is null or included_budget_override_micros > 0),
  addon_budget_micros bigint not null default 0 check (addon_budget_micros >= 0),
  overage_mode text not null default 'hard_cap'
    check (overage_mode in ('hard_cap', 'contracted')),
  overage_budget_micros bigint not null default 0 check (overage_budget_micros >= 0),
  change_reason text not null
    check (change_reason in ('pilot', 'prepaid_addon', 'contracted_overage', 'support_adjustment')),
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_commercial_terms_overage_shape check (
    (overage_mode = 'hard_cap' and overage_budget_micros = 0)
    or (overage_mode = 'contracted' and overage_budget_micros > 0)
  )
);

create trigger trg_ai_commercial_terms_updated_at
  before update on public.ai_commercial_terms
  for each row execute function public.set_updated_at();

alter table public.ai_commercial_terms enable row level security;
create policy "platform_admins_manage_ai_commercial_terms"
on public.ai_commercial_terms for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());
revoke all on table public.ai_commercial_terms from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_commercial_terms to service_role;
grant select, insert, update, delete on table public.ai_commercial_terms to authenticated;

alter table public.ai_budget_periods
  add column included_limit_micros bigint not null default 0
    check (included_limit_micros >= 0),
  add column addon_limit_micros bigint not null default 0
    check (addon_limit_micros >= 0),
  add column overage_limit_micros bigint not null default 0
    check (overage_limit_micros >= 0);

alter table public.ai_budget_reservations
  add column managed_billing_disposition text not null default 'managed_included'
    check (managed_billing_disposition in ('managed_included', 'managed_addon', 'managed_overage'));

alter table public.ai_usage_events
  drop constraint ai_usage_events_billing_disposition_check,
  add constraint ai_usage_events_billing_disposition_check check (
    billing_disposition in (
      'managed_included', 'managed_addon', 'managed_overage',
      'byok_provider_direct', 'nonbillable_failed'
    )
  );

-- ---------------------------------------------------------------------------
-- Authoritative commercial resolution (internal-only)
-- ---------------------------------------------------------------------------

create or replace function public.effective_ai_feature(
  p_clinic_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(override.enabled, (plan.features ->> p_feature_key)::boolean, false)
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  left join public.clinic_feature_overrides as override
    on override.clinic_id = subscription.clinic_id
   and override.feature_key = p_feature_key
  where subscription.clinic_id = p_clinic_id
    and plan.slug = 'pro_ai'
    and plan.is_active
    and (
      (subscription.status = 'trialing' and subscription.trial_ends_at > clock_timestamp())
      or (
        subscription.status = 'active'
        and (subscription.current_period_end is null or subscription.current_period_end > clock_timestamp())
      )
    );
$$;

revoke all on function public.effective_ai_feature(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.resolve_ai_commercial_limits(
  p_clinic_id uuid,
  p_period_start date
)
returns table (
  included_limit_micros bigint,
  addon_limit_micros bigint,
  overage_limit_micros bigint,
  total_limit_micros bigint,
  request_limit integer,
  concurrency_limit integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan_limits jsonb;
  v_counter_limit integer := 0;
  v_terms public.ai_commercial_terms%rowtype;
begin
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_BUDGET_INVALID_PERIOD';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.staff_assistant'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select plan.limits into v_plan_limits
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  where subscription.clinic_id = p_clinic_id
    and plan.slug = 'pro_ai'
    and plan.is_active;
  if not found then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select coalesce(limit_snapshot, 0) into v_counter_limit
  from public.usage_counters
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = 'ai_messages'::public.usage_metric;

  select * into v_terms
  from public.ai_commercial_terms
  where clinic_id = p_clinic_id;

  included_limit_micros := coalesce(
    v_terms.included_budget_override_micros,
    (v_plan_limits ->> 'ai_credits_month')::bigint,
    0
  );
  addon_limit_micros := coalesce(v_terms.addon_budget_micros, 0);
  overage_limit_micros := case
    when v_terms.overage_mode = 'contracted' then coalesce(v_terms.overage_budget_micros, 0)
    else 0
  end;
  total_limit_micros := included_limit_micros + addon_limit_micros + overage_limit_micros;
  request_limit := greatest(
    coalesce((v_plan_limits ->> 'ai_requests_month')::integer, 0),
    coalesce((v_plan_limits ->> 'ai_messages_month')::integer, 0),
    v_counter_limit
  );
  concurrency_limit := coalesce((v_plan_limits ->> 'ai_concurrent_requests')::integer, 0);

  if included_limit_micros <= 0 or total_limit_micros <= 0
     or request_limit <= 0 or concurrency_limit <= 0 then
    raise exception 'AI_BUDGET_INVALID_COMMERCIAL_LIMITS';
  end if;
  return next;
end;
$$;

revoke all on function public.resolve_ai_commercial_limits(uuid, date)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Replace the internal reservation transaction so the namespaced commercial
-- pool and concurrency limit are authoritative. The public 20-argument RPC is
-- restored below with provider-mode enforcement.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_ai_budget_p45a_limit_v1(
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
  v_limits record;
  v_stale_count integer := 0;
  v_stale_cost bigint := 0;
  v_legacy_used integer := 0;
  v_legacy_limit integer := 0;
  v_active_reservations integer := 0;
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

  select * into v_limits
  from public.resolve_ai_commercial_limits(p_clinic_id, p_period_start);
  if p_budget_limit_micros <> v_limits.total_limit_micros then
    raise exception 'AI_BUDGET_STALE_COMMERCIAL_LIMIT';
  end if;
  v_legacy_limit := v_limits.request_limit;

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

revoke all on function public.reserve_ai_budget_p45a_limit_v1(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer
) from public, anon, authenticated, service_role;

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
declare
  v_limits record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into v_limits
  from public.resolve_ai_commercial_limits(p_clinic_id, p_period_start);
  return query
  select *
  from public.reserve_ai_budget_p45a_limit_v1(
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, p_fallback_model_aliases,
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros, v_limits.total_limit_micros, p_lease_seconds
  );
end;
$$;

revoke all on function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer
) from public, anon, authenticated, service_role;

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
  v_result record;
  v_period public.ai_budget_periods%rowtype;
  v_policy_mode text;
  v_connection_healthy boolean;
  v_disposition text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
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

  select coalesce(policy.credential_mode, 'managed') into v_policy_mode
  from public.ai_clinic_provider_policies as policy
  where policy.clinic_id = p_clinic_id;
  if not found then v_policy_mode := 'managed'; end if;
  if v_policy_mode <> p_credential_mode then
    raise exception 'AI_PROVIDER_POLICY_MISMATCH' using errcode = '42501';
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

  select * into v_result
  from public.reserve_ai_budget(
    p_request_id, p_lease_token, p_clinic_id, p_actor_id, p_period_start,
    p_surface, p_persona, p_task, p_transport, p_expected_provider,
    p_expected_model, p_model_alias, p_fallback_model_aliases,
    p_policy_version, p_certification_version, p_privacy_policy_version,
    p_reserved_cost_micros, p_budget_limit_micros, p_lease_seconds
  );

  if v_result.acquired then
    select * into v_period
    from public.ai_budget_periods
    where clinic_id = p_clinic_id and period_start = p_period_start;
    v_disposition := case
      when v_period.spent_micros + v_period.reserved_micros
             <= v_period.included_limit_micros
        then 'managed_included'
      when v_period.spent_micros + v_period.reserved_micros
             <= v_period.included_limit_micros + v_period.addon_limit_micros
        then 'managed_addon'
      else 'managed_overage'
    end;
    update public.ai_budget_reservations
    set credential_mode = p_credential_mode,
        managed_billing_disposition = v_disposition
    where id = v_result.reservation_id
      and lease_token = p_lease_token
      and status = 'reserved';
    if not found then
      raise exception 'AI_BUDGET_CREDENTIAL_MODE_UPDATE_FAILED';
    end if;
  end if;

  return query select
    v_result.reservation_id,
    v_result.returned_lease_token,
    v_result.acquired,
    v_result.reservation_status,
    v_result.legacy_used,
    v_result.legacy_limit,
    v_result.reserved_cost_micros,
    v_result.budget_limit_micros,
    v_result.expires_at;
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

create or replace function public.derive_ai_usage_billing_disposition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_managed_disposition text;
begin
  if new.status <> 'success' or new.final_cost_micros = 0 then
    new.billing_disposition := 'nonbillable_failed';
    return new;
  end if;
  if new.credential_mode = 'byok_strict'
     or (new.credential_mode = 'hybrid' and new.fallback_parent_attempt_id is null) then
    new.billing_disposition := 'byok_provider_direct';
    return new;
  end if;
  select reservation.managed_billing_disposition into v_managed_disposition
  from public.ai_budget_reservations as reservation
  where reservation.id = new.reservation_id
    and reservation.clinic_id = new.clinic_id;
  if v_managed_disposition is null then
    raise exception 'AI_BUDGET_RESERVATION_NOT_FOUND' using errcode = '42501';
  end if;
  new.billing_disposition := v_managed_disposition;
  return new;
end;
$$;

revoke all on function public.derive_ai_usage_billing_disposition()
  from public, anon, authenticated, service_role;

-- Preserve P4.5B's SQL-derived hybrid split while recognizing every managed
-- commercial bucket introduced above.
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
  v_reconciled boolean;
  v_direct_cost_micros bigint;
  v_managed_cost_micros bigint;
  v_should_adjust boolean;
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
  if v_reservation.credential_mode = 'byok_strict'
     and p_managed_cost_micros <> 0 then
    raise exception 'AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN' using errcode = '42501';
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

  v_direct_cost_micros := p_actual_cost_micros - v_managed_cost_micros;
  if v_reconciled and v_should_adjust and v_direct_cost_micros > 0 then
    update public.ai_budget_periods
    set spent_micros = spent_micros - v_direct_cost_micros,
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

-- Policy writes cannot activate a provider mode that the current subscription
-- and operator-approved feature set do not permit. Managed remains writable so
-- credential revocation can always fail safely back to a non-BYOK state.
create or replace function public.enforce_ai_provider_mode_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.credential_mode = 'byok_strict'
     and not coalesce(public.effective_ai_feature(new.clinic_id, 'ai.byok'), false) then
    raise exception 'AI_PROVIDER_MODE_NOT_ENTITLED' using errcode = '42501';
  end if;
  if new.credential_mode = 'hybrid'
     and (
       not coalesce(public.effective_ai_feature(new.clinic_id, 'ai.byok'), false)
       or not coalesce(public.effective_ai_feature(new.clinic_id, 'ai.hybrid_fallback'), false)
     ) then
    raise exception 'AI_PROVIDER_MODE_NOT_ENTITLED' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_ai_provider_policy_entitlement
  before insert or update of credential_mode on public.ai_clinic_provider_policies
  for each row execute function public.enforce_ai_provider_mode_entitlement();
revoke all on function public.enforce_ai_provider_mode_entitlement()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Metadata-only operator aggregate. It reconciles period managed spend with
-- the immutable attempt ledger without returning actor ids or content.
-- ---------------------------------------------------------------------------

create or replace function public.operator_ai_usage_report(
  p_period_from date,
  p_period_to date,
  p_clinic_id uuid default null
)
returns table (
  clinic_id uuid,
  clinic_name text,
  period_start date,
  budget_limit_micros bigint,
  reserved_micros bigint,
  managed_spent_micros bigint,
  provider_cost_micros bigint,
  request_used integer,
  request_limit integer
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
  if p_period_from is null or p_period_to is null
     or p_period_from > p_period_to
     or p_period_from <> date_trunc('month', p_period_from)::date
     or p_period_to <> date_trunc('month', p_period_to)::date then
    raise exception 'AI_REPORT_INVALID_PERIOD';
  end if;

  return query
  with provider_cost as (
    select reservation.clinic_id,
           reservation.period_start,
           coalesce(sum(event.final_cost_micros), 0)::bigint as total
    from public.ai_budget_reservations as reservation
    join public.ai_usage_events as event on event.reservation_id = reservation.id
    where reservation.period_start between p_period_from and p_period_to
      and (p_clinic_id is null or reservation.clinic_id = p_clinic_id)
    group by reservation.clinic_id, reservation.period_start
  )
  select period.clinic_id,
         clinic.name,
         period.period_start,
         period.budget_limit_micros,
         period.reserved_micros,
         period.spent_micros,
         coalesce(provider_cost.total, 0),
         coalesce(counter.used, 0),
         greatest(
           coalesce(counter.limit_snapshot, 0),
           coalesce((plan.limits ->> 'ai_requests_month')::integer, 0),
           coalesce((plan.limits ->> 'ai_messages_month')::integer, 0)
         )
  from public.ai_budget_periods as period
  join public.clinics as clinic on clinic.id = period.clinic_id
  left join provider_cost
    on provider_cost.clinic_id = period.clinic_id
   and provider_cost.period_start = period.period_start
  left join public.usage_counters as counter
    on counter.clinic_id = period.clinic_id
   and counter.period_start = period.period_start
   and counter.metric = 'ai_messages'::public.usage_metric
  left join public.subscriptions as subscription on subscription.clinic_id = period.clinic_id
  left join public.plans as plan on plan.id = subscription.plan_id
  where period.period_start between p_period_from and p_period_to
    and (p_clinic_id is null or period.clinic_id = p_clinic_id)
  order by period.period_start desc, clinic.name asc;
end;
$$;

revoke all on function public.operator_ai_usage_report(date, date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.operator_ai_usage_report(date, date, uuid)
  to authenticated, service_role;

comment on table public.ai_commercial_terms is
  'P4.5C manual provider-neutral AI allowance/add-on/contracted-overage terms. Contains no payment instrument, credential, conversation content, or PHI.';
comment on function public.operator_ai_usage_report(date, date, uuid) is
  'Platform-admin-only, content-free AI usage/cost aggregate for P4.5C operations.';
