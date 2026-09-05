-- ---------------------------------------------------------------------------
-- P8 — WhatsApp inbox history, human takeover, attachments, and WhatsApp-side
-- patient registration.
--
-- Five things happen here, and each one is a correction to something the
-- existing model could not express:
--
--   1. A conversation gains a *display name* that is not an identity. WhatsApp
--      tells a linked device what a contact calls themselves; that is a label
--      for staff, never proof of who anybody is, so it lives beside
--      participant_address rather than replacing it.
--   2. A conversation gains a durable, tenant-scoped *AI pause*. Clinic-level
--      reply mode still decides whether the agent may speak at all; this is an
--      additional per-conversation gate a human can close and reopen.
--   3. outbound_messages gains the *full body* for inbox threads only. The
--      redacted 160-char body_preview stays exactly as it was for reminders,
--      invoices, and every analytics path (§9.3) — but a message a patient can
--      read in full on their phone and staff can only read the first 120
--      characters of in the Inbox is a defect, not a privacy control.
--   4. Inbound attachments get a table and a private bucket. Nothing about a
--      file the sender described is trusted: the stored mime type is the one
--      the worker sniffed from the bytes.
--   5. A patient who writes from an unknown number can be registered from the
--      conversation, through one reviewed boundary that owns duplicate
--      detection, file numbering, and the conversation link together.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Conversation display name + human takeover
-- ---------------------------------------------------------------------------

alter table public.conversations
  -- The name WhatsApp reports for this contact (push name or the clinic's own
  -- saved contact name). Secondary metadata: it is never used to resolve a
  -- patient, never matched against patient records, and never treated as proof.
  add column if not exists display_name text
    check (display_name is null or length(btrim(display_name)) between 1 and 120),
  -- Human takeover. Non-null means no automated agent reply may be sent for
  -- this conversation, whatever the clinic-level reply mode says.
  add column if not exists ai_paused_at timestamptz,
  add column if not exists ai_paused_by uuid,
  add column if not exists ai_pause_reason text
    check (ai_pause_reason is null or length(btrim(ai_pause_reason)) between 1 and 200);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'conversations_ai_paused_by_clinic_fkey'
  ) then
    alter table public.conversations
      add constraint conversations_ai_paused_by_clinic_fkey
        foreign key (ai_paused_by, clinic_id)
        references public.profiles(id, clinic_id)
        on delete set null (ai_paused_by);
  end if;
end;
$$;

-- Both halves of the takeover flag move together or not at all: a paused
-- conversation always records who paused it (or explicitly nobody, when the
-- staff member is later removed), and an unpaused one carries no stale actor.
alter table public.conversations
  drop constraint if exists conversations_ai_pause_consistent_check;
alter table public.conversations
  add constraint conversations_ai_pause_consistent_check
    check (ai_paused_at is not null or (ai_paused_by is null and ai_pause_reason is null));

-- ---------------------------------------------------------------------------
-- 2. Full outbound body — inbox threads only
-- ---------------------------------------------------------------------------

-- Both constraints are added NOT VALID and validated in a separate statement.
-- `ADD CONSTRAINT ... CHECK` normally takes ACCESS EXCLUSIVE *and* scans the
-- whole table under it; on a production outbound_messages that blocks every
-- send for the length of the scan. NOT VALID takes the lock only long enough to
-- record the constraint (new rows are checked immediately from that moment),
-- and VALIDATE CONSTRAINT then scans under SHARE UPDATE EXCLUSIVE, which sends
-- run happily alongside.
alter table public.outbound_messages
  -- The complete text as sent. Populated only for conversation-scoped messages
  -- (related_type = 'manual'): manual staff replies, approved AI suggestions,
  -- automatic AI replies, and messages mirrored in from the clinic's own phone.
  -- Reminders, invoice follow-ups and every other programmatic send keep
  -- body_preview alone, so no analytics or health path gains a full body.
  add column if not exists body text;

alter table public.outbound_messages
  drop constraint if exists outbound_messages_body_length_check;
alter table public.outbound_messages
  add constraint outbound_messages_body_length_check
    check (body is null or length(body) <= 8192) not valid;
alter table public.outbound_messages
  validate constraint outbound_messages_body_length_check;

alter table public.outbound_messages
  drop constraint if exists outbound_messages_body_scope_check;
alter table public.outbound_messages
  add constraint outbound_messages_body_scope_check
    check (body is null or related_type = 'manual'::public.outbound_related_type) not valid;
alter table public.outbound_messages
  validate constraint outbound_messages_body_scope_check;

-- ---------------------------------------------------------------------------
-- 3. Inbound attachments
-- ---------------------------------------------------------------------------

create table if not exists public.inbound_message_attachments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null,
  inbound_message_id uuid,
  patient_id uuid,
  -- Coarse kind, decided by the worker from the *sniffed* bytes.
  media_kind text not null check (media_kind in ('image', 'document', 'audio', 'video', 'unsupported')),
  -- The mime type the bytes actually are, never the one the sender claimed.
  mime_type text not null check (length(btrim(mime_type)) between 3 and 128),
  -- The sender's filename, kept only as a label. Never used to build a path.
  original_filename text check (original_filename is null or length(original_filename) <= 255),
  byte_size integer not null check (byte_size >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text,
  -- 'stored' — bytes are in the bucket and readable.
  -- 'rejected' — over the size cap, or a type this stack will not store.
  -- 'failed'   — download or upload did not complete. The message survives.
  status text not null default 'stored' check (status in ('stored', 'rejected', 'failed')),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 80),
  created_at timestamptz not null default now(),
  constraint inbound_message_attachments_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete cascade,
  constraint inbound_message_attachments_patient_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id)
    on delete set null (patient_id),
  -- Stored bytes always have a path; a rejected or failed one never does.
  constraint inbound_message_attachments_path_check
    check ((status = 'stored') = (storage_path is not null))
);

create index if not exists inbound_message_attachments_conversation_idx
  on public.inbound_message_attachments (conversation_id, created_at);
create index if not exists inbound_message_attachments_message_idx
  on public.inbound_message_attachments (inbound_message_id);
-- One attachment row per message per file, so a replayed callback re-lands on
-- the row it already wrote instead of duplicating it.
--
-- Deliberately not a partial index: `ON CONFLICT` can only infer a partial index
-- when the statement repeats its predicate.
--
-- NULLS NOT DISTINCT is the part that matters for refused files. A rejected or
-- failed attachment has no bytes and therefore no digest; under the default
-- NULLS DISTINCT two such rows collide with nothing, so a re-delivered callback
-- would write the same "the patient sent a voice note we cannot store" row
-- again. Treating the null digests as equal collapses them onto one row per
-- (message, kind), which is the same idempotency the stored files get.
drop index if exists public.inbound_message_attachments_unique_idx;
create unique index if not exists inbound_message_attachments_unique_idx
  on public.inbound_message_attachments (clinic_id, inbound_message_id, media_kind, sha256)
  nulls not distinct;

alter table public.inbound_message_attachments enable row level security;
drop policy if exists "inbox_staff_read_own_inbound_attachments" on public.inbound_message_attachments;
create policy "inbox_staff_read_own_inbound_attachments"
on public.inbound_message_attachments for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

grant select on table public.inbound_message_attachments to authenticated;
grant all on table public.inbound_message_attachments to service_role;
revoke all on table public.inbound_message_attachments from anon;

-- Private bucket. Deliberately no `authenticated` storage policy: the bytes are
-- reached only through a short-lived signed URL minted by server code that has
-- already proved the caller's clinic and role. There is no client-side path to
-- this bucket at all, which is a smaller surface than a storage predicate.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'whatsapp-inbound',
  'whatsapp-inbound',
  false,
  16777216,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 4. History-import bookkeeping on the linked-device session
-- ---------------------------------------------------------------------------

alter table public.whatsapp_linked_device_sessions
  add column if not exists history_status text not null default 'idle',
  add column if not exists history_started_at timestamptz,
  add column if not exists history_completed_at timestamptz,
  -- Counts of what the *application* durably accepted, not of what the worker
  -- parsed. The worker's own interpretation is an intention; only the callback
  -- the application answered 2xx to is a fact, and only facts are shown to a
  -- clinic as "your history was imported".
  add column if not exists history_chats_imported integer not null default 0
    check (history_chats_imported >= 0),
  add column if not exists history_messages_imported integer not null default 0
    check (history_messages_imported >= 0),
  -- Set once the phone has told us it sent its last batch. `complete` needs both
  -- this and an empty delivery spool, so a slow batch cannot be overtaken by a
  -- fast `isLatest` one and reported as finished.
  add column if not exists history_final_batch_seen boolean not null default false,
  -- Non-null while at least one interpreted batch has not been durably accepted
  -- by the application. Drives the `partial` state below.
  add column if not exists history_last_error text;

-- `partial` is the state the previous shape could not express: the phone
-- finished pushing, but at least one batch was never acknowledged and its
-- retries are exhausted. A clinic in this state is told plainly that the import
-- is incomplete instead of being shown a `complete` badge over missing threads.
alter table public.whatsapp_linked_device_sessions
  drop constraint if exists whatsapp_linked_device_sessions_history_status_check;
alter table public.whatsapp_linked_device_sessions
  add constraint whatsapp_linked_device_sessions_history_status_check
    check (history_status in ('idle', 'importing', 'partial', 'complete', 'unavailable'));

-- ---------------------------------------------------------------------------
-- 4b. Durable history delivery spool (H2)
--
-- The failure this exists to close: history arrives once, at the initial link.
-- Before this, an interpreted batch lived only in the worker's memory and in one
-- in-flight POST. A timeout, a 5xx, a Vercel cold start or a worker restart lost
-- it permanently, and the session still reported `complete` — because it
-- reported what the worker *parsed*, which is not what the application *stored*.
--
-- Every interpreted batch is now written here before any delivery is attempted,
-- so the unit of recovery is a durable row rather than a stack frame. Rows are
-- claimed, posted, and only then marked delivered; a worker that dies mid-post
-- leaves a pending row that the next drain (including the one on boot) picks up.
-- Re-delivery is safe because the persistence RPCs downstream are keyed on
-- WhatsApp's own message ids.
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_history_delivery_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- The paired number this batch was interpreted for. A batch is only ever
  -- posted back under the session phone it was captured on, so a re-pairing to a
  -- different number cannot flush a previous number's chats into the inbox.
  session_phone text not null check (length(btrim(session_phone)) between 3 and 32),
  -- Deterministic over the batch's contents, so re-interpreting the same
  -- `messaging-history.set` payload after a restart enqueues nothing new.
  batch_key text not null check (length(batch_key) between 8 and 128),
  payload jsonb not null,
  event_count integer not null check (event_count between 1 and 500),
  attempts smallint not null default 0 check (attempts between 0 and 100),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed')),
  -- Set while a worker is posting this row, so two instances of the drain (or a
  -- drain racing the enqueue path) cannot post the same batch twice.
  claimed_by text,
  claimed_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_history_delivery_batches_unique unique (clinic_id, batch_key)
);

create index if not exists whatsapp_history_delivery_batches_pending_idx
  on public.whatsapp_history_delivery_batches (clinic_id, created_at)
  where status = 'pending';

alter table public.whatsapp_history_delivery_batches enable row level security;
-- No policy at all: the spool holds raw message bodies for chats that have not
-- been admitted to the inbox yet (see §4c), so it is service-role only. Staff
-- read the *outcome* of an import, never its transport buffer.
grant all on table public.whatsapp_history_delivery_batches to service_role;
revoke all on table public.whatsapp_history_delivery_batches from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4c. History chats held for review (H4)
--
-- A linked device is the clinic's *own phone*. Its chat list contains the
-- owner's family, their accountant and their suppliers alongside their patients,
-- and none of the non-patient traffic is clinical record content, was consented
-- to as such, or belongs in front of a receptionist.
--
-- The rule the import now follows:
--
--   * a history chat whose number matches exactly one active patient of this
--     clinic is *clinic traffic* and is imported in full — thread, name and
--     message bodies;
--   * every other history chat is **staged here**: number, WhatsApp name, how
--     many historical messages were offered, and when the last one was. No
--     message body is written anywhere for a staged chat, so nothing a clinic
--     never asked for lands in the CRM;
--   * staff can accept a staged chat, which opens the thread from that point on,
--     or dismiss it, which suppresses it for good.
--
-- Groups, status, broadcast and newsletters never reach this table: they are
-- refused a layer earlier by the JID classifier, as they always were.
-- ---------------------------------------------------------------------------

create table if not exists public.whatsapp_history_pending_chats (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  participant_address text not null check (length(btrim(participant_address)) between 3 and 32),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 120),
  -- How many historical messages the phone offered for this chat. A count only:
  -- the bodies are deliberately not stored anywhere for a chat in this state.
  message_count integer not null default 0 check (message_count >= 0),
  last_message_at timestamptz,
  -- 'pending'   — waiting for a staff decision.
  -- 'dismissed' — staff said this is not clinic traffic. Never offered again.
  status text not null default 'pending' check (status in ('pending', 'dismissed')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_history_pending_chats_unique unique (clinic_id, participant_address),
  constraint whatsapp_history_pending_chats_decider_clinic_fkey
    foreign key (decided_by, clinic_id)
    references public.profiles(id, clinic_id)
    on delete set null (decided_by)
);

create index if not exists whatsapp_history_pending_chats_open_idx
  on public.whatsapp_history_pending_chats (clinic_id, last_message_at desc)
  where status = 'pending';

alter table public.whatsapp_history_pending_chats enable row level security;
drop policy if exists "inbox_staff_read_pending_history_chats" on public.whatsapp_history_pending_chats;
create policy "inbox_staff_read_pending_history_chats"
on public.whatsapp_history_pending_chats for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

grant select on table public.whatsapp_history_pending_chats to authenticated;
grant all on table public.whatsapp_history_pending_chats to service_role;
revoke all on table public.whatsapp_history_pending_chats from anon;

-- ---------------------------------------------------------------------------
-- 4d. History progress, computed from what was durably accepted (H2, L2, L3)
--
-- The previous version of this bookkeeping had three separate ways of lying to
-- a clinic about their import:
--
--   * it counted what the *worker interpreted*, not what the application stored,
--     so a batch that never landed still raised the total;
--   * it added `carriedChats` per batch, so a chat appearing in three batches
--     counted three times (L2);
--   * it wrote `complete` from whichever batch happened to carry `isLatest`,
--     which — because batches are processed concurrently — could overtake a
--     slower earlier batch and declare the import finished mid-flight (L3).
--
-- All three are answered by moving the decision here, where the delivery spool
-- is visible. `complete` now requires two facts at once: the phone said it sent
-- its last batch, *and* the spool for this clinic is empty. Exhausted batches
-- leave the import `partial`, which is a state a clinic can act on.
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_history_delivery(
  p_clinic_id uuid,
  p_batch_id uuid default null,
  p_delivered boolean default null,
  p_chats integer default 0,
  p_messages integer default 0,
  p_error text default null,
  p_final_batch_seen boolean default false,
  p_max_attempts integer default 8
)
returns table (history_status text, pending_batches integer, failed_batches integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.whatsapp_linked_device_sessions%rowtype;
  v_pending integer;
  v_failed integer;
  v_final boolean;
  v_status text;
  v_chats integer;
  v_messages integer;
begin
  select s.* into v_session
  from public.whatsapp_linked_device_sessions s
  where s.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'LINKED_DEVICE_SESSION_NOT_FOUND';
  end if;

  if p_batch_id is not null then
    update public.whatsapp_history_delivery_batches b
    set status = case
          when p_delivered then 'delivered'
          when b.attempts + 1 >= p_max_attempts then 'failed'
          else 'pending'
        end,
        attempts = least(b.attempts + 1, 100),
        claimed_by = null,
        claimed_at = null,
        last_error = case when p_delivered then null else left(p_error, 200) end,
        updated_at = pg_catalog.now()
    where b.id = p_batch_id
      and b.clinic_id = p_clinic_id;
  end if;

  select count(*) filter (where b.status = 'pending')::integer,
         count(*) filter (where b.status = 'failed')::integer
    into v_pending, v_failed
  from public.whatsapp_history_delivery_batches b
  where b.clinic_id = p_clinic_id;

  v_final := v_session.history_final_batch_seen or coalesce(p_final_batch_seen, false);
  v_chats := v_session.history_chats_imported + greatest(coalesce(p_chats, 0), 0);
  v_messages := v_session.history_messages_imported + greatest(coalesce(p_messages, 0), 0);

  v_status := case
    when not v_final then 'importing'
    when v_pending > 0 then 'importing'
    when v_failed > 0 then 'partial'
    when v_chats = 0 and v_messages = 0 then 'unavailable'
    else 'complete'
  end;

  update public.whatsapp_linked_device_sessions
  set history_status = v_status,
      history_final_batch_seen = v_final,
      history_chats_imported = v_chats,
      history_messages_imported = v_messages,
      history_last_error = case when v_failed > 0 then left(p_error, 200) else null end,
      history_completed_at = case
        when v_status in ('complete', 'partial', 'unavailable') then pg_catalog.now()
        else history_completed_at
      end
  where clinic_id = p_clinic_id;

  history_status := v_status;
  pending_batches := v_pending;
  failed_batches := v_failed;
  return next;
end;
$$;

revoke all on function public.record_whatsapp_history_delivery(uuid, uuid, boolean, integer, integer, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_history_delivery(uuid, uuid, boolean, integer, integer, text, boolean, integer)
  to service_role;

/**
 * Claims up to `p_limit` undelivered batches for this worker.
 *
 * A clinic's session is owned by exactly one worker, but a boot-time drain can
 * still overlap the tail of a previous instance's in-flight post. The claim
 * stamp bounds that: a row another worker took less than `p_stale_seconds` ago is
 * left alone, and one it took and then died holding is picked up. Re-delivery
 * would be harmless anyway — every persistence RPC downstream is keyed on
 * WhatsApp's own message ids — but posting the same megabyte twice is not free.
 */
create or replace function public.claim_whatsapp_history_batches(
  p_clinic_id uuid,
  p_worker_id text,
  p_limit integer default 5,
  p_stale_seconds integer default 300,
  p_exclude_ids uuid[] default '{}'::uuid[]
)
returns table (id uuid, session_phone text, payload jsonb, attempts smallint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.whatsapp_history_delivery_batches b
  set claimed_by = p_worker_id,
      claimed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where b.id in (
    select candidate.id
    from public.whatsapp_history_delivery_batches candidate
    where candidate.clinic_id = p_clinic_id
      and candidate.status = 'pending'
      -- Rows this drain pass has already attempted. Without it a batch that
      -- failed (and therefore had its claim released, so the *next* pass can
      -- take it) would be handed straight back to the pass that just failed it,
      -- which either spins or — if the caller filters it out itself — leaves a
      -- claim stamp behind that blocks the retry for the whole stale window.
      and not (candidate.id = any (coalesce(p_exclude_ids, '{}'::uuid[])))
      and (
        candidate.claimed_at is null
        or candidate.claimed_at < pg_catalog.now() - make_interval(secs => greatest(p_stale_seconds, 1))
      )
    order by candidate.created_at, candidate.id
    limit least(greatest(p_limit, 1), 25)
    for update skip locked
  )
  returning b.id, b.session_phone, b.payload, b.attempts;
end;
$$;

drop function if exists public.claim_whatsapp_history_batches(uuid, text, integer, integer);
revoke all on function public.claim_whatsapp_history_batches(uuid, text, integer, integer, uuid[])
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_history_batches(uuid, text, integer, integer, uuid[])
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Inbound persistence — now carrying a display name, a historical flag, and
--    the id of the row it wrote.
--
-- The old five-argument function is dropped rather than overloaded: two
-- functions of the same name differing only by defaulted parameters make every
-- named-argument call ambiguous, and PostgREST calls by name.
-- ---------------------------------------------------------------------------

drop function if exists public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz);
drop function if exists public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean);

create or replace function public.persist_whatsapp_inbound(
  p_clinic_id uuid,
  p_sender text,
  p_body text,
  p_provider_message_id text,
  p_received_at timestamptz,
  p_display_name text default null,
  p_historical boolean default false
)
returns table (inserted boolean, conversation_id uuid, inbound_message_id uuid, staged boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_window_expires_at timestamptz := p_received_at + interval '24 hours';
  v_display_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_message_id uuid;
begin
  staged := false;
  if p_sender is null or btrim(p_sender) = ''
     or p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'INVALID_INBOUND_MESSAGE';
  end if;

  if v_display_name is not null and length(v_display_name) > 120 then
    v_display_name := left(v_display_name, 120);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_sender, 0)
  );

  select im.conversation_id, im.id
    into conversation_id, inbound_message_id
  from public.inbound_messages im
  where im.clinic_id = p_clinic_id
    and im.provider_message_id = p_provider_message_id;
  if found then
    inserted := false;
    return next;
    return;
  end if;

  select c.*
    into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = p_sender
  for update;

  -- P8/H4: a *live* message is somebody writing to the clinic's number right
  -- now, and always opens a thread. A *historical* one is a line out of the
  -- phone's own chat list, and only lands if the clinic already has this thread
  -- — which §6 grants exactly when the number belongs to one of its patients, or
  -- when staff accepted the chat for review. Otherwise the message body is not
  -- written anywhere; only the fact that the chat exists is staged.
  if not found and p_historical then
    insert into public.whatsapp_history_pending_chats as pending (
      clinic_id, participant_address, display_name, message_count, last_message_at
    ) values (
      p_clinic_id, p_sender, left(v_display_name, 120), 1, p_received_at
    )
    on conflict (clinic_id, participant_address) do update
    set message_count = pending.message_count + 1,
        display_name = coalesce(pending.display_name, excluded.display_name),
        last_message_at = greatest(
          coalesce(pending.last_message_at, excluded.last_message_at),
          excluded.last_message_at
        ),
        updated_at = pg_catalog.now();
    inserted := false;
    conversation_id := null;
    inbound_message_id := null;
    staged := true;
    return next;
    return;
  end if;

  if not found then
    select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
      into v_patient_id, v_patient_count
    from public.patients p
    where p.clinic_id = p_clinic_id
      and p.phone = p_sender
      and not p.is_deleted
      and p.deleted_at is null;
    if v_patient_count <> 1 then
      v_patient_id := null;
    end if;

    insert into public.conversations (
      clinic_id,
      patient_id,
      channel,
      participant_address,
      display_name,
      patient_link_status,
      -- A historical import must not open a 24-hour service window that
      -- WhatsApp never actually granted: the window is a Cloud API business
      -- rule keyed on a *live* inbound message.
      window_expires_at,
      status,
      status_updated_at,
      last_message_at
    ) values (
      p_clinic_id,
      v_patient_id,
      'whatsapp'::public.message_channel,
      p_sender,
      v_display_name,
      'automatic',
      case when p_historical then null else v_window_expires_at end,
      'open'::public.conversation_status,
      p_received_at,
      p_received_at
    )
    returning * into v_conversation;
  else
    if v_conversation.patient_link_status = 'automatic'
       and v_conversation.patient_id is null then
      select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
        into v_patient_id, v_patient_count
      from public.patients p
      where p.clinic_id = p_clinic_id
        and p.phone = p_sender
        and not p.is_deleted
        and p.deleted_at is null;
      if v_patient_count = 1 then
        update public.conversations
        set patient_id = v_patient_id
        where id = v_conversation.id
        returning * into v_conversation;
      end if;
    end if;
    -- A name WhatsApp reports later fills a blank; it never overwrites one the
    -- clinic is already seeing, and a live message's name outranks history's.
    if v_display_name is not null
       and (v_conversation.display_name is null or not p_historical) then
      update public.conversations
      set display_name = v_display_name
      where id = v_conversation.id
      returning * into v_conversation;
    end if;
  end if;

  insert into public.inbound_messages (
    clinic_id,
    channel,
    sender,
    patient_id,
    conversation_id,
    body,
    provider_message_id,
    received_at
  ) values (
    p_clinic_id,
    'whatsapp'::public.message_channel,
    p_sender,
    v_conversation.patient_id,
    v_conversation.id,
    coalesce(nullif(p_body, ''), '[Empty message]'),
    p_provider_message_id,
    p_received_at
  )
  returning id into v_message_id;

  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at, p_received_at), p_received_at),
      window_expires_at = case
        when p_historical then window_expires_at
        else greatest(coalesce(window_expires_at, v_window_expires_at), v_window_expires_at)
      end,
      -- Importing an old message must never reopen a thread staff have closed.
      status = case
        when p_historical then status
        when status = 'open'::public.conversation_status
          or p_received_at >= status_updated_at
          then 'open'::public.conversation_status
        else status
      end,
      status_updated_at = case
        when not p_historical
          and status = 'closed'::public.conversation_status
          and p_received_at >= status_updated_at
          then p_received_at
        else status_updated_at
      end
  where id = v_conversation.id;

  inserted := true;
  conversation_id := v_conversation.id;
  inbound_message_id := v_message_id;
  return next;
exception
  when unique_violation then
    -- Only one unique violation in this function is a replay: the
    -- (clinic_id, provider_message_id) collision, which means the message is
    -- already recorded. Every other one — most plausibly the participant index
    -- on conversations, if a writer that does not take the advisory lock above
    -- races us — must *not* be reported as a replay: the caller would count the
    -- message, acknowledge it to the worker, and lose it. Re-raise instead, so
    -- the callback answers 5xx and the batch is retried.
    select im.conversation_id, im.id
      into conversation_id, inbound_message_id
    from public.inbound_messages im
    where im.clinic_id = p_clinic_id
      and im.provider_message_id = p_provider_message_id;
    if not found then
      raise;
    end if;
    inserted := false;
    staged := false;
    return next;
end;
$$;

revoke all on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_whatsapp_inbound(uuid, text, text, text, timestamptz, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. History chat upsert — and the privacy rule that decides admission (H4)
--
-- A chat WhatsApp reports on the history sync in which the clinic only ever
-- *sent* still belongs in the inbox — the thread exists on the clinic's phone.
-- This opens it without any of the live-message side effects: no service
-- window, no unread bump, no status change, no notification.
--
-- What it will not do is open it for *every* chat on that phone. The device
-- being linked is a personal handset belonging to the clinic; its chat list is
-- not a patient list. Admission is therefore decided, and decided in the
-- database rather than in the worker, on one defensible test:
--
--     the chat's number matches exactly one active patient of this clinic
--
-- That is the same key `persist_whatsapp_inbound` already uses to attribute a
-- live message, so the two can never disagree about what clinic traffic is.
-- A chat that fails the test is *staged* — number, name, and how recent it is,
-- nothing else — for staff to accept or dismiss, and no message of it is
-- persisted in the meantime. A chat staff already dismissed is never offered
-- again and never re-staged.
--
-- The returned `staged` flag is what the callback pipeline counts, so a clinic
-- is never told a thread was imported when it was only listed for review.
-- ---------------------------------------------------------------------------

-- The return type gains `staged`, so the old signature is dropped first.
drop function if exists public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz);

create or replace function public.upsert_whatsapp_history_chat(
  p_clinic_id uuid,
  p_participant text,
  p_display_name text default null,
  p_last_message_at timestamptz default null
)
returns table (conversation_id uuid, created boolean, staged boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_display_name text := left(nullif(btrim(coalesce(p_display_name, '')), ''), 120);
  v_at timestamptz := coalesce(p_last_message_at, pg_catalog.now());
begin
  staged := false;
  if p_participant is null or btrim(p_participant) = '' then
    raise exception 'INVALID_HISTORY_CHAT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':whatsapp:' || p_participant, 0)
  );

  select c.*
    into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = p_participant
  for update;

  if found then
    -- The thread already exists, so this chat is already clinic traffic —
    -- whether it was admitted by the patient-number test below, accepted by
    -- staff, or opened by a live message. Nothing to decide.
    if v_display_name is not null and v_conversation.display_name is null then
      update public.conversations
      set display_name = v_display_name
      where id = v_conversation.id;
    end if;
    conversation_id := v_conversation.id;
    created := false;
    return next;
    return;
  end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_patient_id, v_patient_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and p.phone = p_participant
    and not p.is_deleted
    and p.deleted_at is null;
  if v_patient_count <> 1 then
    v_patient_id := null;
  end if;

  -- The admission test. No patient behind this number means the clinic has not
  -- told us this is one of their patients, and a personal contact on the owner's
  -- phone must not become a row every receptionist can read. Stage it instead:
  -- the number, the name WhatsApp reports, and when it was last active. The
  -- display name is preserved *here* rather than on a conversation precisely
  -- because there is no conversation to hang it on yet — and it is discarded
  -- with the row if staff dismiss the chat.
  if v_patient_id is null then
    insert into public.whatsapp_history_pending_chats as pending (
      clinic_id, participant_address, display_name, message_count, last_message_at
    ) values (
      p_clinic_id, p_participant, v_display_name, 0, p_last_message_at
    )
    on conflict (clinic_id, participant_address) do update
    set display_name = coalesce(excluded.display_name, pending.display_name),
        last_message_at = greatest(pending.last_message_at, excluded.last_message_at),
        updated_at = pg_catalog.now();
    conversation_id := null;
    created := false;
    staged := true;
    return next;
    return;
  end if;

  insert into public.conversations (
    clinic_id,
    patient_id,
    channel,
    participant_address,
    display_name,
    patient_link_status,
    window_expires_at,
    status,
    status_updated_at,
    last_message_at
  ) values (
    p_clinic_id,
    v_patient_id,
    'whatsapp'::public.message_channel,
    p_participant,
    v_display_name,
    'automatic',
    null,
    'open'::public.conversation_status,
    v_at,
    v_at
  )
  returning * into v_conversation;

  conversation_id := v_conversation.id;
  created := true;
  return next;
exception
  when unique_violation then
    select c.id into conversation_id
    from public.conversations c
    where c.clinic_id = p_clinic_id
      and c.channel = 'whatsapp'::public.message_channel
      and c.participant_address = p_participant;
    if not found then
      raise;
    end if;
    created := false;
    staged := false;
    return next;
end;
$$;

revoke all on function public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_history_chat(uuid, text, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6b. Staff decisions on a staged history chat (H4)
--
-- Accepting opens the thread from now on. It deliberately does *not* resurrect
-- the historical bodies: they were never written, which is the whole point of
-- staging — the clinic decides before the data exists, not after. What accepting
-- buys is that this contact is now a clinic conversation, so live traffic lands
-- in the inbox with the right name and the right patient link.
--
-- Dismissing is durable: the row stays as a tombstone so a later re-link cannot
-- re-offer a chat staff have already said is not clinic business.
-- ---------------------------------------------------------------------------

create or replace function public.decide_whatsapp_history_chat(
  p_clinic_id uuid,
  p_pending_id uuid,
  p_accept boolean,
  p_actor_id uuid
)
returns table (conversation_id uuid, accepted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending public.whatsapp_history_pending_chats%rowtype;
  v_conversation public.conversations%rowtype;
  v_patient_id uuid;
  v_patient_count integer;
  v_at timestamptz;
begin
  select p.* into v_pending
  from public.whatsapp_history_pending_chats p
  where p.id = p_pending_id
    and p.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'PENDING_CHAT_NOT_FOUND';
  end if;
  if v_pending.status <> 'pending' then
    conversation_id := null;
    accepted := false;
    return next;
    return;
  end if;

  if not p_accept then
    update public.whatsapp_history_pending_chats
    set status = 'dismissed',
        decided_by = p_actor_id,
        decided_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = v_pending.id;
    conversation_id := null;
    accepted := false;
    return next;
    return;
  end if;

  v_at := coalesce(v_pending.last_message_at, pg_catalog.now());
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':whatsapp:' || v_pending.participant_address, 0)
  );

  select c.* into v_conversation
  from public.conversations c
  where c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
    and c.participant_address = v_pending.participant_address
  for update;

  if not found then
    select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
      into v_patient_id, v_patient_count
    from public.patients p
    where p.clinic_id = p_clinic_id
      and p.phone = v_pending.participant_address
      and not p.is_deleted
      and p.deleted_at is null;
    if v_patient_count <> 1 then
      v_patient_id := null;
    end if;

    insert into public.conversations (
      clinic_id,
      patient_id,
      channel,
      participant_address,
      display_name,
      patient_link_status,
      -- No service window: accepting a chat for review is a filing decision, not
      -- a message from the patient, and must not manufacture a 24-hour window
      -- WhatsApp never granted.
      window_expires_at,
      status,
      status_updated_at,
      last_message_at
    ) values (
      p_clinic_id,
      v_patient_id,
      'whatsapp'::public.message_channel,
      v_pending.participant_address,
      v_pending.display_name,
      'automatic',
      null,
      'open'::public.conversation_status,
      v_at,
      v_at
    )
    returning * into v_conversation;
  end if;

  delete from public.whatsapp_history_pending_chats where id = v_pending.id;
  conversation_id := v_conversation.id;
  accepted := true;
  return next;
end;
$$;

revoke all on function public.decide_whatsapp_history_chat(uuid, uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.decide_whatsapp_history_chat(uuid, uuid, boolean, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Human takeover boundary
--
-- Conditional on the current state, so two staff members clicking at once
-- produce one transition and one audit fact rather than two. `changed = false`
-- means somebody else already did it.
-- ---------------------------------------------------------------------------

create or replace function public.set_conversation_ai_pause(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_paused boolean,
  p_actor_id uuid,
  p_reason text default null
)
returns table (changed boolean, paused boolean, paused_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 200);
begin
  select c.*
    into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  if p_paused = (v_conversation.ai_paused_at is not null) then
    changed := false;
    paused := v_conversation.ai_paused_at is not null;
    paused_at := v_conversation.ai_paused_at;
    return next;
    return;
  end if;

  if p_paused then
    update public.conversations
    set ai_paused_at = pg_catalog.now(),
        ai_paused_by = p_actor_id,
        ai_pause_reason = v_reason
    where id = p_conversation_id
      and clinic_id = p_clinic_id
      and ai_paused_at is null
    returning * into v_conversation;
  else
    update public.conversations
    set ai_paused_at = null,
        ai_paused_by = null,
        ai_pause_reason = null
    where id = p_conversation_id
      and clinic_id = p_clinic_id
      and ai_paused_at is not null
    returning * into v_conversation;
  end if;

  -- The `FOR UPDATE` above makes a zero-row update unreachable today. If the
  -- lock is ever relaxed it becomes reachable, and `v_conversation` would then
  -- be an all-NULL record — from which `paused` computes as *false*, i.e. this
  -- function would report "the AI is live again" to a caller whose pause it
  -- never applied. Re-read the row instead of reading a record that lost.
  changed := found;
  if not found then
    select c.* into v_conversation
    from public.conversations c
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id;
  end if;
  paused := v_conversation.ai_paused_at is not null;
  paused_at := v_conversation.ai_paused_at;
  return next;
end;
$$;

revoke all on function public.set_conversation_ai_pause(uuid, uuid, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_conversation_ai_pause(uuid, uuid, boolean, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Registering a patient from a WhatsApp conversation
--
-- One boundary owns the whole decision, because the parts are not separable:
-- duplicate detection, the clinic's file-number sequence, the patient row, and
-- the conversation link have to agree or none of them may happen.
--
-- Two things this function refuses to take from its caller, and therefore from
-- the model that prompted the caller:
--   * the phone number — it is always the conversation's own participant
--     address, so an assistant cannot register a patient against a number that
--     is not the one writing to the clinic;
--   * a patient id — an existing patient is *found*, never named.
--
-- ## The identity model (C1)
--
-- The first version of this function matched an existing patient on
-- `phone OR national_id` and linked on a single hit either way. That was wrong,
-- and wrong in the one direction that matters: a national id is a value the
-- sender *types*, and in the markets ClinicFlow serves it is semi-public — it is
-- printed on the card and handed to employers, pharmacies and insurers. Anyone
-- who knew a patient's national id could bind their own WhatsApp number to that
-- patient's chart from any phone in the world, and every message, attachment and
-- booking they made afterwards was filed under the victim.
--
-- The evidence is now graded by what actually proved it:
--
--   * **The phone is proved.** It is the conversation's own participant address,
--     which WhatsApp established by delivering a message from it. It is the only
--     evidence here that the sender did not choose, and it is now a *necessary*
--     condition for touching an existing record — never a sufficient one.
--   * **Everything typed is a claim.** National id, date of birth and name are
--     checked *against* the record the phone selected. They can confirm a match;
--     they can never produce one.
--
-- So there are exactly three ways this function ends up touching a patient row:
--
--   1. `created` — nothing in the clinic matches this number *or* this national
--      id. A genuinely new person is registered against their own proved phone.
--   2. `linked_existing` — exactly one active patient holds this phone number,
--      **and** the supplied date of birth equals that patient's date of birth,
--      **and** the supplied national id agrees with the one on file (when there
--      is one), **and** the supplied name folds to the stored name. All four, or
--      no link.
--   3. everything else — `identity_mismatch`, `duplicate_review`,
--      `duplicate_ambiguous`, `identity_locked`. None of these write anything to
--      `conversations`, `inbound_messages`, `inbound_message_attachments` or
--      `patients`. The thread stays unlinked and a human decides.
--
-- Two consequences worth stating plainly:
--
--   * A national id that matches a patient whose phone is *not* the one writing
--     is `duplicate_review`. It does not link (that was the vulnerability) and it
--     does not create either, because creating would fork the chart of somebody
--     who already exists. Staff triage it from the Inbox, where they can see both
--     records.
--   * A failed check on the phone-matched path burns one of the conversation's
--     identity-verification attempts and can lock the conversation out, on the
--     same counter `verify_patient_conversation_dob` uses. Without that this
--     function would be an unrated oracle for the date of birth of whoever holds
--     the number, which is the exact thing the rate limit exists to prevent.
--
-- On success the conversation is stamped `identity_verified_at`, because by
-- construction the sender has now satisfied a *stronger* test than the DOB check
-- that stamp normally represents: they proved the phone and matched every stored
-- field. That stamp is what lets `create_preliminary_booking` require verified
-- state unconditionally — see lib/ai/tools/create-preliminary-booking.ts.
-- ---------------------------------------------------------------------------

-- The return type gains a column, so the old signature is dropped first.
drop function if exists public.register_patient_from_conversation(uuid, uuid, text, text, date, text);

/**
 * Folds a human name to something two spellings of the same person agree on:
 * case, surrounding and repeated whitespace, Arabic diacritics and tatweel, the
 * alef/ya/ta-marbuta variants, and Arabic-Indic digits. Deliberately *not* a
 * fuzzy match — it either folds to the same string or it does not, because a
 * similarity threshold is a dial somebody eventually turns the wrong way.
 */
create or replace function public.fold_patient_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.translate(
          pg_catalog.lower(
            pg_catalog.regexp_replace(coalesce(p_name, ''), '[ً-ْـ]', '', 'g')
          ),
          'أإآٱىيةؤئ٠١٢٣٤٥٦٧٨٩',
          'ااااييهوي0123456789'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

revoke all on function public.fold_patient_name(text) from public, anon, authenticated;
grant execute on function public.fold_patient_name(text) to service_role;

/** Case- and separator-insensitive comparison key for a national/civil id. */
create or replace function public.fold_national_id(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.translate(coalesce(p_value, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'),
        '[^0-9A-Za-z]', '', 'g'
      )
    ),
    ''
  );
$$;

revoke all on function public.fold_national_id(text) from public, anon, authenticated;
grant execute on function public.fold_national_id(text) to service_role;

create or replace function public.register_patient_from_conversation(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_full_name text,
  p_national_id text,
  p_date_of_birth date,
  p_email text
)
returns table (status text, patient_id uuid, file_number text, attempts_remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_phone text;
  v_full_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_national_id text := nullif(btrim(coalesce(p_national_id, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_phone_match public.patients%rowtype;
  v_phone_match_count integer;
  v_id_match_id uuid;
  v_id_match_count integer;
  v_next integer;
  v_candidate text;
  v_new_id uuid;
  v_created_by uuid;
  v_attempt integer;
  v_mismatch boolean;
  v_failures smallint;
  v_max_attempts constant integer := 5;
  v_lockout constant interval := interval '30 minutes';
begin
  -- Everything below works in locals and assigns the OUT parameters only at the
  -- return. The OUT names (status, patient_id, file_number) are also column
  -- names on the tables this touches, and an unqualified reference to one inside
  -- a statement is ambiguous (SQLSTATE 42702) rather than merely confusing.
  attempts_remaining := null;

  select c.*
    into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.channel = 'whatsapp'::public.message_channel
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  if v_conversation.patient_id is not null then
    select p.file_number into v_candidate
    from public.patients p where p.id = v_conversation.patient_id;
    status := 'already_linked';
    patient_id := v_conversation.patient_id;
    file_number := v_candidate;
    return next;
    return;
  end if;

  v_phone := nullif(btrim(coalesce(v_conversation.participant_address, '')), '');
  if v_phone is null then
    raise exception 'CONVERSATION_HAS_NO_ADDRESS';
  end if;

  if v_full_name is null or length(v_full_name) < 2 or length(v_full_name) > 100
     or v_national_id is null or v_national_id !~ '^[A-Za-z0-9]{5,32}$'
     or p_date_of_birth is null
     or p_date_of_birth < date '1900-01-01'
     or p_date_of_birth > (pg_catalog.now() at time zone 'utc')::date
     or v_email is null or length(v_email) > 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_PATIENT_DETAILS';
  end if;

  -- A conversation already locked out of identity verification does not get a
  -- second, unrated route to the same answer through registration.
  if v_conversation.identity_verification_locked_until is not null
     and v_conversation.identity_verification_locked_until > pg_catalog.now() then
    status := 'identity_locked';
    patient_id := null;
    file_number := null;
    attempts_remaining := 0;
    return next;
    return;
  end if;

  -- The two match keys, deliberately evaluated apart. Unioning them is what
  -- created C1: it made "somebody typed a number I recognise" and "WhatsApp
  -- proved this handset" the same fact.
  select count(*)::integer
    into v_phone_match_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and not p.is_deleted
    and p.deleted_at is null
    and p.phone = v_phone;
  if v_phone_match_count = 1 then
    select p.*
      into v_phone_match
    from public.patients p
    where p.clinic_id = p_clinic_id
      and not p.is_deleted
      and p.deleted_at is null
      and p.phone = v_phone
    limit 1;
  end if;

  select (array_agg(p.id order by p.created_at, p.id))[1], count(*)::integer
    into v_id_match_id, v_id_match_count
  from public.patients p
  where p.clinic_id = p_clinic_id
    and not p.is_deleted
    and p.deleted_at is null
    and public.fold_national_id(p.national_id) = public.fold_national_id(v_national_id);

  -- Two active records already hold this number. Choosing between two people's
  -- charts is not an automated decision, and never was.
  if v_phone_match_count > 1 then
    status := 'duplicate_ambiguous';
    patient_id := null;
    file_number := null;
    return next;
    return;
  end if;

  if v_phone_match_count = 1 then
    -- Every stored field must agree with what was typed. Any single
    -- disagreement — including a national id that names a *different* record —
    -- leaves the thread unlinked and costs an attempt.
    v_mismatch :=
      (v_id_match_count > 0 and v_id_match_id is distinct from v_phone_match.id)
      or v_phone_match.date_of_birth is distinct from p_date_of_birth
      or (v_phone_match.national_id is not null
          and public.fold_national_id(v_phone_match.national_id)
              is distinct from public.fold_national_id(v_national_id))
      or (public.fold_patient_name(v_phone_match.full_name) is not null
          and public.fold_patient_name(v_phone_match.full_name)
              is distinct from public.fold_patient_name(v_full_name));

    if v_mismatch then
      update public.conversations c
      set identity_verification_failures = least(c.identity_verification_failures + 1, v_max_attempts),
          identity_verification_locked_until = case
            when c.identity_verification_failures + 1 >= v_max_attempts
              then pg_catalog.now() + v_lockout
            else c.identity_verification_locked_until
          end
      where c.id = p_conversation_id
        and c.clinic_id = p_clinic_id
      returning c.identity_verification_failures into v_failures;
      status := case when v_failures >= v_max_attempts then 'identity_locked' else 'identity_mismatch' end;
      patient_id := null;
      file_number := null;
      attempts_remaining := greatest(v_max_attempts - v_failures, 0);
      return next;
      return;
    end if;

    -- Proved phone + every stored field confirmed. Link the thread and backfill
    -- the messages and files that arrived before the clinic knew who this was.
    update public.conversations c
    set patient_id = v_phone_match.id,
        patient_link_status = 'automatic'
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id;
    -- Separate statement on purpose: the BEFORE UPDATE trigger
    -- clear_conversation_identity_on_patient_change resets the identity stamps
    -- whenever patient_id changes, so stamping in the same statement would be
    -- silently undone.
    update public.conversations c
    set identity_verified_at = pg_catalog.now(),
        identity_verification_failures = 0,
        identity_verification_locked_until = null
    where c.id = p_conversation_id
      and c.clinic_id = p_clinic_id;
    update public.inbound_messages im
    set patient_id = v_phone_match.id
    where im.conversation_id = p_conversation_id
      and im.clinic_id = p_clinic_id
      and im.patient_id is null;
    update public.inbound_message_attachments a
    set patient_id = v_phone_match.id
    where a.conversation_id = p_conversation_id
      and a.clinic_id = p_clinic_id
      and a.patient_id is null;
    status := 'linked_existing';
    patient_id := v_phone_match.id;
    file_number := v_phone_match.file_number;
    return next;
    return;
  end if;

  -- No patient holds this number, but the national id names one (or several)
  -- that some other number does. This is the C1 case. It links nothing — the
  -- sender has produced no evidence they are that person — and it creates
  -- nothing either, because a second chart for an existing patient is its own
  -- kind of damage. It goes to a human.
  if v_id_match_count > 0 then
    status := 'duplicate_review';
    patient_id := null;
    file_number := null;
    return next;
    return;
  end if;

  -- patients.created_by is NOT NULL and references a real staff profile, and a
  -- WhatsApp registration has no signed-in actor. The record is attributed to
  -- the person who owns the thread, and otherwise to the clinic's longest-
  -- standing active admin — never to a synthetic or cross-clinic profile.
  select coalesce(
    (select pr.id from public.profiles pr
      where pr.id = v_conversation.assigned_to
        and pr.clinic_id = p_clinic_id
        and pr.is_active and not pr.is_deleted and pr.deleted_at is null),
    (select pr.id from public.profiles pr
      where pr.clinic_id = p_clinic_id
        and pr.role = 'admin'::public.user_role
        and pr.is_active and not pr.is_deleted and pr.deleted_at is null
      order by pr.created_at, pr.id
      limit 1)
  ) into v_created_by;
  if v_created_by is null then
    raise exception 'NO_REGISTRATION_ACTOR';
  end if;

  -- Serialize file-number allocation for this clinic; the unique index is the
  -- backstop, this is what stops the retry loop from being the normal path. The
  -- app-side allocator in lib/patients/mutations.ts takes the same lock, so a
  -- receptionist and a WhatsApp registration cannot compute the same number.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':patient-file-number', 0)
  );

  -- Ordering on the *number*, not on the text. `order by file_number desc`
  -- returns CF-9999 once CF-10000 exists, which makes the next candidate
  -- CF-10000 again — a permanent unique violation at the four-digit boundary.
  for v_attempt in 1..5 loop
    select coalesce(max((substring(p.file_number from 4))::integer), 0) + 1
      into v_next
    from public.patients p
    where p.clinic_id = p_clinic_id
      and p.file_number ~ '^CF-\d+$';
    v_candidate := 'CF-' || lpad(v_next::text, 4, '0');
    begin
      insert into public.patients (
        clinic_id,
        full_name,
        national_id,
        date_of_birth,
        phone,
        email,
        file_number,
        created_by
      ) values (
        p_clinic_id,
        v_full_name,
        v_national_id,
        p_date_of_birth,
        v_phone,
        v_email,
        v_candidate,
        v_created_by
      )
      returning id into v_new_id;
      exit;
    exception
      when unique_violation then
        -- A writer that did not take the advisory lock got there first. Bounded,
        -- so a genuinely stuck sequence surfaces as an error rather than a spin.
        if v_attempt >= 5 then raise; end if;
        v_new_id := null;
    end;
  end loop;
  if v_new_id is null then
    raise exception 'FILE_NUMBER_ALLOCATION_FAILED';
  end if;

  update public.conversations c
  set patient_id = v_new_id,
      patient_link_status = 'automatic'
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;
  -- A brand-new record built entirely from what this sender just supplied,
  -- against the number WhatsApp proved. There is no prior data behind it to
  -- protect, so the conversation starts verified and the patient can finish the
  -- booking they came for without a second identity round-trip.
  update public.conversations c
  set identity_verified_at = pg_catalog.now(),
      identity_verification_failures = 0,
      identity_verification_locked_until = null
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;
  update public.inbound_messages im
  set patient_id = v_new_id
  where im.conversation_id = p_conversation_id
    and im.clinic_id = p_clinic_id
    and im.patient_id is null;
  update public.inbound_message_attachments a
  set patient_id = v_new_id
  where a.conversation_id = p_conversation_id
    and a.clinic_id = p_clinic_id
    and a.patient_id is null;

  status := 'created';
  patient_id := v_new_id;
  file_number := v_candidate;
  return next;
end;
$$;

revoke all on function public.register_patient_from_conversation(uuid, uuid, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.register_patient_from_conversation(uuid, uuid, text, text, date, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. Documentation of the new columns
--
-- The inbox summary RPC is deliberately left alone: it returns aggregates, and
-- the Inbox already reads per-conversation state (identity, escalation) from
-- the conversations table directly under RLS. Display name and takeover join
-- that read rather than widening a function every surface shares.
-- ---------------------------------------------------------------------------

comment on column public.conversations.display_name is
  'WhatsApp-reported contact/push name. Display metadata only — never identity proof.';
comment on column public.conversations.ai_paused_at is
  'Human takeover: non-null blocks every automated agent send for this conversation.';
comment on column public.outbound_messages.body is
  'Full sent text for inbox threads only (related_type = manual). Analytics paths keep body_preview.';

-- ---------------------------------------------------------------------------
-- 10. Patient AI context — the clinic's country and the takeover flag
--
-- Two additions, both because the agent now has to reason about things it
-- previously did not have in hand:
--
--   * `clinic_country` decides how a bare `12/9/2000` is read. Getting that
--     from a guess rather than from the clinic's own record is how a
--     date-of-birth check matches the wrong person.
--   * `ai_paused` lets a tool refuse before it acts. The reply path already
--     gates sending; a conversation under human takeover should not be
--     creating bookings or registering patients either.
--
-- The return type changes, so the function is dropped and recreated.
-- ---------------------------------------------------------------------------

drop function if exists public.resolve_patient_ai_context(uuid, uuid);

create or replace function public.resolve_patient_ai_context(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (
  clinic_id uuid,
  conversation_id uuid,
  patient_id uuid,
  linked boolean,
  identity_verified_at timestamptz,
  identity_locked_until timestamptz,
  clinic_name text,
  clinic_locale text,
  clinic_timezone text,
  clinic_country text,
  participant_address text,
  ai_paused boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if not coalesce(public.effective_ai_feature(p_clinic_id, 'ai_assistant'), false)
     or not coalesce(public.effective_ai_feature(p_clinic_id, 'ai.patient_suggest'), false) then
    raise exception 'AI_FEATURE_NOT_ENTITLED' using errcode = '42501';
  end if;

  return query
  select
    conversation.clinic_id,
    conversation.id,
    conversation.patient_id,
    conversation.patient_id is not null,
    conversation.identity_verified_at,
    conversation.identity_verification_locked_until,
    clinic.name,
    clinic.locale,
    clinic.timezone,
    -- clinics.country is char(2); the OUT column is text, and PL/pgSQL refuses
    -- the mismatch outright rather than coercing it.
    clinic.country::text,
    conversation.participant_address,
    conversation.ai_paused_at is not null
  from public.conversations as conversation
  join public.clinics as clinic
    on clinic.id = conversation.clinic_id
   and clinic.is_active
  left join public.patients as patient
    on patient.id = conversation.patient_id
   and patient.clinic_id = conversation.clinic_id
   and not patient.is_deleted
   and patient.deleted_at is null
  where conversation.id = p_conversation_id
    and conversation.clinic_id = p_clinic_id
    and conversation.status = 'open'::public.conversation_status
    and (
      conversation.patient_id is null
      or patient.id is not null
    );
end;
$$;

revoke all on function public.resolve_patient_ai_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_patient_ai_context(uuid, uuid)
  to service_role;
