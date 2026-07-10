-- Preserve the current single-clinic deployment's existing locale behavior.
-- New clinics still receive the P0 Arab-market defaults from 20260709091000.

update public.clinics
set
  timezone = 'Europe/Istanbul',
  currency = 'TRY',
  locale = 'en',
  country = 'TR',
  week_start = 1,
  digits = 'latin'
where created_at < timestamp with time zone '2026-07-10 00:00:00+00';
