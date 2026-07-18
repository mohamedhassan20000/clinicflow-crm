-- P3D event-driven notifications + messaging flow (2026-07-18 direction,
-- refined 2026-07-19). Single migration for the whole flow — this work was
-- never shipped, so the intermediate daily-reminder lease RPCs (an earlier
-- 2026-07-18 idea, superseded before commit by the per-channel
-- message_dispatches ledger) are simply not created here.
--
--   * clinics.reminders_enabled     — daily appointment-reminder on/off (§7.2b)
--   * clinics.invoice_followup_*     — per-clinic overdue-invoice reminder config
--                                      (enable, first/second days, email copy)
--   * message_dispatches            — per (clinic, logical message, channel)
--     idempotency ledger. Email and WhatsApp are independent channels: each is
--     claimed, sent, and finalized separately, so a duplicate is never sent and
--     a failed channel retries without touching the channel that succeeded
--     (§7.6a).
--   * list_daily_reminder_candidates — confirmed appointments for today/tomorrow
--     in the clinic's local calendar; idempotency lives in message_dispatches,
--     so no per-appointment lease filter is needed here.
--
-- Trust boundaries: message_dispatches is cron/server-code-only — RLS enabled
-- with no policies (followup_sequences precedent). Every RPC is SECURITY
-- DEFINER, search_path-pinned, and executable only by service_role.

-- ---------------------------------------------------------------------------
-- clinics.reminders_enabled — daily reminder on/off (§7.2b)
-- ---------------------------------------------------------------------------

alter table public.clinics
  add column reminders_enabled boolean not null default true;

comment on column public.clinics.reminders_enabled is
  'When true, the daily morning cron sends WhatsApp+Email reminders for this '
  'clinic''s confirmed appointments scheduled today and tomorrow (§7.2b).';

-- ---------------------------------------------------------------------------
-- Per-clinic overdue-invoice reminder configuration (§7.3b, configurable)
-- ---------------------------------------------------------------------------

alter table public.clinics
  add column invoice_followups_enabled boolean not null default true,
  add column invoice_followup_first_days integer not null default 3
    check (invoice_followup_first_days between 1 and 365),
  add column invoice_followup_second_days integer not null default 7
    check (invoice_followup_second_days between 1 and 365),
  add column invoice_followup_email_subject text
    check (invoice_followup_email_subject is null
           or length(invoice_followup_email_subject) between 1 and 200),
  add column invoice_followup_email_body text
    check (invoice_followup_email_body is null
           or length(invoice_followup_email_body) between 1 and 2000);

comment on column public.clinics.invoice_followups_enabled is
  'When true, the daily cron sends overdue-invoice reminders for unpaid balances (§7.3b).';

-- ---------------------------------------------------------------------------
-- message_dispatches — per-channel idempotency ledger (§7.6a)
--
-- Lifecycle per (clinic, dedupe_key, channel):
--   claim    → status 'claimed'  (lease; blocks concurrent + duplicate sends)
--   finalize → status 'sent'     (terminal; only after provider acceptance)
--   release  → status 'failed'   (retryable; the next run reclaims and resends)
-- A 'claimed' row older than the 15-minute lease is re-claimable, so a crash
-- between claim and dispatch never permanently suppresses a message.
-- ---------------------------------------------------------------------------

create table public.message_dispatches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Logical message identity, e.g. 'appointment:confirmed:<id>',
  -- 'appointment_reminder:<id>', 'invoice:<id>', 'invoice_followup:<id>:step1'.
  dedupe_key text not null check (length(btrim(dedupe_key)) between 1 and 200),
  channel public.message_channel not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  claimed_at timestamptz,
  sent_at timestamptz,
  outbound_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, dedupe_key, channel)
);

create index message_dispatches_clinic_idx
  on public.message_dispatches (clinic_id, status);

alter table public.message_dispatches enable row level security;
-- Intentionally NO policies: cron/server-code state only (followup_sequences precedent).

create trigger trg_message_dispatches_updated_at
  before update on public.message_dispatches
  for each row execute function public.set_updated_at();

create or replace function public.claim_message_dispatch(
  p_clinic_id uuid,
  p_dedupe_key text,
  p_channel public.message_channel,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.message_dispatches%rowtype;
  v_now timestamptz := coalesce(p_now, now());
begin
  select * into v_row
  from public.message_dispatches
  where clinic_id = p_clinic_id
    and dedupe_key = p_dedupe_key
    and channel = p_channel
  for update;

  if found then
    if v_row.status = 'sent' then
      return false;
    end if;
    -- A fresh claim means another run is mid-send: do not duplicate.
    if v_row.status = 'claimed'
       and v_row.claimed_at is not null
       and v_row.claimed_at > v_now - interval '15 minutes' then
      return false;
    end if;
    update public.message_dispatches
    set status = 'claimed', claimed_at = v_now
    where id = v_row.id;
    return true;
  end if;

  insert into public.message_dispatches
    (clinic_id, dedupe_key, channel, status, claimed_at)
  values (p_clinic_id, p_dedupe_key, p_channel, 'claimed', v_now);
  return true;
exception
  when unique_violation then
    -- A concurrent inserter won the claim.
    return false;
end;
$$;

revoke all on function public.claim_message_dispatch(uuid, text, public.message_channel, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_message_dispatch(uuid, text, public.message_channel, timestamptz)
  to service_role;

create or replace function public.finalize_message_dispatch(
  p_clinic_id uuid,
  p_dedupe_key text,
  p_channel public.message_channel,
  p_sent_at timestamptz,
  p_outbound_message_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.message_dispatches
  set status = 'sent',
      sent_at = coalesce(p_sent_at, now()),
      outbound_message_id = p_outbound_message_id
  where clinic_id = p_clinic_id
    and dedupe_key = p_dedupe_key
    and channel = p_channel
    and status = 'claimed';
  return found;
end;
$$;

revoke all on function public.finalize_message_dispatch(uuid, text, public.message_channel, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_message_dispatch(uuid, text, public.message_channel, timestamptz, uuid)
  to service_role;

create or replace function public.release_message_dispatch(
  p_clinic_id uuid,
  p_dedupe_key text,
  p_channel public.message_channel
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.message_dispatches
  set status = 'failed', claimed_at = null
  where clinic_id = p_clinic_id
    and dedupe_key = p_dedupe_key
    and channel = p_channel
    and status = 'claimed';
  return found;
end;
$$;

revoke all on function public.release_message_dispatch(uuid, text, public.message_channel)
  from public, anon, authenticated;
grant execute on function public.release_message_dispatch(uuid, text, public.message_channel)
  to service_role;

-- ---------------------------------------------------------------------------
-- Daily reminder candidate selection (§7.2b)
--
-- Confirmed, non-deleted appointments for reminder-enabled clinics whose
-- scheduled_at falls on the clinic-local calendar date of *today or tomorrow*
-- and is still in the future. Idempotency is per channel in message_dispatches,
-- so the runner claims each channel per appointment; a fully-sent appointment
-- is simply re-selected within its today/tomorrow window and skipped by the
-- claim. The clinic timezone is returned so the runner can format the message.
-- ---------------------------------------------------------------------------

create or replace function public.list_daily_reminder_candidates(
  p_now timestamptz,
  p_horizon timestamptz,
  p_limit integer default 1000
)
returns table (
  id uuid,
  clinic_id uuid,
  patient_id uuid,
  doctor_id uuid,
  scheduled_at timestamptz,
  reminders_sent jsonb,
  timezone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.clinic_id, a.patient_id, a.doctor_id, a.scheduled_at,
         a.reminders_sent, c.timezone
  from public.appointments a
  join public.clinics c on c.id = a.clinic_id
  where a.status = 'confirmed'::public.appointment_status
    and a.deleted_at is null
    and c.reminders_enabled
    and a.scheduled_at > p_now
    and a.scheduled_at <= p_horizon
    and (a.scheduled_at at time zone c.timezone)::date
          between (p_now at time zone c.timezone)::date
              and ((p_now at time zone c.timezone)::date + 1)
  order by a.scheduled_at asc
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

revoke all on function public.list_daily_reminder_candidates(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_daily_reminder_candidates(timestamptz, timestamptz, integer)
  to service_role;
