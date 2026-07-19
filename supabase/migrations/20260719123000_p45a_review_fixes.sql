-- P4.5A review fixes for databases that already applied the foundation:
--   M1: never drop provider spend when actual cost exceeds its reservation.
--   L3: derive the managed pool ceiling from the same authoritative
--       plan/counter snapshot used by increment_usage.

-- Keep the reservation's bounded actual-cost field compatible with its CHECK,
-- while reconcile_ai_budget continues to insert the complete immutable attempt
-- costs and add the complete provider-reported amount to spent_micros.
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

drop trigger if exists trg_ai_budget_reservations_clamp_actual
  on public.ai_budget_reservations;
create trigger trg_ai_budget_reservations_clamp_actual
  before insert or update of actual_cost_micros
  on public.ai_budget_reservations
  for each row execute function public.clamp_ai_reservation_actual_cost();

revoke all on function public.clamp_ai_reservation_actual_cost()
  from public, anon, authenticated, service_role;

-- Preserve the reviewed RPC signature for all existing callers. The original
-- transaction remains intact behind this wrapper; only its app-supplied pool
-- hint is replaced with the database-authoritative entitlement snapshot.
alter function public.reserve_ai_budget(
  uuid, uuid, uuid, uuid, date, text, text, text, text, text, text, text,
  text[], text, text, text, bigint, bigint, integer
) rename to reserve_ai_budget_p45a_limit_v1;

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
  v_legacy_limit integer;
  v_authoritative_budget_limit bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI_BUDGET_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_reserved_cost_micros <= 0 or p_budget_limit_micros <= 0 then
    raise exception 'AI_BUDGET_INVALID_AMOUNT';
  end if;

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

  return query
  select *
  from public.reserve_ai_budget_p45a_limit_v1(
    p_request_id,
    p_lease_token,
    p_clinic_id,
    p_actor_id,
    p_period_start,
    p_surface,
    p_persona,
    p_task,
    p_transport,
    p_expected_provider,
    p_expected_model,
    p_model_alias,
    p_fallback_model_aliases,
    p_policy_version,
    p_certification_version,
    p_privacy_policy_version,
    p_reserved_cost_micros,
    v_authoritative_budget_limit,
    p_lease_seconds
  );
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
