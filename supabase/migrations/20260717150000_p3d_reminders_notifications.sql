-- P3D: Reminders, invoice follow-ups & notification center (§7 of docs/AI_AGENT_PLAN.md).
--
-- Adds the automated-send state and the staff awareness layer:
--   * clinics.reminder_offsets       — per-clinic reminder hours (§7.2)
--   * appointments.reminders_sent    — per-offset lease/sent markers (§7.2)
--   * followup_sequences             — invoice follow-up state machine (§7.3)
--   * notifications                  — staff in-app notification center (§7.5)
--   * candidate/claim/finalize/release reminder RPCs — atomic, crash-safe
--     idempotency for the cron job (claim is a recoverable lease, not a
--     permanent marker; only finalize records a reminder as sent)
--
-- Trust boundaries:
--   * followup_sequences is advanced only by the cron runner: RLS is enabled
--     with NO policies (deny-all for anon/authenticated) — P3D ships no UI
--     that reads it, so no read surface is opened.
--   * notifications rows are per-recipient (the emitters fan out role
--     broadcasts at emit time so read state stays a per-row read_at).
--     Recipients read their own rows through RLS; all writes — emit and
--     mark-as-read — go through reviewed server code on the service role,
--     matching the P3A fail-closed posture.

-- ---------------------------------------------------------------------------
-- clinics.reminder_offsets — generalizes the dormant reminder_lead_hours
-- ---------------------------------------------------------------------------

create or replace function public.valid_reminder_offsets(p_offsets integer[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_offsets is not null
    and coalesce(array_length(p_offsets, 1), 0) between 1 and 5
    and not exists (
      select 1 from unnest(p_offsets) as offset_hours
      where offset_hours is null or offset_hours < 1 or offset_hours > 168
    );
$$;

alter table public.clinics
  add column reminder_offsets integer[] not null default '{24,3}',
  add constraint clinics_reminder_offsets_valid
    check (public.valid_reminder_offsets(reminder_offsets));

-- ---------------------------------------------------------------------------
-- appointments.reminders_sent — { "<offset hours>": {"state": ..., "at": ...} }
--
-- Each entry is a lease: claim writes {"state":"claimed","at":<iso>} and only
-- a successful dispatch finalizes it to {"state":"sent","at":<iso>}. A claim
-- older than the lease window is re-claimable, so a crash between claim and
-- send never suppresses the reminder permanently. A bare string value is
-- treated as sent (defensive against hand-written data).
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column reminders_sent jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reminders_sent) = 'object');

-- The baseline idx_appointments_reminder filters on reminder_sent_at IS NULL,
-- which stops matching after the first offset fires. Multi-offset selection
-- needs every upcoming confirmed appointment; per-offset skipping happens on
-- reminders_sent.
create index idx_appointments_reminder_offsets
  on public.appointments (scheduled_at)
  where status = 'confirmed'::public.appointment_status and deleted_at is null;

-- Tenant-integrity anchor for composite FKs (P3A precedent).
create unique index appointments_id_clinic_messaging_unique_idx
  on public.appointments (id, clinic_id);

-- ---------------------------------------------------------------------------
-- followup_sequences — invoice follow-up state machine (§7.3)
-- ---------------------------------------------------------------------------

create table public.followup_sequences (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  appointment_id uuid not null unique,
  -- Messages sent so far: 0 → D0 pending, 1 → D+3 pending, 2 → D+7 pending,
  -- 3 → complete. The cron claims a step before sending.
  step integer not null default 0 check (step between 0 and 3),
  next_run_at timestamptz,
  status text not null default 'active' check (status in ('active', 'stopped')),
  stopped_reason text
    check (stopped_reason in ('settled', 'cancelled', 'opted_out', 'completed')),
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint followup_sequences_stopped_reason_state check (
    (status = 'active' and stopped_reason is null)
    or (status = 'stopped' and stopped_reason is not null)
  ),
  constraint followup_sequences_appointment_clinic_fkey
    foreign key (appointment_id, clinic_id)
    references public.appointments(id, clinic_id)
    on delete cascade
);

create index followup_sequences_due_idx
  on public.followup_sequences (next_run_at)
  where status = 'active';
create index followup_sequences_clinic_idx
  on public.followup_sequences (clinic_id, status);

alter table public.followup_sequences enable row level security;
-- Intentionally NO policies: cron/server-code state only in P3D.

create trigger trg_followup_sequences_updated_at
  before update on public.followup_sequences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- notifications — staff in-app notification center (§7.5)
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Nullable per the plan schema (role-broadcast rows). P3D emitters always
  -- fan out to concrete recipients so read state is a per-row read_at; a
  -- broadcast row would need a separate per-user read table first.
  recipient_id uuid references public.profiles(id) on delete cascade,
  type text not null check (length(btrim(type)) between 1 and 64),
  title text check (title is null or length(title) <= 200),
  body text check (body is null or length(body) <= 1000),
  -- In-app path only ("/inbox?...", "/appointments"), never an absolute URL.
  link text check (link is null or (link like '/%' and length(link) <= 300)),
  -- Render inputs for the localized notification text (names/counts only —
  -- never clinical content).
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  -- Deterministic dedupe scope computed at emit time (type + link + narrowing
  -- data). Enforced by the partial unique index below so concurrent emitters
  -- cannot double-insert while a matching row is unread. Null = no dedupe.
  dedupe_key text check (dedupe_key is null or length(dedupe_key) between 1 and 600),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_recipient_clinic_fkey
    foreign key (recipient_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade
);

create index notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc);
create index notifications_recipient_unread_idx
  on public.notifications (recipient_id)
  where read_at is null;
-- Database-enforced unread deduplication (one unread notification per
-- recipient and dedupe scope); emit_clinic_notifications inserts against it
-- with ON CONFLICT DO NOTHING.
create unique index notifications_recipient_dedupe_unread_idx
  on public.notifications (recipient_id, dedupe_key)
  where read_at is null;
create index notifications_clinic_created_idx
  on public.notifications (clinic_id, created_at desc);

alter table public.notifications enable row level security;
-- Recipients read their own rows; every write (emit, mark-as-read) goes
-- through reviewed service-role server code.
create policy "notifications_recipient_read"
on public.notifications for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and recipient_id = (select auth.uid())
);

-- The header bell refreshes on Postgres Changes; RLS above scopes delivery.
alter publication supabase_realtime add table public.notifications;

-- ---------------------------------------------------------------------------
-- Reminder idempotency RPCs (§7.2) — recoverable lease semantics
--
-- Lifecycle per (appointment, offset):
--   claim    → {"state":"claimed","at":...}   (lease; blocks concurrent runs)
--   finalize → {"state":"sent","at":...}      (terminal; only after dispatch)
--   release  → entry removed                  (definite failure; retry next run)
-- A claim older than the lease window is re-claimable, so a process crash
-- between claim and dispatch cannot suppress the reminder permanently. The
-- lease must comfortably exceed one runner pass and stay below the hourly
-- cron interval (mirrored in lib/messaging/reminders.ts).
-- ---------------------------------------------------------------------------

-- The 'at' value is only ever written by the claim/finalize RPCs below
-- (to_jsonb of a timestamptz), so a direct cast is safe here.
create or replace function public.reminder_offset_actionable(
  p_entry jsonb,
  p_now timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_entry is null
    or (
      jsonb_typeof(p_entry) = 'object'
      and p_entry ->> 'state' = 'claimed'
      and coalesce(
            (p_entry ->> 'at')::timestamptz,
            'epoch'::timestamptz
          ) < p_now - interval '15 minutes'
    );
$$;

-- Claims one (appointment, offset) under a row lock. Returns false when the
-- offset is already sent, freshly claimed by another run, or the appointment
-- is no longer eligible; returns true (re-claiming) for a stale claim.
create or replace function public.claim_appointment_reminder(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_offset_hours integer,
  p_claimed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_key text := p_offset_hours::text;
  v_now timestamptz := coalesce(p_claimed_at, now());
begin
  if p_offset_hours is null or p_offset_hours < 1 or p_offset_hours > 168 then
    return false;
  end if;

  select a.*
    into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
    and a.clinic_id = p_clinic_id
  for update;
  if not found
     or v_appointment.status <> 'confirmed'::public.appointment_status
     or v_appointment.deleted_at is not null
     or not public.reminder_offset_actionable(
           v_appointment.reminders_sent -> v_key, v_now) then
    return false;
  end if;

  update public.appointments
  set reminders_sent = reminders_sent || jsonb_build_object(
        v_key, jsonb_build_object('state', 'claimed', 'at', to_jsonb(v_now)))
  where id = v_appointment.id;
  return true;
end;
$$;

revoke all on function public.claim_appointment_reminder(uuid, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_appointment_reminder(uuid, uuid, integer, timestamptz)
  to service_role;

-- Terminal marker written only after a successful dispatch. Also stamps the
-- legacy reminder_sent_at on the first sent offset.
create or replace function public.finalize_appointment_reminder(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_offset_hours integer,
  p_sent_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := p_offset_hours::text;
  v_at timestamptz := coalesce(p_sent_at, now());
begin
  update public.appointments
  set reminders_sent = reminders_sent || jsonb_build_object(
        v_key, jsonb_build_object('state', 'sent', 'at', to_jsonb(v_at))),
      reminder_sent_at = coalesce(reminder_sent_at, v_at)
  where id = p_appointment_id
    and clinic_id = p_clinic_id
    and reminders_sent -> v_key ->> 'state' = 'claimed';
  return found;
end;
$$;

revoke all on function public.finalize_appointment_reminder(uuid, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_reminder(uuid, uuid, integer, timestamptz)
  to service_role;

-- Compensation for a definite send failure after a claim: removes the lease
-- entry so the next cron run retries. Sent entries are never released.
create or replace function public.release_appointment_reminder(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_offset_hours integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := p_offset_hours::text;
begin
  update public.appointments
  set reminders_sent = reminders_sent - v_key
  where id = p_appointment_id
    and clinic_id = p_clinic_id
    and reminders_sent -> v_key ->> 'state' = 'claimed';
  return found;
end;
$$;

revoke all on function public.release_appointment_reminder(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.release_appointment_reminder(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Reminder candidate selection (§7.2) — SQL-side starvation guard (P3-H2)
--
-- Only appointments with at least one actionable offset (due, unsent, and not
-- under a fresh claim) enter the bounded window, so fully-reminded rows can
-- never crowd out later eligible appointments.
-- ---------------------------------------------------------------------------

create or replace function public.list_reminder_candidates(
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
  reminders_sent jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.clinic_id, a.patient_id, a.doctor_id, a.scheduled_at,
         a.reminders_sent
  from public.appointments a
  join public.clinics c on c.id = a.clinic_id
  where a.status = 'confirmed'::public.appointment_status
    and a.deleted_at is null
    and a.scheduled_at > p_now
    and a.scheduled_at <= p_horizon
    and exists (
      select 1
      from unnest(c.reminder_offsets) as o(offset_hours)
      where a.scheduled_at - make_interval(hours => o.offset_hours) <= p_now
        and public.reminder_offset_actionable(
              a.reminders_sent -> o.offset_hours::text, p_now)
    )
  order by a.scheduled_at asc
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

revoke all on function public.list_reminder_candidates(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_reminder_candidates(timestamptz, timestamptz, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Atomic notification fan-out (§7.5) — database-enforced dedupe (P3-M2)
--
-- Inserts one row per recipient in a single statement; the partial unique
-- index (recipient_id, dedupe_key) WHERE read_at IS NULL makes concurrent
-- emits race-free — a loser simply inserts nothing. Tenant isolation: the
-- clinic id is explicit and the composite recipient FK rejects any recipient
-- outside that clinic.
-- ---------------------------------------------------------------------------

create or replace function public.emit_clinic_notifications(
  p_clinic_id uuid,
  p_recipient_ids uuid[],
  p_type text,
  p_link text,
  p_data jsonb,
  p_dedupe_key text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  insert into public.notifications
    (clinic_id, recipient_id, type, link, data, dedupe_key)
  select p_clinic_id, r.recipient_id, p_type, p_link,
         coalesce(p_data, '{}'::jsonb), p_dedupe_key
  from unnest(p_recipient_ids) as r(recipient_id)
  on conflict (recipient_id, dedupe_key) where read_at is null do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.emit_clinic_notifications(uuid, uuid[], text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.emit_clinic_notifications(uuid, uuid[], text, text, jsonb, text)
  to service_role;
