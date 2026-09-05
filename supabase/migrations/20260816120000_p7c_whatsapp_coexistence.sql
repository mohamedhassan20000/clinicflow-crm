-- P7C — WhatsApp Business App Coexistence onboarding (Embedded Signup v4).
--
-- Additive only. Adds two non-secret operational columns to clinic_channels so the
-- existing P6C Meta transport can distinguish a *Coexistence* channel (a number that
-- stays live in the clinic's WhatsApp Business app and is mirrored into Cloud API)
-- from a standard Embedded Signup channel.
--
-- Why the distinction matters operationally:
--   * A Coexistence number is already registered with WhatsApp, so the Cloud API
--     phone-registration step (/register with a PIN) must be skipped.
--   * Its `code_verification_status` may never read VERIFIED, so the connection-state
--     machine reads `is_on_biz_app` instead before it will claim `connected`.
--   * Meta gives a 24-hour window to request the contact/history synchronization
--     after onboarding; `history_sync_requested_at` records that we did.
--
-- Security posture is unchanged from P3A/P6C: clinic_channels carries ZERO
-- authenticated RLS policies, these columns are non-secret status metadata stored
-- outside the encrypted envelope, and service_role remains the only reader.

alter table public.clinic_channels
  -- 'embedded_signup' (Cloud-API-only number) or 'coexistence' (WhatsApp Business
  -- app number mirrored into Cloud API). Null on legacy/360dialog rows.
  add column if not exists onboarding_flow text,
  -- When the post-onboarding SMB contact/history sync was requested (24h window).
  add column if not exists history_sync_requested_at timestamptz;

alter table public.clinic_channels
  drop constraint if exists clinic_channels_onboarding_flow_check;
alter table public.clinic_channels
  add constraint clinic_channels_onboarding_flow_check
  check (onboarding_flow is null or onboarding_flow in ('embedded_signup', 'coexistence'));

comment on column public.clinic_channels.onboarding_flow is
  'P7C: how the Meta channel was onboarded; drives skip-registration and the coexistence state rules.';
comment on column public.clinic_channels.history_sync_requested_at is
  'P7C: when the SMB contacts/history sync was requested after Coexistence onboarding (Meta allows 24h).';
