-- P1.5D: display-currency preference, platform FX snapshots, and conservative
-- E.164 legacy backfill. Canonical monetary columns are intentionally untouched.

alter table public.profiles
  add column if not exists display_currency text null,
  add column if not exists phone_e164_valid boolean not null default true;

alter table public.clinics add column if not exists phone_e164_valid boolean not null default true;
alter table public.patients add column if not exists phone_e164_valid boolean not null default true;
alter table public.clinic_invitations add column if not exists phone_e164_valid boolean not null default true;
alter table public.staff_invitations
  add column if not exists phone text null,
  add column if not exists phone_e164_valid boolean not null default true;

create table if not exists public.fx_rates (
  currency_code text primary key check (currency_code ~ '^[A-Z]{3}$'),
  base_currency text not null default 'USD' check (base_currency = 'USD'),
  rate numeric(24, 12) not null check (rate > 0),
  provider text not null check (provider <> ''),
  provider_timestamp timestamptz not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fx_rates enable row level security;

drop policy if exists fx_rates_authenticated_read on public.fx_rates;
create policy fx_rates_authenticated_read on public.fx_rates
  for select to authenticated using (true);

drop policy if exists fx_rates_platform_admin_write on public.fx_rates;
create policy fx_rates_platform_admin_write on public.fx_rates
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

revoke all on table public.fx_rates from anon;
grant select on table public.fx_rates to authenticated;
grant all on table public.fx_rates to service_role;

create or replace function public.normalize_legacy_phone_e164(value text, default_country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare digits text := regexp_replace(coalesce(value, ''), '[^0-9]', '', 'g');
begin
  if value is null or btrim(value) = '' then return value; end if;
  if btrim(value) ~ '^\+[1-9][0-9]{7,14}$' then return btrim(value); end if;
  if btrim(value) like '00%' and substring(digits from 3) ~ '^[1-9][0-9]{7,14}$' then
    return '+' || substring(digits from 3);
  end if;
  case upper(coalesce(default_country, ''))
    when 'KW' then if length(digits) = 8 then return '+965' || digits; end if;
    when 'EG' then if length(digits) = 11 and digits like '01%' then return '+20' || substring(digits from 2); end if;
    when 'TR' then
      if length(digits) = 11 and digits like '0%' then return '+90' || substring(digits from 2); end if;
      if length(digits) = 10 then return '+90' || digits; end if;
    when 'SA' then if length(digits) = 10 and digits like '0%' then return '+966' || substring(digits from 2); end if;
    when 'AE' then if length(digits) = 10 and digits like '0%' then return '+971' || substring(digits from 2); end if;
    when 'QA' then if length(digits) = 8 then return '+974' || digits; end if;
    when 'BH' then if length(digits) = 8 then return '+973' || digits; end if;
    when 'OM' then if length(digits) = 8 then return '+968' || digits; end if;
    else null;
  end case;
  return value;
end;
$$;

update public.clinics c set
  phone = public.normalize_legacy_phone_e164(c.phone, c.country),
  phone_e164_valid = c.phone is null or public.normalize_legacy_phone_e164(c.phone, c.country) ~ '^\+[1-9][0-9]{7,14}$';

update public.profiles p set
  phone = public.normalize_legacy_phone_e164(p.phone, c.country),
  phone_e164_valid = p.phone is null or public.normalize_legacy_phone_e164(p.phone, c.country) ~ '^\+[1-9][0-9]{7,14}$'
from public.clinics c where c.id = p.clinic_id;

-- Platform admins and other clinic-less profiles have no trustworthy country
-- context. Preserve their value; only mark already-valid E.164 as valid.
update public.profiles p set
  phone_e164_valid = p.phone is null or btrim(p.phone) = '' or btrim(p.phone) ~ '^\+[1-9][0-9]{7,14}$'
where p.clinic_id is null;

update public.patients p set
  phone = public.normalize_legacy_phone_e164(p.phone, c.country),
  phone_e164_valid = p.phone is null or public.normalize_legacy_phone_e164(p.phone, c.country) ~ '^\+[1-9][0-9]{7,14}$'
from public.clinics c where c.id = p.clinic_id;

update public.clinic_invitations i set
  phone = public.normalize_legacy_phone_e164(i.phone, coalesce(c.country, 'KW')),
  phone_e164_valid = public.normalize_legacy_phone_e164(i.phone, coalesce(c.country, 'KW')) ~ '^\+[1-9][0-9]{7,14}$'
from public.clinics c where c.id = i.accepted_clinic_id;

update public.clinic_invitations i set
  phone = public.normalize_legacy_phone_e164(i.phone, 'KW'),
  phone_e164_valid = public.normalize_legacy_phone_e164(i.phone, 'KW') ~ '^\+[1-9][0-9]{7,14}$'
where i.accepted_clinic_id is null;

update public.staff_invitations i set
  phone = public.normalize_legacy_phone_e164(i.phone, c.country),
  phone_e164_valid = i.phone is null or public.normalize_legacy_phone_e164(i.phone, c.country) ~ '^\+[1-9][0-9]{7,14}$'
from public.clinics c where c.id = i.clinic_id;

revoke all on function public.normalize_legacy_phone_e164(text, text) from public, anon, authenticated;
grant execute on function public.normalize_legacy_phone_e164(text, text) to service_role;
