-- AI Assistant Phase 0b: make AI entitlement feature/terms driven instead of
-- coupling the runtime resolver to a catalog slug.

alter table public.ai_commercial_terms
  add column if not exists accepted_at timestamptz;

alter table public.ai_commercial_terms
  alter column accepted_at drop default;

comment on column public.ai_commercial_terms.accepted_at is
  'Explicit per-clinic AI commercial-terms acceptance. NULL revokes every AI feature regardless of plan or override.';

-- A terms row represented an operator-entered AI agreement only for the tier
-- that could previously resolve AI features. Do not accept terms for Basic or
-- Pro clinics merely because they have an old budget row or stale overrides.
update public.ai_commercial_terms as terms
set accepted_at = coalesce(
      terms.accepted_at,
      terms.updated_at,
      terms.created_at,
      clock_timestamp()
    )
from public.subscriptions as subscription
join public.plans as plan on plan.id = subscription.plan_id
where terms.clinic_id = subscription.clinic_id
  and terms.accepted_at is null
  and plan.slug = 'pro_ai';

-- Preserve live behavior for clinics whose effective catalog/override already
-- enabled the AI umbrella. The actor is the clinic's earliest admin when one
-- exists, otherwise its earliest profile; no synthetic auth identity is made.
insert into public.ai_commercial_terms (
  clinic_id,
  included_budget_override_micros,
  addon_budget_micros,
  overage_mode,
  overage_budget_micros,
  change_reason,
  updated_by,
  accepted_at
)
select
  subscription.clinic_id,
  null,
  0,
  'hard_cap',
  0,
  'pilot',
  actor.id,
  clock_timestamp()
from public.subscriptions as subscription
join public.plans as plan on plan.id = subscription.plan_id
left join public.clinic_feature_overrides as umbrella_override
  on umbrella_override.clinic_id = subscription.clinic_id
 and umbrella_override.feature_key = 'ai_assistant'
join lateral (
  select profile.id
  from public.profiles as profile
  where profile.clinic_id = subscription.clinic_id
  order by
    case when profile.role = 'admin'::public.user_role then 0 else 1 end,
    profile.created_at,
    profile.id
  limit 1
) as actor on true
where plan.is_active
  -- This is a one-time compatibility backfill, not a runtime entitlement gate.
  -- Basic/Pro overrides were unreachable before Phase 0b and must stay so until
  -- an operator explicitly accepts AI terms for the clinic.
  and plan.slug = 'pro_ai'
  and coalesce(
    umbrella_override.enabled,
    plan.features -> 'ai_assistant' = 'true'::jsonb,
    false
  )
on conflict (clinic_id) do update
set accepted_at = coalesce(
      public.ai_commercial_terms.accepted_at,
      excluded.accepted_at
    );

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
  select exists (
    select 1
    from public.subscriptions as subscription
    join public.plans as plan on plan.id = subscription.plan_id
    join public.ai_commercial_terms as terms
      on terms.clinic_id = subscription.clinic_id
     and terms.accepted_at is not null
    left join public.clinic_feature_overrides as umbrella_override
      on umbrella_override.clinic_id = subscription.clinic_id
     and umbrella_override.feature_key = 'ai_assistant'
    left join public.clinic_feature_overrides as feature_override
      on feature_override.clinic_id = subscription.clinic_id
     and feature_override.feature_key = p_feature_key
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
      )
      and coalesce(
        umbrella_override.enabled,
        plan.features -> 'ai_assistant' = 'true'::jsonb,
        false
      )
      and (
        p_feature_key = 'ai_assistant'
        or coalesce(
          feature_override.enabled,
          plan.features -> p_feature_key = 'true'::jsonb,
          false
        )
      )
  );
$$;

revoke all on function public.effective_ai_feature(uuid, text)
  from public, anon, authenticated;
grant execute on function public.effective_ai_feature(uuid, text)
  to service_role;

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
  v_plan_credit_limit bigint;
  v_counter_limit integer := 0;
  v_terms public.ai_commercial_terms%rowtype;
begin
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'AI_BUDGET_INVALID_PERIOD';
  end if;

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
  -- zero credit configuration is an entitlement failure, never an implicit
  -- zero/unlimited fallback and never inherited from another catalog row.
  if not coalesce(v_plan_limits ? 'ai_credits_month', false)
     or coalesce(jsonb_typeof(v_plan_limits -> 'ai_credits_month'), 'null') <> 'number' then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;
  v_plan_credit_limit := (v_plan_limits ->> 'ai_credits_month')::bigint;
  if v_plan_credit_limit <= 0 then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  select coalesce(limit_snapshot, 0) into v_counter_limit
  from public.usage_counters
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = 'ai_messages'::public.usage_metric;

  select * into strict v_terms
  from public.ai_commercial_terms
  where clinic_id = p_clinic_id
    and accepted_at is not null;

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

  if total_limit_micros <= 0
     or request_limit <= 0
     or concurrency_limit <= 0 then
    raise exception 'AI_BUDGET_INVALID_COMMERCIAL_LIMITS';
  end if;
  return next;
exception
  when no_data_found then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
end;
$$;

revoke all on function public.resolve_ai_commercial_limits(uuid, date)
  from public, anon, authenticated, service_role;

-- Re-evaluate the P7 designated patient-auto QA override through the canonical
-- feature/terms resolver so this later data path no longer depends on a tier.
insert into public.clinic_feature_overrides (
  clinic_id,
  feature_key,
  enabled,
  updated_at
)
select
  subscription.clinic_id,
  'ai.patient_auto',
  true,
  clock_timestamp()
from public.subscriptions as subscription
where subscription.clinic_id = 'caf2711f-97cb-4474-a103-f9505f467087'::uuid
  and public.effective_ai_feature(subscription.clinic_id, 'ai_assistant')
on conflict (clinic_id, feature_key) do update
set enabled = excluded.enabled,
    updated_at = excluded.updated_at;
