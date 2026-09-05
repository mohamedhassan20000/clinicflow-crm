-- P15 — canonical Inbox conversation status + clinic-wide AI response control.
--
-- Additive only. No column is dropped, no existing column changes type or
-- nullability, no data is backfilled, and every new column has a null/default
-- reading that reproduces today's behaviour exactly. A build that ships before
-- this migration keeps working; a database that has this migration and an old
-- build keeps working too.
--
-- Three things are added and nothing else:
--
--   1. `conversations.ai_enabled_override` — the per-conversation exception to
--      the clinic-wide AI setting. Null means "follow the clinic", which is
--      what every existing row means today.
--   2. `conversations.ai_technical_failure_at` / `_reason` — the latch behind
--      the "Problem" status, and the thing that makes the one-time safe
--      fallback message idempotent under retries.
--   3. `outbound_messages.ingestion_origin` — whether an outbound row is a
--      live send/echo or a message replayed by the history import. The Inbox
--      needs this to tell "a colleague just answered from their phone" from
--      "we imported a year of their sent messages", and there is no other
--      column that can answer it.
--
-- The clinic-wide switch is deliberately NOT a new column: `clinics.ai_reply_mode`
-- already is that switch (`off` = replies off everywhere), is already
-- entitlement-gated, and is already what the orchestrator refuses to speak
-- without. A second clinic-level boolean would be a second source of truth.

-- ---------------------------------------------------------------------------
-- 1. Per-conversation AI exception
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists ai_enabled_override boolean;

comment on column public.conversations.ai_enabled_override is
  'P15: per-conversation exception to clinics.ai_reply_mode. NULL = follow the '
  'clinic, TRUE = the assistant answers here even when the clinic is off, '
  'FALSE = the assistant never answers here even when the clinic is on. '
  'ai_paused_at (human takeover) suppresses independently and always wins.';

-- The Inbox and the orchestrator both ask "which threads has the clinic
-- excluded/admitted?", which is a tiny minority of rows on any clinic.
create index if not exists conversations_ai_override_idx
  on public.conversations (clinic_id, ai_enabled_override)
  where ai_enabled_override is not null;

-- ---------------------------------------------------------------------------
-- 2. Technical-failure latch
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists ai_technical_failure_at timestamptz,
  add column if not exists ai_technical_failure_reason text;

alter table public.conversations
  drop constraint if exists conversations_ai_technical_failure_reason_check;
alter table public.conversations
  add constraint conversations_ai_technical_failure_reason_check
  check (
    ai_technical_failure_reason is null
    or ai_technical_failure_reason in (
      'provider_failure',
      'orchestration_failure',
      'backend_failure',
      'send_failure'
    )
  );

comment on column public.conversations.ai_technical_failure_at is
  'P15: set only when the assistant should have handled a LIVE inbound turn and '
  'a genuine technical fault stopped it. Never set for ordinary conversational '
  'outcomes (ambiguity, an unavailable slot, an unsupported question, a '
  'validation prompt) — those are conversation, not breakage. Drives the '
  '"Problem" Inbox status and makes the one safe fallback message idempotent.';

create index if not exists conversations_ai_technical_failure_idx
  on public.conversations (clinic_id, ai_technical_failure_at desc)
  where ai_technical_failure_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Outbound provenance
-- ---------------------------------------------------------------------------
--
-- Default 'live' rather than null: every row that exists today was written by
-- a live send or a live echo, except the ones the history import wrote, and
-- those are NOT retro-labelled here. Backfilling them would require deciding
-- which historical rows were imports, and the only honest answer for an
-- existing row is "we did not record it" — so existing rows keep the default
-- and the distinction begins applying to rows written from now on. The Inbox
-- consumer treats a missing/unknown value as live, which is the pre-P15
-- reading.

alter table public.outbound_messages
  add column if not exists ingestion_origin text not null default 'live';

alter table public.outbound_messages
  drop constraint if exists outbound_messages_ingestion_origin_check;
alter table public.outbound_messages
  add constraint outbound_messages_ingestion_origin_check
  check (ingestion_origin in ('live', 'history_sync'));

comment on column public.outbound_messages.ingestion_origin is
  'P15: ''live'' for a message ClinicFlow sent or a live echo of one typed on '
  'the clinic''s linked handset; ''history_sync'' for one replayed by the '
  'WhatsApp history import. Only ''live'' counts as human handling.';

-- ---------------------------------------------------------------------------
-- 3b. A fourth way an episode can end
-- ---------------------------------------------------------------------------
--
-- P11T enumerated three endings, all of them intentional: staff closed it, the
-- patient said they needed nothing more, the idle timer fired. P15 adds one
-- that is not intentional at all — the assistant hit a technical fault it
-- cannot recover from and must stop. It is a distinct fact from the other
-- three and a clinic reading the episode record has to be able to tell it
-- apart, so it gets its own reason rather than being filed under one of them.

alter table public.conversation_episodes
  drop constraint if exists conversation_episodes_end_reason_check;
alter table public.conversation_episodes
  add constraint conversation_episodes_end_reason_check
  check (end_reason is null or end_reason in (
    'manual_close',
    'assistant_close',
    'idle_timeout',
    'superseded',
    'technical_failure'
  ));

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
     ('manual_close', 'assistant_close', 'idle_timeout', 'superseded',
      'technical_failure') then
    raise exception 'INVALID_EPISODE_END_REASON';
  end if;

  update public.conversation_episodes e
  set status = 'ended',
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
  --
  -- `current_episode_id is not null` carries P11T's guard forward unchanged. A
  -- close is called repeatedly by design — two close paths racing, the idle
  -- sweep re-running in the same minute — and without the predicate every one
  -- of those no-ops rewrites the row and fires `trg_conversations_updated_at`,
  -- so a thread nobody has touched keeps reporting a fresh `updated_at`.
  update public.conversations
  set current_episode_id = null
  where id = p_conversation_id
    and clinic_id = p_clinic_id
    and current_episode_id is not null;

  return next;
end;
$$;

revoke all on function public.close_conversation_episode(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_conversation_episode(uuid, uuid, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. set_conversation_ai_override
-- ---------------------------------------------------------------------------
--
-- The per-conversation exception, decided under the same row lock the pause
-- control uses so two staff members clicking at once produce one transition.
-- `changed = false` means somebody else got there first.

create or replace function public.set_conversation_ai_override(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_override boolean,
  p_actor_id uuid
)
returns table (changed boolean, override boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  -- `is not distinct from` rather than `=`: the override is nullable, and
  -- null = null is null, which would make every "back to following the clinic"
  -- click read as a change.
  if v_conversation.ai_enabled_override is not distinct from p_override then
    changed := false;
    override := v_conversation.ai_enabled_override;
    return next;
    return;
  end if;

  update public.conversations
  set ai_enabled_override = p_override
  where id = p_conversation_id and clinic_id = p_clinic_id
  returning * into v_conversation;

  -- Admitting a conversation to the assistant while a colleague is holding it
  -- would be two people answering the same patient. Explicitly enabling the
  -- assistant here therefore releases the takeover, which is the same thing
  -- "Resume AI" does and is the only reading of the click that is not a
  -- contradiction.
  if p_override is true and v_conversation.ai_paused_at is not null then
    update public.conversations
    set ai_paused_at = null, ai_paused_by = null, ai_pause_reason = null
    where id = p_conversation_id and clinic_id = p_clinic_id
    returning * into v_conversation;
  end if;

  perform p_actor_id;
  changed := true;
  override := v_conversation.ai_enabled_override;
  return next;
end;
$$;

revoke all on function public.set_conversation_ai_override(uuid, uuid, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.set_conversation_ai_override(uuid, uuid, boolean, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. latch_conversation_ai_technical_failure
-- ---------------------------------------------------------------------------
--
-- Returns whether THIS call is the one that latched the failure. That return
-- value is the entire idempotency mechanism for the safe fallback message: the
-- caller sends the one apology only when it gets `true`, so a webhook retry, a
-- duplicate provider delivery, or two workers racing the same turn cannot send
-- the patient the same apology twice.
--
-- The episode is ended in the same statement, because a thread the assistant
-- cannot continue is a thread the assistant must stop trying to continue.

create or replace function public.latch_conversation_ai_technical_failure(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_reason text
)
returns table (latched boolean, failed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;

  if v_conversation.ai_technical_failure_at is not null then
    latched := false;
    failed_at := v_conversation.ai_technical_failure_at;
    return next;
    return;
  end if;

  update public.conversations
  set ai_technical_failure_at = v_now,
      ai_technical_failure_reason = p_reason,
      -- End the episode. The assistant stops here; the thread is a person's
      -- problem now. `current_episode_id` is cleared so nothing resumes the
      -- half-finished intake the failure interrupted.
      current_episode_id = null,
      ai_context_reset_at = v_now,
      ai_collected_data = '{}'::jsonb,
      ai_pending_clarification = null,
      ai_auto_close_after = null,
      ai_auto_close_armed_at = null
  where id = p_conversation_id and clinic_id = p_clinic_id
  returning * into v_conversation;

  update public.conversation_episodes
  set status = 'ended', ended_at = v_now, end_reason = 'technical_failure'
  where clinic_id = p_clinic_id
    and conversation_id = p_conversation_id
    and status = 'active';

  latched := true;
  failed_at := v_now;
  return next;
end;
$$;

revoke all on function public.latch_conversation_ai_technical_failure(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.latch_conversation_ai_technical_failure(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. clear_conversation_ai_technical_failure
-- ---------------------------------------------------------------------------
--
-- The failure is a latch, not a life sentence. Staff resolving the thread, or
-- a later successful assistant turn, clears it so the badge is self-healing.

create or replace function public.clear_conversation_ai_technical_failure(
  p_clinic_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cleared boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.conversations
  set ai_technical_failure_at = null, ai_technical_failure_reason = null
  where id = p_conversation_id
    and clinic_id = p_clinic_id
    and ai_technical_failure_at is not null;
  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;

revoke all on function public.clear_conversation_ai_technical_failure(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.clear_conversation_ai_technical_failure(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. set_conversation_ai_pause leaves the override alone
-- ---------------------------------------------------------------------------
--
-- Replaces the P8 body. The transition logic, the row lock, the no-op
-- detection and the return shape are all unchanged, and so — deliberately — is
-- the set of columns this function writes: the three pause columns and nothing
-- else.
--
-- An earlier draft of P15 had pausing also write `ai_enabled_override = false`
-- and resuming withdraw it, so that "will the assistant answer here?" had a
-- single stored answer. That is the one thing this function must not do, for a
-- reason that is structural rather than incidental: `false` is `false`. Once
-- the pause has written it, nothing in the row can distinguish the exception
-- the pause wrote from an exception the clinic set deliberately, so the resume
-- had to guess — and it guessed "mine", silently erasing a standing clinic
-- decision the moment a receptionist finished a takeover.
--
-- A snapshot column (remember the override, restore it on resume) fixes that
-- single sequence and reintroduces the same class of bug one step along: staff
-- changing the exception *while* paused would have their new decision
-- overwritten by a stale snapshot on resume. The stored answer is the problem,
-- not the shape of the store.
--
-- So the two facts stay two columns, because they are two facts:
--
--   * `ai_paused_at` — "I am answering this one, right now." Momentary, owned
--     by whoever is on shift, and always suppresses automatic sending.
--   * `ai_enabled_override` — "this thread is/is not the assistant's." A
--     standing decision the clinic sets and leaves set.
--
-- They are combined into the single question at read time, in exactly one
-- place — `resolveEffectiveConversationAi` in lib/messaging/ai-enablement.ts,
-- where the pause wins towards *off* whatever the override says. One answer,
-- derived from two facts, is not two sources of truth; two columns that both
-- try to store the same answer is.
--
-- Which makes every case below fall out rather than needing to be handled:
-- pause and resume are exactly reversible because the resume restores nothing,
-- an explicit `true`/`false`/`null` survives any number of takeovers untouched,
-- both directions stay idempotent through the no-op branch above, and changing
-- the exception mid-takeover simply takes effect.

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
        -- `ai_enabled_override` is deliberately absent. Ending a takeover says
        -- "I am no longer the one answering this thread"; it says nothing about
        -- whether the thread is the assistant's, which is the clinic's standing
        -- decision and is not this control's to withdraw. See the note above.
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
-- 8. mark_conversation_human_reply
-- ---------------------------------------------------------------------------
--
-- A live outbound echo from the clinic's own handset is a person answering.
-- The Inbox derives "Active conversation" from the outbound rows themselves
-- (newest live, unattributed, manual reply vs newest inbound), so this exists
-- only to release the assistant's hold on a thread a human has entered: the
-- five-minute idle close no longer describes it, and the assistant must not
-- talk over the colleague who just replied.
--
-- Deliberately does NOT set ai_paused_at: an echo is evidence that somebody
-- answered once, not a declaration that they are taking the thread over. That
-- declaration is the Pause AI control, and only a person may make it.

create or replace function public.mark_conversation_human_reply(
  p_clinic_id uuid,
  p_conversation_id uuid,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.conversations
  set ai_auto_close_after = null,
      ai_auto_close_armed_at = null,
      last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at)
  where id = p_conversation_id and clinic_id = p_clinic_id;
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.mark_conversation_human_reply(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_conversation_human_reply(uuid, uuid, timestamptz)
  to service_role;
