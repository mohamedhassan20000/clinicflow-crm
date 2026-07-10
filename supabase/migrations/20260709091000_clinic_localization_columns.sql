-- P0 groundwork for per-clinic localization and timezone-safe scheduling.

alter table public.clinics
  add column if not exists timezone text not null default 'Asia/Kuwait',
  add column if not exists currency char(3) not null default 'KWD',
  add column if not exists locale text not null default 'ar',
  add column if not exists country char(2) not null default 'KW',
  add column if not exists week_start smallint not null default 6,
  add column if not exists digits text not null default 'latin';

alter table public.clinics
  drop constraint if exists clinics_week_start_check,
  add constraint clinics_week_start_check check (week_start between 0 and 6),
  drop constraint if exists clinics_digits_check,
  add constraint clinics_digits_check check (digits in ('latin', 'arabic')),
  drop constraint if exists clinics_currency_check,
  add constraint clinics_currency_check check (currency ~ '^[A-Z]{3}$'),
  drop constraint if exists clinics_country_check,
  add constraint clinics_country_check check (country ~ '^[A-Z]{2}$');
