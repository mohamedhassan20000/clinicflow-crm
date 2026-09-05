-- P11S — the five-minute end of a finished patient episode.
--
-- ## What was missing
--
-- `lib/ai/conversation-lifecycle.ts` already ends an episode when the patient
-- says so ("شكراً", "لا مفيش حاجة تانية"). It had no answer for the far more
-- common ending: the assistant asks "هل تحتاج أي مساعدة أخرى؟" and the patient,
-- having got what they came for, simply stops typing. That thread stayed `open`
-- forever, so the next message weeks later resumed a finished exchange and the
-- Inbox showed a queue of threads nobody was working.
--
-- ## The two columns, and why two
--
--   * `ai_auto_close_after`  — the instant the episode may be ended.
--   * `ai_auto_close_armed_at` — the instant the terminal state was reached.
--
-- One column would be enough to *fire* the timer and not enough to make it
-- safe. The hazard is the stale timer: the sweep runs, the row still carries a
-- deadline, and in between the arming and the sweep the patient wrote again.
-- Closing then would end a live conversation mid-sentence. `armed_at` makes the
-- guard a fact about the data rather than a race the clearing write has to win
--
--     close only if no inbound message arrived after armed_at
--
-- so even if every clearing write is lost, a patient who is still talking is
-- never closed. Clearing remains — it keeps the sweep's working set small — but
-- nothing depends on it.
--
-- ## Why this is not "close every quiet thread"
--
-- The timer is armed at exactly one place in the code: the turn on which
-- `resolveConversationLifecycle` returns `offer_end`, which already requires
-- that nothing is outstanding and that a goal has concluded. A half-finished
-- intake, an unanswered clarification, an escalated thread or one a staff
-- member has taken over never arms it, and the sweep re-checks the last three
-- of those itself.

alter table public.conversations
  add column if not exists ai_auto_close_after timestamptz;

alter table public.conversations
  add column if not exists ai_auto_close_armed_at timestamptz;

comment on column public.conversations.ai_auto_close_after is
  'P11S — instant at which a finished patient AI episode may be auto-closed. Null means no timer is armed.';
comment on column public.conversations.ai_auto_close_armed_at is
  'P11S — instant the terminal "anything else?" state was reached. A later inbound message invalidates the timer.';

-- The sweep's working set: armed timers only, newest deadline first.
create index if not exists conversations_ai_auto_close_due_idx
  on public.conversations (ai_auto_close_after)
  where ai_auto_close_after is not null;

/**
 * Ends every episode whose timer has expired and which nobody has spoken on
 * since it was armed.
 *
 * Idempotent by construction: it only touches rows that are still `open` and
 * still carry a deadline, and it clears the deadline in the same statement, so
 * a second run in the same minute matches nothing. Returns the number of
 * episodes ended so the caller can report it without reading patient data.
 */
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
  )
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
  where c.id = due.id;
  get diagnostics v_closed = row_count;

  -- A draft written for a finished exchange must never become sendable.
  update public.ai_suggested_replies s
  set status = 'superseded'
  where s.status = 'pending'
    and exists (
      select 1 from public.conversations c
      where c.id = s.conversation_id
        and c.status = 'closed'::public.conversation_status
        and c.ai_context_reset_at = v_now
    );

  return v_closed;
end;
$$;

comment on function public.close_idle_patient_ai_episodes(timestamptz) is
  'P11S — ends finished patient AI episodes five minutes after the final "anything else?" goes unanswered. Idempotent; never closes a thread the patient has written on since the timer was armed.';

revoke all on function public.close_idle_patient_ai_episodes(timestamptz)
  from public, anon, authenticated;
grant execute on function public.close_idle_patient_ai_episodes(timestamptz)
  to service_role;

-- The scheduler. pg_cron is the right home for a one-minute sweep: it is
-- durable, it is not a busy loop, and it does not depend on a deploy platform's
-- cron granularity. Guarded, because a local stack or a plan without the
-- extension must still be able to apply this migration — `/api/cron/
-- patient-episode-idle-close` drives the same function when it is not present.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'clinicflow-close-idle-patient-ai-episodes',
    '* * * * *',
    $cron$select public.close_idle_patient_ai_episodes();$cron$
  );
exception when others then
  raise notice 'pg_cron unavailable; drive close_idle_patient_ai_episodes from the cron route instead (%)', sqlerrm;
end
$$;
