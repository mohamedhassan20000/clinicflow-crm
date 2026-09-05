-- P7D — per-clinic manual Meta / WhatsApp Cloud API connection.
--
-- Additive only. Widens the P7C `onboarding_flow` domain with a third value so a
-- clinic that owns its *own* Meta app, business portfolio and WABA can connect
-- those credentials directly instead of going through the platform-brokered
-- Embedded Signup flows.
--
-- Why this needs its own value rather than reusing 'embedded_signup':
--   * The stored credential envelope is the *clinic's* own permanent access
--     token, app id and app secret — not the platform system-user token. The
--     webhook must therefore verify X-Hub-Signature-256 against that clinic's
--     app secret, which it decides from this column's value.
--   * Such a number is already live on the clinic's own Cloud API account, so
--     the Cloud API phone-registration step and the ClinicFlow-side template
--     approval gate must both be skipped — exactly as for 'coexistence', but
--     without the WhatsApp Business app `is_on_biz_app` rule.
--
-- Security posture is unchanged from P3A/P6C/P7C: clinic_channels carries ZERO
-- authenticated RLS policies, service_role remains the only reader, and every
-- secret stays inside the AES-256-GCM envelope in credentials_encrypted. The
-- per-clinic uniqueness guarantees are untouched — the pre-existing
-- clinic_channels_whatsapp_sender_unique_idx still makes a WhatsApp phone number
-- claimable by exactly one clinic, whichever flow claimed it.

alter table public.clinic_channels
  drop constraint if exists clinic_channels_onboarding_flow_check;
alter table public.clinic_channels
  add constraint clinic_channels_onboarding_flow_check
  check (
    onboarding_flow is null
    or onboarding_flow in ('embedded_signup', 'coexistence', 'manual_api')
  );

comment on column public.clinic_channels.onboarding_flow is
  'P7C/P7D: how the Meta channel was onboarded — embedded_signup (platform-brokered Cloud API), coexistence (WhatsApp Business app number mirrored into Cloud API), or manual_api (the clinic''s own Meta app/WABA credentials). Drives skip-registration, the webhook app-secret choice, and the connection-state gates.';
