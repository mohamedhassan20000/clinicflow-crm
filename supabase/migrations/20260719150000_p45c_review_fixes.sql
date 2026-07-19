-- P4.5C review fixes (docs/reviews/P4.5_PHASE_REVIEW.md).
--
-- P45-R2 / P45-M2: the managed billing bucket (included / addon / overage) was
-- stamped onto the reservation at reserve time from the WORST-CASE reserved
-- cost, and the disposition trigger then copied that estimate onto the immutable
-- attempt events. Because actual provider cost is typically far below the
-- reserved ceiling, an attempt could be permanently recorded as managed_addon /
-- managed_overage even though the clinic's real cumulative spend never left the
-- included allowance (and, less often, the reverse). Period aggregates stayed
-- exact, but the per-event bucket -- the intended future invoicing evidence --
-- did not.
--
-- Fix: re-derive the bucket at reconciliation from the ACTUAL finalized managed
-- cost, correct-once, BEFORE the append-only attempt is written. The clinic
-- period is locked FOR UPDATE so concurrent reconciliations serialize and each
-- reads a consistent cumulative managed spend; the corrected bucket is written
-- to the still-mutable reservation row, and the existing BEFORE INSERT
-- disposition trigger then copies the corrected value onto the immutable event.
-- No ai_usage_events row is ever updated -- ledger immutability, historical
-- auditability, per-clinic period locking, and idempotent reconciliation are all
-- preserved. Only the first reconciliation (v_should_adjust) re-derives; an
-- idempotent retry leaves the already-written events untouched.
--
-- Invoicing contract (enforced by construction, documented for auditors):
--   * Event-level and reservation-level managed_billing_disposition are now an
--     ACTUAL-cost classification, but the single-enum-per-reservation model
--     still cannot split one reservation whose managed spend straddles a bucket
--     boundary. Therefore the SOLE source of truth for add-on / contracted-
--     overage invoicing remains the exact period aggregate: compare
--     ai_budget_periods.spent_micros against included_limit_micros /
--     addon_limit_micros / overage_limit_micros. Per-event buckets are an
--     auditable best-effort attribution, never the billed quantity.

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
  if v_reservation.credential_mode = 'byok_strict'
     and p_managed_cost_micros <> 0 then
    raise exception 'AI_BUDGET_STRICT_BYOK_MANAGED_SPEND_FORBIDDEN' using errcode = '42501';
  end if;

  -- Correct the managed bucket from the actual managed cost before any event is
  -- inserted. Lock the period so concurrent reconciliations serialize on a
  -- consistent cumulative managed spend (spent_micros is managed-only: strict/
  -- hybrid direct spend is removed below). For hybrid, p_managed_cost_micros is
  -- the caller estimate, re-derived and validated against the summed managed
  -- attempts after insertion; a mismatch rolls back the whole transaction, so it
  -- is safe to derive the bucket from it here. byok_strict has no managed event
  -- to bucket, so it is skipped.
  if v_should_adjust
     and v_reservation.credential_mode <> 'byok_strict'
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

comment on function public.reconcile_ai_budget(uuid, uuid, text, jsonb, bigint, bigint, text) is
  'P4.5C managed-cost reconciler. Re-derives the managed billing bucket from the actual finalized cost (correct-once, before the immutable attempt is written). Per-event buckets are an auditable estimate; add-on/overage invoicing must use the exact ai_budget_periods aggregates, never event bucket fields.';
