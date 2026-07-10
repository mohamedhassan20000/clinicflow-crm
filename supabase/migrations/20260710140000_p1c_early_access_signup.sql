-- P1C: public early-access boundary, atomic clinic signup, and onboarding completion.

-- Accepted invitation history must survive clinic deletion.
alter table public.clinic_invitations
  drop constraint clinic_invitations_accepted_state;
alter table public.clinic_invitations
  add constraint clinic_invitations_accepted_state check (
    status <> 'accepted' or accepted_at is not null
  );

-- Pending invitation requests are unique by normalized email. Issued invitations
-- rotate in place, so this also prevents two simultaneously redeemable invites.
create unique index clinic_invitations_pending_email_unique_idx
  on public.clinic_invitations (lower(btrim(email)))
  where status = 'pending';

create or replace function public.platform_week_start(p_at timestamptz default current_timestamp)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('week', p_at at time zone 'UTC') at time zone 'UTC';
$$;

revoke all on function public.platform_week_start(timestamptz) from public;

create or replace function public.get_public_registration_status()
returns table (
  registration_mode public.registration_mode,
  weekly_invite_limit integer,
  accepted_clinics_this_week bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select settings.registration_mode,
         settings.weekly_invite_limit,
         count(invitation.id)::bigint
  from public.platform_settings as settings
  left join public.clinic_invitations as invitation
    on invitation.status = 'accepted'
   and invitation.accepted_at >= public.platform_week_start(current_timestamp)
   and invitation.accepted_at < public.platform_week_start(current_timestamp) + interval '7 days'
  where settings.id = true
  group by settings.registration_mode, settings.weekly_invite_limit;
$$;

revoke all on function public.get_public_registration_status() from public;
grant execute on function public.get_public_registration_status() to anon, authenticated, service_role;

create or replace function public.request_clinic_invitation(
  p_clinic_name text,
  p_owner_name text,
  p_phone text,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_email text := lower(btrim(p_email));
begin
  if length(btrim(coalesce(p_clinic_name, ''))) not between 1 and 200
     or length(btrim(coalesce(p_owner_name, ''))) not between 1 and 200
     or length(btrim(coalesce(p_phone, ''))) not between 3 and 50
     or length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_INVITATION_REQUEST' using errcode = '22023';
  end if;

  insert into public.clinic_invitations (clinic_name, owner_name, phone, email)
  values (btrim(p_clinic_name), btrim(p_owner_name), btrim(p_phone), v_email)
  on conflict (lower(btrim(email))) where status = 'pending'
  do update set updated_at = public.clinic_invitations.updated_at
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.request_clinic_invitation(text, text, text, text) from public;
revoke all on function public.request_clinic_invitation(text, text, text, text) from anon, authenticated;
grant execute on function public.request_clinic_invitation(text, text, text, text) to service_role;

create or replace function public.find_resumable_clinic_owner(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth_user.id
  from auth.users as auth_user
  left join public.profiles as profile on profile.id = auth_user.id
  where lower(btrim(auth_user.email)) = lower(btrim(p_email))
    and profile.id is null
    and auth_user.raw_user_meta_data ->> 'signup_flow' = 'clinic_owner'
  limit 1;
$$;

revoke all on function public.find_resumable_clinic_owner(text) from public;
revoke all on function public.find_resumable_clinic_owner(text) from anon, authenticated;
grant execute on function public.find_resumable_clinic_owner(text) to service_role;

create or replace function public.validate_clinic_signup(p_token_hash text default null)
returns table (
  allowed boolean,
  invitation_id uuid,
  clinic_name text,
  owner_name text,
  email text,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode public.registration_mode;
begin
  select settings.registration_mode into v_mode
  from public.platform_settings as settings where settings.id = true;

  if p_token_hash is null then
    return query select v_mode = 'open', null::uuid, null::text, null::text,
      null::text, case when v_mode = 'open' then null else 'INVITATION_REQUIRED' end;
    return;
  end if;

  return query
  select true, invitation.id, invitation.clinic_name, invitation.owner_name,
         invitation.email, null::text
  from public.clinic_invitations as invitation
  where invitation.token_hash = p_token_hash
    and invitation.status = 'pending'
    and invitation.expires_at > current_timestamp;

  if not found then
    return query select false, null::uuid, null::text, null::text, null::text,
      'INVITATION_INVALID'::text;
  end if;
end;
$$;

revoke all on function public.validate_clinic_signup(text) from public;
grant execute on function public.validate_clinic_signup(text) to anon, authenticated, service_role;

create or replace function public.create_clinic_with_owner(
  p_owner_id uuid,
  p_clinic_name text,
  p_country char(2),
  p_phone text,
  p_owner_name text,
  p_owner_email text,
  p_locale text,
  p_invitation_token_hash text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_clinic_id uuid;
  v_clinic_id uuid := gen_random_uuid();
  v_invitation_id uuid;
  v_mode public.registration_mode;
  v_plan_id uuid;
  v_coupon record;
  v_coupon_error text;
  v_country char(2) := upper(btrim(p_country));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SIGNUP_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select profile.clinic_id into v_existing_clinic_id
  from public.profiles as profile where profile.id = p_owner_id;
  if found then return v_existing_clinic_id; end if;

  if not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = p_owner_id
      and lower(auth_user.email) = lower(btrim(p_owner_email))
  ) then
    raise exception 'AUTH_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_clinic_name, ''))) not between 1 and 200
     or length(btrim(coalesce(p_owner_name, ''))) not between 1 and 200
     or length(btrim(coalesce(p_phone, ''))) not between 3 and 50
     or v_country !~ '^[A-Z]{2}$'
     or p_locale not in ('ar', 'en') then
    raise exception 'INVALID_SIGNUP_INPUT' using errcode = '22023';
  end if;

  select settings.registration_mode into v_mode
  from public.platform_settings as settings where settings.id = true;

  if p_invitation_token_hash is not null then
    update public.clinic_invitations as invitation
    set status = 'accepted', accepted_clinic_id = null,
        accepted_at = clock_timestamp(), updated_at = clock_timestamp()
    where invitation.token_hash = p_invitation_token_hash
      and invitation.status = 'pending'
      and invitation.expires_at > clock_timestamp()
      and lower(btrim(invitation.email)) = lower(btrim(p_owner_email))
    returning invitation.id into v_invitation_id;
    if v_invitation_id is null then
      raise exception 'INVITATION_INVALID' using errcode = 'P0001';
    end if;
  elsif v_mode <> 'open' then
    raise exception 'INVITATION_REQUIRED' using errcode = '42501';
  end if;

  select plan.id into v_plan_id from public.plans as plan
  where plan.slug = 'basic' and plan.is_active limit 1;
  if v_plan_id is null then raise exception 'BASIC_PLAN_NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.clinics (id, name, phone, country, locale, timezone, currency, week_start, digits)
  values (
    v_clinic_id, btrim(p_clinic_name), btrim(p_phone), v_country, p_locale,
    case v_country when 'KW' then 'Asia/Kuwait' when 'SA' then 'Asia/Riyadh'
      when 'AE' then 'Asia/Dubai' when 'EG' then 'Africa/Cairo' else 'UTC' end,
    case v_country when 'KW' then 'KWD' when 'SA' then 'SAR'
      when 'AE' then 'AED' when 'EG' then 'EGP' else 'USD' end,
    case when v_country in ('KW', 'SA', 'AE', 'EG') then 6 else 1 end,
    'latin'
  );

  insert into public.profiles (id, clinic_id, full_name, role, phone, must_change_password)
  values (p_owner_id, v_clinic_id, btrim(p_owner_name), 'admin', btrim(p_phone), false);

  insert into public.user_page_permissions (user_id, page_slug, is_visible, clinic_id)
  select p_owner_id, slug, true, v_clinic_id
  from unnest(array['dashboard','patients','appointments','followups','revenue','reports','settings']) as slug;

  insert into public.subscriptions (clinic_id, plan_id, provider, status, trial_ends_at)
  values (v_clinic_id, v_plan_id, 'manual', 'trialing', clock_timestamp() + interval '14 days');

  if v_invitation_id is not null then
    update public.clinic_invitations as invitation
    set accepted_clinic_id = v_clinic_id, updated_at = clock_timestamp()
    where invitation.id = v_invitation_id;

    for v_coupon in
      select coupon.code from public.coupons as coupon
      where coupon.invitation_id = v_invitation_id and coupon.is_active
      order by coupon.created_at, coupon.id
    loop
      begin
        perform public.redeem_coupon(v_clinic_id, v_coupon.code, v_invitation_id);
      exception
        when raise_exception then
          get stacked diagnostics v_coupon_error = message_text;
          if v_coupon_error in (
            'COUPON_INACTIVE',
            'COUPON_EXPIRED',
            'COUPON_LIMIT_REACHED'
          ) then
            raise warning 'SIGNUP_COUPON_SKIPPED invitation=% coupon=% reason=%',
              v_invitation_id, v_coupon.code, v_coupon_error;
          else
            raise;
          end if;
      end;
    end loop;
  end if;

  return v_clinic_id;
end;
$$;

revoke all on function public.create_clinic_with_owner(uuid, text, char, text, text, text, text, text) from public;
revoke all on function public.create_clinic_with_owner(uuid, text, char, text, text, text, text, text) from anon, authenticated;
grant execute on function public.create_clinic_with_owner(uuid, text, char, text, text, text, text, text) to service_role;

create or replace function public.complete_own_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v_completed_at timestamptz;
begin
  if public.auth_role() <> 'admin' then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  update public.clinics as clinic
  set onboarding_completed_at = coalesce(clinic.onboarding_completed_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where clinic.id = public.auth_clinic_id()
  returning clinic.onboarding_completed_at into v_completed_at;
  return v_completed_at;
end;
$$;

revoke all on function public.complete_own_onboarding() from public;
grant execute on function public.complete_own_onboarding() to authenticated;
