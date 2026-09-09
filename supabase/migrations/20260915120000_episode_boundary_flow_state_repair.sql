-- Episode boundary repair — the two SQL boundaries that do not run in a process.
--
-- Three of the five episode boundaries go through
-- `resetConversationAssistantState` in TypeScript (staff Close thread, the
-- assistant's own close, the reopen-on-inbound), and all three clear the V2
-- flow stack and end the durable episode. The other two run entirely in SQL and
-- have to do that work themselves. Both are currently incomplete, in opposite
-- directions, and this migration corrects each.
--
-- ---------------------------------------------------------------------------
-- A. `close_idle_patient_ai_episodes` — a P11T regression
-- ---------------------------------------------------------------------------
--
-- The function has been replaced three times:
--
--   P11S (20260904130000)  introduced it. No episode records existed yet.
--   P11T (20260905120000)  taught it to end `conversation_episodes` with
--                          `end_reason = 'idle_timeout'` and to clear
--                          `conversations.current_episode_id`, so an
--                          idle-closed thread stops pointing at an episode.
--   V2   (20260913120000)  added `ai_flow_state = null` — but rebuilt the body
--                          from P11S's, "with one line added and nothing else
--                          changed". P11S predates P11T, so the rebuild
--                          silently reverted both P11T writes.
--
-- `create or replace` means the newest definition wins outright, so since the
-- V2 migration an idle-closed thread has kept an `active` episode row carrying
-- its *original* `started_at`. The next inbound then resolves that stale
-- episode rather than opening a new one, `EpisodeContext` bounds the turn at
-- the previous episode's start, and the patient assistant is handed a
-- conversation that had already finished — while `ai_flow_state` is correctly
-- null. An empty flow stack over a stale transcript is precisely the
-- "generic, and yet carrying old context" behaviour reported from manual QA.
--
-- The body below is reconstructed from P11T's — the latest definition that was
-- authoritative about episode bookkeeping — with the V2 line folded in, rather
-- than copied from either file wholesale. Concretely it is the union:
--
--   * P11T's `v_swept` array, episode ending and pointer clearing, and P11T's
--     precise `s.conversation_id = any (v_swept)` draft supersession (the V2
--     body had regressed that to a correlated `exists` on `ai_context_reset_at
--     = v_now`, which would also catch a thread another path happened to reset
--     in the same statement);
--   * the V2 migration's `ai_flow_state = null`.
--
-- Nothing else changes. The selection predicate, the service-role guard, the
-- grants and every column the sweep already cleared are identical to what is in
-- production today.
--
-- ---------------------------------------------------------------------------
-- B. `normalize_stale_patient_conversation_episode` — a missing column
-- ---------------------------------------------------------------------------
--
-- This is the fifth boundary: a conversation linked to a patient row that has
-- since been soft-deleted has its link dropped and a fresh
-- `ai_context_reset_at` drawn before any stage or authority is resolved. It
-- clears every legacy assistant column and predates `ai_flow_state`, so the new
-- episode it declares begins holding the previous one's booking frame — a
-- half-collected booking, its slots, and an open offer, all attributed to an
-- episode the patient never had.
--
-- One line added. Every other statement, including the live-patient early
-- return that makes the function idempotent and the draft supersession, is
-- unchanged.
--
-- ---------------------------------------------------------------------------
-- What this migration does not touch
-- ---------------------------------------------------------------------------
--
-- No schema change, no policy change, no grant change: both functions keep
-- their `security definer`, their empty `search_path`, their service-role guard
-- and their existing `revoke`/`grant` pair. Nothing about a person is written
-- by either function or by this file — `patient_id`, `patient_link_status`,
-- `identity_verified_at`, `booking_identity_confirmed_at` and every message row
-- are outside both boundaries, except where B already cleared linkage as its
-- entire purpose. No message is deleted or rewritten anywhere.

-- ---------------------------------------------------------------------------
-- A. The idle sweep, with both P11T's episode bookkeeping and V2's flow reset
-- ---------------------------------------------------------------------------

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
        -- The V2 flow stack. This sweep is one of the two episode boundaries no
        -- process ever runs, so `resetConversationAssistantState` cannot clear
        -- it here and the statement has to. Without this line an idle-closed
        -- episode kept its stack, and the next episode could be *offered* a
        -- resume of the previous one's booking.
        ai_flow_state = null,
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
  --
  -- This block and the pointer clear below are what the V2 migration dropped.
  -- Their absence is not visible in the conversation row — the sweep still
  -- closes the thread and still stamps `ai_context_reset_at` — which is why the
  -- regression survived a release: the damage shows up one turn later, when
  -- `resolve_conversation_episode` finds the episode still active and returns
  -- its original `started_at` as the boundary of record.
  update public.conversation_episodes e
  set status = 'ended',
      -- An episode cannot end before it began: a clock skew, or a sweep run
      -- with an explicit `p_now`, must not produce a negative-length episode.
      ended_at = greatest(v_now, e.started_at),
      end_reason = 'idle_timeout'
  where e.status = 'active'
    and e.conversation_id = any (v_swept);

  update public.conversations c
  set current_episode_id = null
  where c.id = any (v_swept)
    and c.current_episode_id is not null;

  -- A draft written for a finished exchange must never become sendable.
  --
  -- Scoped to the threads this run swept. The V2 body matched instead on
  -- `ai_context_reset_at = v_now`, which is the same set in the ordinary case
  -- and a superset whenever another boundary stamped the identical instant.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.status = 'pending'
    and s.conversation_id = any (v_swept);

  return v_closed;
end;
$$;

comment on function public.close_idle_patient_ai_episodes(timestamptz) is
  'P11S/P11T/V2 — ends idle patient AI episodes: closes the thread, clears the '
  'assistant''s conversational state including the V2 flow stack, ends the '
  'durable episode with end_reason ''idle_timeout'' and clears the '
  'current-episode pointer. Nothing about the patient is touched.';

revoke all on function public.close_idle_patient_ai_episodes(timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_idle_patient_ai_episodes(timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- B. The stale-link normalizer, taught about the V2 flow stack
-- ---------------------------------------------------------------------------

create or replace function public.normalize_stale_patient_conversation_episode(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns table (reset_performed boolean, context_reset_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_boundary timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id
    and c.status = 'open'::public.conversation_status
  for update;

  if not found then
    return;
  end if;

  -- Null is already the normalized, idempotent state. A live same-clinic
  -- patient is authoritative and must never be reset by this function.
  if v_conversation.patient_id is null or exists (
    select 1
    from public.patients p
    where p.id = v_conversation.patient_id
      and p.clinic_id = p_clinic_id
      and not p.is_deleted
      and p.deleted_at is null
  ) then
    reset_performed := false;
    context_reset_at := v_conversation.ai_context_reset_at;
    return next;
    return;
  end if;

  -- The newest inbound row is the first message of the fresh episode. Using
  -- its stored timestamp (and the model read's >= comparison) keeps that turn
  -- visible while excluding every older episode. The clock is only a fallback
  -- for a legacy conversation with no inbound rows at all.
  select coalesce(max(m.received_at), clock_timestamp()) into v_boundary
  from public.inbound_messages m
  where m.clinic_id = p_clinic_id
    and m.conversation_id = p_conversation_id;

  update public.conversations c
  set patient_id = null,
      patient_link_status = 'unlinked',
      booking_identity_confirmed_at = null,
      identity_verified_at = null,
      identity_verification_failures = 0,
      identity_verification_locked_until = null,
      ai_collected_data = '{}'::jsonb,
      ai_pending_clarification = null,
      ai_booking_stage = null,
      -- The V2 flow stack, cleared with the rest of the episode state. This
      -- statement draws a new `ai_context_reset_at` two lines below, so
      -- everything above it belongs to an episode that has just ended; a
      -- surviving stack would hand the new one a half-collected booking, its
      -- slots and an open offer belonging to a patient link this function is
      -- in the middle of dropping.
      ai_flow_state = null,
      ai_escalated_at = null,
      ai_escalation_reason = null,
      ai_paused_at = null,
      ai_last_replied_at = null,
      ai_context_reset_at = v_boundary
  where c.id = p_conversation_id
    and c.clinic_id = p_clinic_id;

  -- Preserve the draft as audit history but make it impossible to send in the
  -- new episode.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.clinic_id = p_clinic_id
    and s.conversation_id = p_conversation_id
    and s.status = 'pending';

  reset_performed := true;
  context_reset_at := v_boundary;
  return next;
end;
$$;

comment on function public.normalize_stale_patient_conversation_episode(uuid, uuid) is
  'Drops a conversation link to a soft-deleted patient and starts a fresh '
  'assistant episode: clears the legacy conversational columns and the V2 flow '
  'stack, draws a new ai_context_reset_at, and supersedes pending drafts. '
  'Forward-only; no message, appointment or patient row is deleted.';

revoke all on function public.normalize_stale_patient_conversation_episode(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.normalize_stale_patient_conversation_episode(uuid, uuid)
  to service_role;
