-- P1B correctness migration: PostgREST cannot make the multi-table coupon
-- sequence atomic, and hard usage caps must be reserved inside PostgreSQL.

create or replace function public.redeem_coupon(
  p_clinic_id uuid,
  p_code text,
  p_invitation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coupon public.coupons%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_comped_until timestamptz;
  v_effect jsonb;
begin
  if p_clinic_id is null or btrim(coalesce(p_code, '')) = '' then
    raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
    and not public.is_platform_admin()
    and public.auth_clinic_id() is distinct from p_clinic_id then
    raise exception 'COUPON_NOT_ASSIGNED' using errcode = '42501';
  end if;

  select coupon.*
  into v_coupon
  from public.coupons as coupon
  where coupon.code = upper(btrim(p_code))
  for update;

  if not found then
    raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_coupon.is_active then
    raise exception 'COUPON_INACTIVE' using errcode = 'P0001';
  end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at <= clock_timestamp() then
    raise exception 'COUPON_EXPIRED' using errcode = 'P0001';
  end if;
  if v_coupon.max_redemptions is not null
    and v_coupon.redemption_count >= v_coupon.max_redemptions then
    raise exception 'COUPON_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if v_coupon.clinic_id is not null and v_coupon.clinic_id <> p_clinic_id then
    raise exception 'COUPON_NOT_ASSIGNED' using errcode = '42501';
  end if;
  if v_coupon.invitation_id is not null then
    if p_invitation_id is distinct from v_coupon.invitation_id
      or not exists (
        select 1
        from public.clinic_invitations as invitation
        where invitation.id = v_coupon.invitation_id
          and invitation.status = 'accepted'
          and invitation.accepted_clinic_id = p_clinic_id
      ) then
      raise exception 'COUPON_NOT_ASSIGNED' using errcode = '42501';
    end if;
  end if;

  select subscription.*
  into v_subscription
  from public.subscriptions as subscription
  where subscription.clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.coupon_redemptions as redemption
    where redemption.coupon_id = v_coupon.id
      and redemption.clinic_id = p_clinic_id
  ) then
    raise exception 'COUPON_ALREADY_REDEEMED' using errcode = '23505';
  end if;

  if v_coupon.kind = 'lifetime_free' then
    update public.subscriptions as subscription
    set status = 'active',
        trial_ends_at = null,
        current_period_start = coalesce(subscription.current_period_start, clock_timestamp()),
        current_period_end = null,
        updated_at = clock_timestamp()
    where subscription.id = v_subscription.id;
    v_effect := jsonb_build_object(
      'kind', 'lifetime_free',
      'compedUntil', null,
      'discountPercent', 100
    );
  elsif v_coupon.kind = 'months_free' then
    if v_subscription.status = 'active' and v_subscription.current_period_end is null then
      -- An unbounded manual/lifetime grant is already stronger. Record the
      -- redemption without truncating it to a finite promotional period.
      v_effect := jsonb_build_object(
        'kind', 'months_free',
        'compedUntil', null,
        'discountPercent', 100
      );
    else
      v_comped_until := greatest(
        clock_timestamp(),
        coalesce(v_subscription.trial_ends_at, '-infinity'::timestamptz),
        coalesce(v_subscription.current_period_end, '-infinity'::timestamptz)
      ) + make_interval(months => v_coupon.months);
      update public.subscriptions as subscription
      set status = 'active',
          trial_ends_at = null,
          current_period_start = coalesce(subscription.current_period_start, clock_timestamp()),
          current_period_end = v_comped_until,
          updated_at = clock_timestamp()
      where subscription.id = v_subscription.id;
      v_effect := jsonb_build_object(
        'kind', 'months_free',
        'compedUntil', v_comped_until,
        'discountPercent', 100
      );
    end if;
  else
    v_effect := jsonb_build_object(
      'kind', 'percent_discount',
      'compedUntil', null,
      'discountPercent', v_coupon.percent
    );
  end if;

  insert into public.coupon_redemptions (
    coupon_id,
    clinic_id,
    subscription_id
  ) values (
    v_coupon.id,
    p_clinic_id,
    v_subscription.id
  );

  update public.coupons as coupon
  set redemption_count = coupon.redemption_count + 1,
      updated_at = clock_timestamp()
  where coupon.id = v_coupon.id;

  return v_effect;
end;
$$;

revoke all on function public.redeem_coupon(uuid, text, uuid) from public;
grant execute on function public.redeem_coupon(uuid, text, uuid) to authenticated;
grant execute on function public.redeem_coupon(uuid, text, uuid) to service_role;

create or replace function public.increment_usage(
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
  v_limit_key text;
  v_current_plan_limit integer;
  v_effective_limit integer;
  v_used integer;
begin
  if p_amount <= 0 then
    raise exception 'Usage increment must be positive';
  end if;
  if p_clinic_id is null or (
    coalesce(auth.role(), '') <> 'service_role'
    and not public.is_platform_admin()
  ) then
    raise exception 'Not authorized to increment usage for this clinic' using errcode = '42501';
  end if;

  v_limit_key := case p_metric
    when 'ai_messages' then 'ai_messages_month'
    when 'wa_messages' then 'wa_messages_month'
    when 'sms_messages' then 'sms_messages_month'
    when 'emails' then 'emails_month'
  end;

  select coalesce((plan.limits ->> v_limit_key)::integer, 0)
  into v_current_plan_limit
  from public.subscriptions as subscription
  join public.plans as plan on plan.id = subscription.plan_id
  where subscription.clinic_id = p_clinic_id;

  if not found then
    raise exception 'Clinic has no subscription' using errcode = 'P0002';
  end if;

  select greatest(v_current_plan_limit, coalesce(counter.limit_snapshot, 0))
  into v_effective_limit
  from (select 1) as seed
  left join public.usage_counters as counter
    on counter.clinic_id = p_clinic_id
   and counter.period_start = p_period_start
   and counter.metric = p_metric;

  if p_amount > v_effective_limit then
    raise exception 'USAGE_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  insert into public.usage_counters as counter (
    clinic_id, period_start, metric, used, limit_snapshot
  ) values (
    p_clinic_id, p_period_start, p_metric, p_amount, v_current_plan_limit
  )
  on conflict (clinic_id, period_start, metric)
  do update set
    used = counter.used + excluded.used,
    limit_snapshot = greatest(counter.limit_snapshot, excluded.limit_snapshot),
    updated_at = clock_timestamp()
  where counter.used + excluded.used
    <= greatest(counter.limit_snapshot, excluded.limit_snapshot)
  returning used into v_used;

  if v_used is null then
    raise exception 'USAGE_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  return v_used;
end;
$$;

revoke all on function public.increment_usage(uuid, public.usage_metric, integer, date) from public;
grant execute on function public.increment_usage(uuid, public.usage_metric, integer, date) to authenticated;
grant execute on function public.increment_usage(uuid, public.usage_metric, integer, date) to service_role;
