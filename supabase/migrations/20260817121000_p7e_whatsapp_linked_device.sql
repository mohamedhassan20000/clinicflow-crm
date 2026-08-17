-- P7E — WhatsApp Linked Devices ("Connect with QR") transport, part 2 of 2.
--
-- A clinic may now connect WhatsApp by pairing ClinicFlow as a *linked device* on
-- their own phone, exactly like WhatsApp Web: no Meta app, no Cloud API, no
-- Embedded Signup, no platform Tech Provider relationship. The pairing itself is
-- run by a separate long-lived worker service (services/whatsapp-worker); this
-- migration is the durable state that worker and the Next.js app share.
--
-- Isolation model — one clinic, one device session, always:
--   * whatsapp_linked_device_sessions is keyed one row per clinic (unique
--     clinic_id), so a clinic can never hold two concurrent pairings.
--   * whatsapp_linked_device_auth stores the pairing's long-term secrets, keyed
--     by clinic. Every value is an AES-256-GCM envelope produced by the same
--     MESSAGING_CREDENTIALS_KEY boundary as clinic_channels.credentials_encrypted
--     (lib/messaging/crypto.ts), so the database — and any DB-level actor — only
--     ever sees ciphertext.
--   * Both tables carry RLS with ZERO policies, matching clinic_channels: deny-all
--     for anon and authenticated, service_role only, reached exclusively from
--     reviewed server code. Nothing here is ever read by a browser; the settings
--     page receives a collapsed status projection instead.
--   * The pre-existing global clinic_channels_whatsapp_sender_unique_idx keeps a
--     paired WhatsApp number claimable by exactly one clinic, whichever transport
--     claimed it — so clinic B cannot pair a number clinic A already holds.

-- ---------------------------------------------------------------------------
-- clinic_channels — accept the new WhatsApp transport
-- ---------------------------------------------------------------------------

alter table public.clinic_channels
  drop constraint if exists clinic_channels_provider_matches_channel;
alter table public.clinic_channels
  add constraint clinic_channels_provider_matches_channel check (
    (channel = 'whatsapp' and provider in ('dialog360', 'meta', 'linked_device'))
    or (channel = 'email' and provider = 'resend')
  );

comment on constraint clinic_channels_provider_matches_channel on public.clinic_channels is
  'P7E: WhatsApp may be carried by 360dialog, Meta Cloud API, or a per-clinic linked-device pairing.';

-- The explicit transport switch keeps exactly one active WhatsApp provider per
-- clinic; linked_device joins the set it may select.
create or replace function public.activate_whatsapp_provider(
  p_clinic_id uuid,
  p_provider public.messaging_provider
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_provider not in ('dialog360', 'meta', 'linked_device')
  then
    raise exception 'Not authorized to activate WhatsApp provider' using errcode = '42501';
  end if;

  select exists (
    select 1
      from public.clinic_channels
     where clinic_id = p_clinic_id
       and channel = 'whatsapp'
       and provider = p_provider
  ) into v_exists;
  if not v_exists then
    return false;
  end if;

  update public.clinic_channels
     set status = case when provider = p_provider then 'active' else 'pending' end
   where clinic_id = p_clinic_id
     and channel = 'whatsapp';
  return true;
end;
$$;

revoke all on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) from public, anon, authenticated;
grant execute on function public.activate_whatsapp_provider(
  uuid, public.messaging_provider
) to service_role;

-- ---------------------------------------------------------------------------
-- whatsapp_linked_device_sessions — the observable state of one clinic's pairing
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_linked_device_sessions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null unique references public.clinics(id) on delete cascade,
  -- What the clinic is shown, in the worker's own words. Deliberately coarse:
  -- no protocol detail, no provider error text.
  status text not null default 'disconnected'
    check (status in (
      'starting', 'awaiting_scan', 'connecting', 'connected', 'disconnected', 'error'
    )),
  -- The clinic's intent, independent of whether a socket happens to be up. The
  -- worker restores exactly the sessions marked 'online' after a restart, which
  -- is what makes a redeploy invisible to the clinic.
  desired_state text not null default 'offline'
    check (desired_state in ('online', 'offline')),
  -- The current pairing payload, exactly as WhatsApp issued it. Short-lived and
  -- only meaningful while status = 'awaiting_scan'; it is not a credential — it
  -- is what the QR image encodes and must reach the admin's screen to be
  -- scanned. Cleared the moment the pairing succeeds or the session ends.
  qr_payload text,
  qr_expires_at timestamptz,
  -- The paired WhatsApp number, in E.164, once known.
  phone_number text,
  -- Sanitized failure code (never raw library/provider text).
  last_error text,
  worker_id text,
  last_heartbeat_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_linked_device_sessions_desired_idx
  on public.whatsapp_linked_device_sessions (desired_state, updated_at desc);

alter table public.whatsapp_linked_device_sessions enable row level security;
-- Intentionally NO policies: deny-all for anon and authenticated.

drop trigger if exists trg_whatsapp_linked_device_sessions_updated_at
  on public.whatsapp_linked_device_sessions;
create trigger trg_whatsapp_linked_device_sessions_updated_at
  before update on public.whatsapp_linked_device_sessions
  for each row execute function public.set_updated_at();

comment on table public.whatsapp_linked_device_sessions is
  'P7E: one linked-device pairing per clinic. Non-secret status only; service_role reads it and the app returns a collapsed projection to the settings page.';

-- ---------------------------------------------------------------------------
-- whatsapp_linked_device_auth — the pairing''s encrypted long-term state
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_linked_device_auth (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Namespace of the stored item ('creds' for the device identity, otherwise the
  -- signal key category). Opaque to the database.
  key_type text not null check (length(btrim(key_type)) between 1 and 64),
  key_id text not null check (length(btrim(key_id)) between 1 and 256),
  -- AES-256-GCM envelope, same format and platform key as
  -- clinic_channels.credentials_encrypted. Never leaves the worker in plaintext.
  value_encrypted bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, key_type, key_id)
);

alter table public.whatsapp_linked_device_auth enable row level security;
-- Intentionally NO policies: deny-all for anon and authenticated.

drop trigger if exists trg_whatsapp_linked_device_auth_updated_at
  on public.whatsapp_linked_device_auth;
create trigger trg_whatsapp_linked_device_auth_updated_at
  before update on public.whatsapp_linked_device_auth
  for each row execute function public.set_updated_at();

comment on table public.whatsapp_linked_device_auth is
  'P7E: encrypted per-clinic WhatsApp linked-device authentication state. Service_role only; ciphertext at rest; never exposed to a browser.';

-- Outbound echo de-duplication needs no new index: a linked device also receives
-- the messages the clinic sends from the phone itself, including the ones
-- ClinicFlow just sent through the same session, and the pre-existing unique
-- outbound_messages_provider_message_unique_idx on (provider, provider_message_id)
-- already makes the mirror insert idempotent for this transport.
