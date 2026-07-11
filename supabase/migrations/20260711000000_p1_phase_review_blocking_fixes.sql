-- P1 phase-review blockers: operator governance and coupon hardening.

drop policy if exists "platform_admins_manage_platform_admins" on public.platform_admins;
-- Provisioning is intentionally service-role-only. Authenticated platform
-- admins retain only the existing self-read policy.

create table public.platform_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (length(btrim(action)) between 1 and 120),
  target_type text not null check (length(btrim(target_type)) between 1 and 120),
  target_id text,
  clinic_id uuid references public.clinics(id) on delete set null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index platform_audit_logs_created_idx
  on public.platform_audit_logs (created_at desc);
create index platform_audit_logs_actor_created_idx
  on public.platform_audit_logs (actor_user_id, created_at desc);
create index platform_audit_logs_clinic_created_idx
  on public.platform_audit_logs (clinic_id, created_at desc)
  where clinic_id is not null;

alter table public.platform_audit_logs enable row level security;
create policy "platform_admins_read_platform_audit_logs"
on public.platform_audit_logs for select to authenticated
using (public.is_platform_admin());

create or replace function public.log_platform_audit_event(
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_clinic_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  insert into public.platform_audit_logs (
    actor_user_id, action, target_type, target_id, clinic_id, payload
  ) values (
    auth.uid(), btrim(p_action), btrim(p_target_type), p_target_id,
    p_clinic_id, coalesce(p_payload, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.log_platform_audit_event(text, text, text, uuid, jsonb) from public;
grant execute on function public.log_platform_audit_event(text, text, text, uuid, jsonb) to authenticated;

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
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_platform_admin() then
    raise exception 'COUPON_REDEMPTION_FORBIDDEN' using errcode = '42501';
  end if;
  if p_clinic_id is null or btrim(coalesce(p_code, '')) = '' then
    raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coupon.* into v_coupon from public.coupons coupon
  where coupon.code = upper(btrim(p_code)) for update;
  if not found then raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002'; end if;
  if not v_coupon.is_active then raise exception 'COUPON_INACTIVE' using errcode = 'P0001'; end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at <= clock_timestamp() then
    raise exception 'COUPON_EXPIRED' using errcode = 'P0001';
  end if;
  if v_coupon.max_redemptions is not null and v_coupon.redemption_count >= v_coupon.max_redemptions then
    raise exception 'COUPON_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if v_coupon.clinic_id is not null and v_coupon.clinic_id <> p_clinic_id then
    raise exception 'COUPON_NOT_ASSIGNED' using errcode = '42501';
  end if;
  if v_coupon.invitation_id is not null and (
    p_invitation_id is distinct from v_coupon.invitation_id or not exists (
      select 1 from public.clinic_invitations invitation
      where invitation.id = v_coupon.invitation_id and invitation.status = 'accepted'
        and invitation.accepted_clinic_id = p_clinic_id
    )
  ) then raise exception 'COUPON_NOT_ASSIGNED' using errcode = '42501'; end if;

  select subscription.* into v_subscription from public.subscriptions subscription
  where subscription.clinic_id = p_clinic_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_subscription.status = 'cancelled' then
    raise exception 'CANCELLED_SUBSCRIPTION' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.coupon_redemptions redemption
    where redemption.coupon_id = v_coupon.id and redemption.clinic_id = p_clinic_id) then
    raise exception 'COUPON_ALREADY_REDEEMED' using errcode = '23505';
  end if;

  if v_coupon.kind = 'lifetime_free' then
    update public.subscriptions set status = 'active', trial_ends_at = null,
      current_period_start = coalesce(current_period_start, clock_timestamp()),
      current_period_end = null, updated_at = clock_timestamp()
    where id = v_subscription.id;
    v_effect := jsonb_build_object('kind','lifetime_free','compedUntil',null,'discountPercent',100);
  elsif v_coupon.kind = 'months_free' then
    if v_subscription.status = 'active' and v_subscription.current_period_end is null then
      v_effect := jsonb_build_object('kind','months_free','compedUntil',null,'discountPercent',100);
    else
      v_comped_until := greatest(clock_timestamp(),
        coalesce(v_subscription.trial_ends_at, '-infinity'::timestamptz),
        coalesce(v_subscription.current_period_end, '-infinity'::timestamptz))
        + make_interval(months => v_coupon.months);
      update public.subscriptions set status = 'active', trial_ends_at = null,
        current_period_start = coalesce(current_period_start, clock_timestamp()),
        current_period_end = v_comped_until, updated_at = clock_timestamp()
      where id = v_subscription.id;
      v_effect := jsonb_build_object('kind','months_free','compedUntil',v_comped_until,'discountPercent',100);
    end if;
  else
    v_effect := jsonb_build_object('kind','percent_discount','compedUntil',null,'discountPercent',v_coupon.percent);
  end if;

  insert into public.coupon_redemptions (coupon_id, clinic_id, subscription_id)
  values (v_coupon.id, p_clinic_id, v_subscription.id);
  update public.coupons set redemption_count = redemption_count + 1,
    updated_at = clock_timestamp() where id = v_coupon.id;
  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, clinic_id, payload)
  values (auth.uid(), 'coupon.redeemed', 'coupon', v_coupon.id::text, p_clinic_id,
    jsonb_build_object('kind', v_coupon.kind, 'invitationId', p_invitation_id));
  return v_effect;
end;
$$;

revoke all on function public.redeem_coupon(uuid, text, uuid) from public;
grant execute on function public.redeem_coupon(uuid, text, uuid) to service_role;

