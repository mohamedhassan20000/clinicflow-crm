-- P4B review fixes: compensate atomic AI usage reservations when a streamed
-- model turn aborts or fails. The existing increment_usage RPC is the atomic
-- reservation boundary; this service-role-only inverse keeps failed turns from
-- consuming the clinic's monthly allowance.

create or replace function public.release_usage(
  p_clinic_id uuid,
  p_metric public.usage_metric,
  p_amount integer default 1,
  p_period_start date default date_trunc('month', current_date)::date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
begin
  if p_amount <= 0 then
    raise exception 'Usage release must be positive';
  end if;
  if p_clinic_id is null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to release usage for this clinic' using errcode = '42501';
  end if;

  update public.usage_counters
  set used = greatest(used - p_amount, 0),
      updated_at = clock_timestamp()
  where clinic_id = p_clinic_id
    and period_start = p_period_start
    and metric = p_metric
  returning used into v_used;

  return coalesce(v_used, 0);
end;
$$;

revoke all on function public.release_usage(uuid, public.usage_metric, integer, date)
  from public, anon, authenticated;
grant execute on function public.release_usage(uuid, public.usage_metric, integer, date)
  to service_role;
