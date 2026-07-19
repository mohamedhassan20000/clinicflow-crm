-- P4.5A local-forward compatibility for databases that applied the reservation
-- table before the actual-cost ceiling was made explicit. Fresh databases take
-- the no-op path because the inline check already exists (under a generated
-- name); existing local databases receive an equivalent named constraint.
do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_budget_reservations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%actual_cost_micros <= reserved_cost_micros%'
  ) then
    alter table public.ai_budget_reservations
      add constraint ai_budget_reservations_actual_within_reservation_check
      check (
        actual_cost_micros is null
        or (actual_cost_micros >= 0 and actual_cost_micros <= reserved_cost_micros)
      );
  end if;
end;
$migration$;
