-- P1A: SaaS platform schema and platform-admin trust boundary.

create type public.registration_mode as enum ('invite_only', 'open');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled');
create type public.usage_metric as enum ('ai_messages', 'wa_messages', 'sms_messages', 'emails');
create type public.coupon_kind as enum ('lifetime_free', 'months_free', 'percent_discount');
create type public.clinic_invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.platform_admins pa
      where pa.user_id = auth.uid()
    );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;

create policy "platform_admins_read_self"
on public.platform_admins for select to authenticated
using (user_id = auth.uid());

create policy "platform_admins_manage_platform_admins"
on public.platform_admins for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.platform_settings (
  id boolean primary key default true check (id),
  registration_mode public.registration_mode not null default 'invite_only',
  weekly_invite_limit integer not null default 20 check (weekly_invite_limit > 0),
  invitation_expiry_days integer not null default 7 check (invitation_expiry_days between 1 and 90),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.platform_settings (id) values (true);
alter table public.platform_settings enable row level security;

create policy "platform_admins_manage_platform_settings"
on public.platform_settings for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.clinic_invitations (
  id uuid primary key default gen_random_uuid(),
  clinic_name text not null check (length(btrim(clinic_name)) between 1 and 200),
  owner_name text not null check (length(btrim(owner_name)) between 1 and 200),
  phone text not null check (length(btrim(phone)) between 3 and 50),
  email text not null check (length(btrim(email)) between 3 and 320),
  token_hash text unique,
  status public.clinic_invitation_status not null default 'pending',
  expires_at timestamptz,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_clinic_id uuid references public.clinics(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinic_invitations_token_lifecycle check (
    (token_hash is null and expires_at is null)
    or (token_hash is not null and expires_at is not null)
  ),
  constraint clinic_invitations_accepted_state check (
    status <> 'accepted'
    or (accepted_clinic_id is not null and accepted_at is not null)
  )
);

create index clinic_invitations_status_created_idx
  on public.clinic_invitations (status, created_at desc);
create index clinic_invitations_email_idx
  on public.clinic_invitations (lower(email));
create index clinic_invitations_expires_pending_idx
  on public.clinic_invitations (expires_at)
  where status = 'pending' and token_hash is not null;

alter table public.clinic_invitations enable row level security;
create policy "platform_admins_manage_clinic_invitations"
on public.clinic_invitations for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug in ('basic', 'pro', 'pro_ai')),
  name_ar text not null,
  name_en text not null,
  monthly_price_usd numeric(10,2) not null default 0 check (monthly_price_usd >= 0),
  features jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits) = 'object'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.plans (slug, name_ar, name_en, features, limits)
values
  ('basic', 'الأساسية', 'Basic',
    '{"ai_assistant":false,"whatsapp":false,"sms":false,"beta_features":false}',
    '{"ai_messages_month":0,"staff_seats":3}'),
  ('pro', 'الاحترافية', 'Pro',
    '{"ai_assistant":false,"whatsapp":true,"sms":true,"beta_features":false}',
    '{"ai_messages_month":0,"staff_seats":10}'),
  ('pro_ai', 'الاحترافية مع الذكاء الاصطناعي', 'Pro + AI',
    '{"ai_assistant":true,"whatsapp":true,"sms":true,"beta_features":true}',
    '{"ai_messages_month":1000,"staff_seats":25}');

alter table public.plans enable row level security;
create policy "clinic_members_read_active_plans"
on public.plans for select to authenticated
using (is_active and public.auth_clinic_id() is not null);
create policy "platform_admins_manage_plans"
on public.plans for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null unique references public.clinics(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  provider text not null default 'manual' check (length(btrim(provider)) > 0),
  provider_subscription_id text,
  status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz default (now() + interval '14 days'),
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_period_order check (
    current_period_end is null or current_period_start is null or current_period_end > current_period_start
  )
);

create index subscriptions_plan_status_idx on public.subscriptions (plan_id, status);
create unique index subscriptions_id_clinic_unique_idx
  on public.subscriptions (id, clinic_id);
create unique index subscriptions_provider_reference_unique_idx
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;
create index subscriptions_trialing_ends_idx on public.subscriptions (trial_ends_at)
  where status = 'trialing';
alter table public.subscriptions enable row level security;
create policy "clinic_members_read_own_subscription"
on public.subscriptions for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy "platform_admins_manage_subscriptions"
on public.subscriptions for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.usage_counters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  period_start date not null,
  metric public.usage_metric not null,
  used integer not null default 0 check (used >= 0),
  limit_snapshot integer not null check (limit_snapshot >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, period_start, metric)
);

create index usage_counters_period_metric_idx
  on public.usage_counters (period_start desc, metric);
alter table public.usage_counters enable row level security;
create policy "clinic_members_read_own_usage"
on public.usage_counters for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy "platform_admins_manage_usage"
on public.usage_counters for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  kind public.coupon_kind not null,
  months integer,
  percent integer,
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redemption_count integer not null default 0 check (redemption_count >= 0),
  clinic_id uuid references public.clinics(id) on delete cascade,
  invitation_id uuid references public.clinic_invitations(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_code_normalized check (code = upper(btrim(code)) and length(code) between 1 and 64),
  constraint coupons_assignment_scope check (clinic_id is null or invitation_id is null),
  constraint coupons_kind_values check (
    (kind = 'lifetime_free' and months is null and percent is null)
    or (kind = 'months_free' and months is not null and months > 0 and percent is null)
    or (kind = 'percent_discount' and months is null and percent is not null and percent between 1 and 100)
  ),
  constraint coupons_redemption_limit check (
    max_redemptions is null or redemption_count <= max_redemptions
  )
);

create unique index coupons_code_unique_idx on public.coupons (upper(code));
create index coupons_clinic_idx on public.coupons (clinic_id) where clinic_id is not null;
create index coupons_invitation_idx on public.coupons (invitation_id) where invitation_id is not null;
create index coupons_active_expiry_idx on public.coupons (expires_at) where is_active;
alter table public.coupons enable row level security;
create policy "platform_admins_manage_coupons"
on public.coupons for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (coupon_id, clinic_id),
  constraint coupon_redemptions_subscription_clinic_fkey
    foreign key (subscription_id, clinic_id)
    references public.subscriptions(id, clinic_id)
    on delete cascade
);

create index coupon_redemptions_clinic_redeemed_idx
  on public.coupon_redemptions (clinic_id, redeemed_at desc);
create index coupon_redemptions_subscription_idx
  on public.coupon_redemptions (subscription_id);
alter table public.coupon_redemptions enable row level security;
create policy "clinic_members_read_own_coupon_redemptions"
on public.coupon_redemptions for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy "platform_admins_manage_coupon_redemptions"
on public.coupon_redemptions for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());
create policy "clinic_members_read_assigned_coupons"
on public.coupons for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  or exists (
    select 1
    from public.coupon_redemptions redemption
    where redemption.coupon_id = coupons.id
      and redemption.clinic_id = public.auth_clinic_id()
  )
);

create table public.clinic_feature_overrides (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  feature_key text not null check (feature_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  unique (clinic_id, feature_key)
);

create index clinic_feature_overrides_feature_idx
  on public.clinic_feature_overrides (feature_key, enabled);
alter table public.clinic_feature_overrides enable row level security;
create policy "clinic_members_read_own_feature_overrides"
on public.clinic_feature_overrides for select to authenticated
using (clinic_id = public.auth_clinic_id());
create policy "platform_admins_manage_feature_overrides"
on public.clinic_feature_overrides for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

alter table public.clinics
  add column onboarding_completed_at timestamptz;

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
  v_limit_snapshot integer;
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
  into v_limit_snapshot
  from public.subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.clinic_id = p_clinic_id;

  if not found then
    raise exception 'Clinic has no subscription' using errcode = 'P0002';
  end if;

  insert into public.usage_counters (
    clinic_id, period_start, metric, used, limit_snapshot
  ) values (
    p_clinic_id, p_period_start, p_metric, p_amount, v_limit_snapshot
  )
  on conflict (clinic_id, period_start, metric)
  do update set
    used = public.usage_counters.used + excluded.used,
    updated_at = now()
  returning used into v_used;

  return v_used;
end;
$$;

revoke all on function public.increment_usage(uuid, public.usage_metric, integer, date) from public;
grant execute on function public.increment_usage(uuid, public.usage_metric, integer, date) to authenticated;
grant execute on function public.increment_usage(uuid, public.usage_metric, integer, date) to service_role;
