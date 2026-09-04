-- P11T — the conversation episode becomes a durable record.
--
-- ## What P11O left implicit
--
-- P11O drew the episode boundary as one timestamp on the conversation row,
-- `ai_context_reset_at`, and that column did the job it was written for: the
-- model stopped being handed the previous exchange. But an episode expressed as
-- a single mutable timestamp has three properties that are wrong for something
-- the whole isolation guarantee rests on:
--
--   1. **It has no identity.** Nothing can say "this message belongs to that
--      episode". The association is recomputed on every read by comparing
--      timestamps, so the invariant lives in each caller's WHERE clause rather
--      than in the data. A read that forgets `.gte(episodeStart)` silently
--      leaks a previous episode into the prompt, and nothing fails.
--   2. **It has no history.** The column is overwritten, so how many episodes a
--      thread has had, when each ended, and *why* it ended, are unrecoverable.
--      "Staff closed it", "the patient said no thanks" and "the five-minute
--      idle timer fired" are three different clinical facts that all left the
--      same single timestamp behind.
--   3. **NULL is ambiguous.** A thread that has never been closed has no
--      boundary at all, so "the current episode" and "everything that ever
--      happened on this thread" are the same set. That is the pre-P11O
--      behaviour surviving in the one case nobody closed yet.
--
-- ## The model
--
-- `conversation_episodes` is the explicit record: one row per episode, opened
-- when a thread starts or restarts, closed with a stated reason. The
-- conversation points at its current one via `current_episode_id`, and messages
-- carry the episode they were written in.
--
-- `ai_context_reset_at` is deliberately **kept** and kept in step: it is the
-- denormalized cut that every existing P11O/P11S read already uses, and an
-- episode's `started_at` is by definition the same instant. Keeping both means
-- this migration adds identity, history and a reason without changing the
-- boundary any current reader computes — the new model is authoritative, the
-- old column is its mirror, and the two cannot disagree because the same code
-- path writes both.
--
-- ## What an episode is not
--
-- It is not a retention boundary. No message is deleted, moved or hidden from
-- staff by anything here; `lib/messaging/inbox.ts` continues to read both
-- message tables unfiltered. An episode bounds *assistant memory* only. The
-- patient's file, the thread's verified WhatsApp linkage and the identity
-- verification stamp are properties of the person, not of an episode, and no
-- statement below touches them.
--
-- Additive throughout: one new table, three nullable columns, no drops.

-- ---------------------------------------------------------------------------
-- 1. The episode record
-- ---------------------------------------------------------------------------

create table if not exists public.conversation_episodes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The instant this episode began. Equal to the conversation's
  -- `ai_context_reset_at` while this episode is the current one.
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- 'active' — the assistant may build context from this episode.
  -- 'ended'  — a hard memory boundary. Nothing in it may reach the model again.
  status text not null default 'active'
    check (status in ('active', 'ended')),
  -- Why it ended, recorded because the three endings are different facts and a
  -- clinic reviewing a thread needs to tell them apart. Null while active.
  end_reason text
    check (end_reason is null or end_reason in (
      'manual_close',      -- a staff member pressed Close thread
      'assistant_close',   -- the patient said they needed nothing further
      'idle_timeout',      -- the five-minute end-of-goal timer fired
      'superseded'         -- a boundary reconstructed for a legacy thread
    )),
  created_at timestamptz not null default now(),
  -- An episode is either active with no ending, or ended with both an instant
  -- and a reason. There is no half-closed episode.
  constraint conversation_episodes_ended_consistent check (
    (status = 'active' and ended_at is null and end_reason is null)
    or (status = 'ended' and ended_at is not null and end_reason is not null)
  )
);

-- At most one active episode per conversation. This is the invariant that makes
-- "the current episode" a fact rather than a query: two active episodes would
-- mean two candidate contexts and no rule for choosing between them.
create unique index if not exists conversation_episodes_one_active_idx
  on public.conversation_episodes (conversation_id)
  where status = 'active';

create index if not exists conversation_episodes_thread_recent_idx
  on public.conversation_episodes (conversation_id, started_at desc);

create index if not exists conversation_episodes_clinic_idx
  on public.conversation_episodes (clinic_id, started_at desc);

alter table public.conversation_episodes enable row level security;

-- Staff read their own clinic's episodes; every write goes through the service
-- role, so opening and closing stay in one audited server path.
drop policy if exists "episodes_staff_read_own" on public.conversation_episodes;
create policy "episodes_staff_read_own"
on public.conversation_episodes for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

grant select on table public.conversation_episodes to authenticated;
grant all on table public.conversation_episodes to service_role;

-- ---------------------------------------------------------------------------
-- 2. The pointers
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists current_episode_id uuid
    references public.conversation_episodes(id) on delete set null;

comment on column public.conversations.current_episode_id is
  'P11T — the thread''s active episode, or null when the thread is resting (Done). Assistant context is built from this episode and no other.';

-- Message → episode association. Nullable because every row written before this
-- migration predates episode identity; those fall back to the timestamp
-- comparison P11O already performs, which yields the identical set.
alter table public.inbound_messages
  add column if not exists episode_id uuid
    references public.conversation_episodes(id) on delete set null;

alter table public.outbound_messages
  add column if not exists episode_id uuid
    references public.conversation_episodes(id) on delete set null;

create index if not exists inbound_messages_episode_idx
  on public.inbound_messages (episode_id, received_at)
  where episode_id is not null;

create index if not exists outbound_messages_episode_idx
  on public.outbound_messages (episode_id, created_at)
  where episode_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Opening an episode
-- ---------------------------------------------------------------------------

/**
 * Resolves the conversation's current episode, opening one if it is resting.
 *
 * This is the single entry point the assistant turn calls before it reads
 * anything. It is idempotent and race-safe: the partial unique index makes two
 * concurrent openers impossible, and the loser reads the winner's row.
 *
 * ## Why `started_at` is derived, not passed
 *
 * An episode's start and the P11O context boundary are the same instant by
 * definition, so the boundary decides — never the caller. `ai_context_reset_at`
 * is what the close path already wrote, and the whole of P11O/P11S computes
 * model context from it. Taking a caller-supplied start here would let the two
 * disagree, and an episode boundary that disagrees with the context cut is
 * worse than no episode record at all.
 *
 * A thread that has never been closed carries no boundary. Its episode starts
 * at the conversation's own creation, so the resolved set is the entire thread
 * — identical to the pre-P11T behaviour for exactly the case P11O left as NULL.
 */
create or replace function public.resolve_conversation_episode(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_started_at timestamptz default null
)
returns table (
  episode_id uuid,
  started_at timestamptz,
  opened boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_started timestamptz;
begin
  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  select e.id, e.started_at into episode_id, started_at
  from public.conversation_episodes e
  where e.conversation_id = p_conversation_id
    and e.clinic_id = p_clinic_id
    and e.status = 'active';
  if found then
    -- Repair a pointer that drifted (a crash between the two writes below).
    if v_conversation.current_episode_id is distinct from episode_id then
      update public.conversations
      set current_episode_id = episode_id
      where id = p_conversation_id;
    end if;
    opened := false;
    return next;
    return;
  end if;

  v_started := coalesce(
    v_conversation.ai_context_reset_at,
    p_started_at,
    v_conversation.created_at,
    pg_catalog.now()
  );

  insert into public.conversation_episodes (clinic_id, conversation_id, started_at)
  values (p_clinic_id, p_conversation_id, v_started)
  returning id, conversation_episodes.started_at into episode_id, started_at;

  update public.conversations
  set current_episode_id = episode_id
  where id = p_conversation_id;

  opened := true;
  return next;
end;
$$;

comment on function public.resolve_conversation_episode(uuid, uuid, timestamptz) is
  'P11T — the conversation''s active episode, opened if the thread was resting. Idempotent; started_at is always the P11O context boundary.';

revoke all on function public.resolve_conversation_episode(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.resolve_conversation_episode(uuid, uuid, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Ending an episode
-- ---------------------------------------------------------------------------

/**
 * Ends the conversation's active episode, with a stated reason.
 *
 * The three real endings — a staff member pressing Close thread, the patient
 * saying they need nothing more, and the five-minute idle timer — all arrive
 * here, and all produce the identical hard boundary. That is the requirement:
 * whichever way an episode ends, the next one starts with no memory of it.
 *
 * Idempotent. A thread with no active episode is already ended, which is a
 * normal outcome (two close paths racing, a sweep re-running in the same
 * minute) and not an error.
 *
 * This function does not write `ai_context_reset_at`. The application close
 * path owns that column and has since P11O, including the rule that a reopen
 * may fill a missing boundary but never move one a close already drew.
 * Duplicating that rule here would be a second writer for one fact.
 */
create or replace function public.close_conversation_episode(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_end_reason text,
  p_ended_at timestamptz default null
)
returns table (episode_id uuid, closed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ended timestamptz := coalesce(p_ended_at, pg_catalog.now());
begin
  if p_end_reason is null or p_end_reason not in
     ('manual_close', 'assistant_close', 'idle_timeout', 'superseded') then
    raise exception 'INVALID_EPISODE_END_REASON';
  end if;

  update public.conversation_episodes e
  set status = 'ended',
      -- An episode cannot end before it began: a clock skew or a close stamped
      -- with an old message's time must not produce a negative-length episode.
      ended_at = greatest(v_ended, e.started_at),
      end_reason = p_end_reason
  where e.conversation_id = p_conversation_id
    and e.clinic_id = p_clinic_id
    and e.status = 'active'
  returning e.id into episode_id;

  closed := episode_id is not null;

  -- Cleared whether or not this call is the one that ended the episode: a
  -- resting thread must never point at an episode, and a pointer left behind by
  -- a racing close is exactly the drift this prevents.
  update public.conversations
  set current_episode_id = null
  where id = p_conversation_id
    and clinic_id = p_clinic_id
    and current_episode_id is not null;

  return next;
end;
$$;

comment on function public.close_conversation_episode(uuid, uuid, text, timestamptz) is
  'P11T — ends a thread''s active episode with a stated reason and clears the current-episode pointer. Idempotent.';

revoke all on function public.close_conversation_episode(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_conversation_episode(uuid, uuid, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------

-- Every thread that already exists gets the episode record it has always had
-- implicitly, so that no code path has to carry a "conversations from before
-- P11T" branch and so the Inbox's derived status has an answer for every row
-- from the first request after this migration.
--
-- This writes to the new table and the new column only. It does **not** change
-- any conversation's `status`: an open thread stays open and a closed thread
-- stays closed. Normalizing the hosted backlog of open-but-finished threads is
-- a separate, explicitly-approved decision, and the dry-run classifier in
-- `scripts/p11t-episode-normalization-dry-run.ts` reports on it without writing.
insert into public.conversation_episodes (
  clinic_id, conversation_id, started_at, ended_at, status, end_reason
)
select
  c.clinic_id,
  c.id,
  -- An open thread's current episode began at its P11O boundary, or at the
  -- thread's own creation when it has never been closed. A closed thread's
  -- finished episode is recorded from creation: its `ai_context_reset_at` is
  -- the cut drawn *for the next* episode, not the start of the one that ended.
  case
    when c.status = 'open'::public.conversation_status
      then coalesce(c.ai_context_reset_at, c.created_at)
    else c.created_at
  end,
  case
    when c.status = 'open'::public.conversation_status then null
    else greatest(coalesce(c.status_updated_at, c.created_at), c.created_at)
  end,
  case
    when c.status = 'open'::public.conversation_status then 'active'
    else 'ended'
  end,
  case
    when c.status = 'open'::public.conversation_status then null
    -- 'superseded' rather than 'manual_close': these threads were closed before
    -- an end reason was recorded, and inventing one would put a fact in the
    -- audit trail that nobody established.
    else 'superseded'
  end
from public.conversations c
where not exists (
  select 1 from public.conversation_episodes e where e.conversation_id = c.id
);

update public.conversations c
set current_episode_id = e.id
from public.conversation_episodes e
where e.conversation_id = c.id
  and e.status = 'active'
  and c.current_episode_id is null;

-- ---------------------------------------------------------------------------
-- 6. The idle sweep ends episodes too
-- ---------------------------------------------------------------------------

-- P11S's five-minute sweep already performs the full state reset and stamps the
-- P11O boundary. The requirement is that all three endings — staff Close, the
-- patient saying they need nothing more, and this timer — are the *same* hard
-- termination, so the sweep must also end the episode record and clear the
-- current-episode pointer. Without this, an idle-closed thread would keep an
-- `active` episode row and read as AI_HANDLING in the Inbox while being closed.
--
-- Replaced wholesale rather than patched: `create or replace function` is the
-- only way to change a function body, and the P11S migration is already applied
-- and must not be edited. Everything above the episode block below is P11S's
-- logic, unchanged.
create or replace function public.close_idle_patient_ai_episodes(
  p_now timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_closed integer := 0;
  -- The threads this run actually closed. An array rather than a temporary
  -- table: PostgREST reuses its connections, so session-scoped DDL inside a
  -- function called over HTTP is state that outlives the call that created it.
  -- A local variable has no such lifetime.
  v_swept uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with due as (
    select c.id
    from public.conversations c
    where c.ai_auto_close_after is not null
      and c.ai_auto_close_after <= v_now
      and c.status = 'open'::public.conversation_status
      -- A human is holding this thread, or has been handed it. Neither is a
      -- finished episode, whatever the timer says.
      and c.ai_paused_at is null
      and c.ai_escalated_at is null
      -- The stale-timer guard. Anything the patient said after the offer was
      -- made means the episode continued, and the timer describes a state the
      -- conversation has already left.
      and not exists (
        select 1
        from public.inbound_messages im
        where im.conversation_id = c.id
          and im.received_at > coalesce(c.ai_auto_close_armed_at, c.ai_auto_close_after)
      )
    for update skip locked
  ), swept as (
    update public.conversations c
    set status = 'closed'::public.conversation_status,
        status_updated_at = v_now,
        ai_auto_close_after = null,
        ai_auto_close_armed_at = null,
        -- The same episode reset "Close thread" performs, minus the parts that
        -- belong to the person: patient_id, patient_link_status,
        -- identity_verified_at and every message row are untouched.
        ai_collected_data = '{}'::jsonb,
        ai_pending_clarification = null,
        ai_booking_stage = null,
        ai_paused_at = null,
        ai_last_replied_at = null,
        ai_context_reset_at = v_now
    from due
    where c.id = due.id
    returning c.id
  )
  select coalesce(array_agg(swept.id), '{}'::uuid[]) into v_swept from swept;
  v_closed := coalesce(array_length(v_swept, 1), 0);

  -- P11T — the durable ending, with its reason. Identical in effect to the
  -- staff-close and patient-close paths: the episode is `ended`, the pointer is
  -- cleared, and nothing inside it can reach the model again.
  update public.conversation_episodes e
  set status = 'ended',
      ended_at = greatest(v_now, e.started_at),
      end_reason = 'idle_timeout'
  where e.status = 'active'
    and e.conversation_id = any (v_swept);

  update public.conversations c
  set current_episode_id = null
  where c.id = any (v_swept)
    and c.current_episode_id is not null;

  -- A draft written for a finished exchange must never become sendable.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.status = 'pending'
    and s.conversation_id = any (v_swept);

  return v_closed;
end;
$$;

revoke all on function public.close_idle_patient_ai_episodes(timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_idle_patient_ai_episodes(timestamptz)
  to service_role;
