-- Phase 6 review finding P6-04: scrub the residue the transcript purge left behind.
--
-- `20260814130000_ai_assistant_phase6_retention.sql` deletes `agent_messages`
-- past the window and deliberately never deletes `agent_conversations`, because
-- `ai_action_receipts` and `ai_action_confirmations` cascade from it and would be
-- destroyed ahead of their own, longer windows. That reasoning is correct — but
-- the conversation row was left *entirely untouched*, and two of its columns are
-- exactly the content the window exists to expire:
--
--   * `title`          — populated verbatim from the user's first message
--                        (`input.userText.trim().slice(0, 120)`), so a title
--                        reads e.g. "What is <patient>'s blood type?".
--   * `active_context` — server-derived patient/appointment ids that
--                        re-identify that text.
--
-- Both survived the purge permanently, making the stated retention guarantee
-- materially weaker than the policy claims. This migration adds a fourth step
-- that `update`s them to null (never `delete`s, so receipts and confirmations
-- keep their parent) once a conversation is past the message window and has no
-- surviving messages, and reports how many rows it scrubbed.
--
-- The function's return type changes, so it is dropped and recreated. Everything
-- else about it is unchanged: service-role only, `set search_path = ''`, windows
-- as arguments, fail-closed validation, batch-bounded, idempotent.

drop function if exists public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
);

create function public.purge_ai_retention_data(
  p_message_retention_days integer,
  p_receipt_retention_days integer,
  p_confirmation_retention_days integer,
  p_now timestamptz default clock_timestamp(),
  p_batch_limit integer default 10000
)
returns table (
  deleted_messages integer,
  deleted_receipts integer,
  deleted_confirmations integer,
  scrubbed_conversations integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_messages integer := 0;
  v_receipts integer := 0;
  v_confirmations integer := 0;
  v_scrubbed integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to purge AI retention data'
      using errcode = '42501';
  end if;
  -- Fail closed on a nonsensical window rather than deleting everything.
  if p_message_retention_days is null or p_message_retention_days < 1
    or p_receipt_retention_days is null or p_receipt_retention_days < 1
    or p_confirmation_retention_days is null or p_confirmation_retention_days < 1
    or p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 100000 then
    raise exception 'Invalid AI retention window'
      using errcode = '22023';
  end if;
  -- A receipt must never outlive its own conversation's ability to explain it,
  -- and the ledger is the longer-lived record by design.
  if p_receipt_retention_days < p_message_retention_days then
    raise exception 'AI receipt retention must not be shorter than message retention'
      using errcode = '22023';
  end if;

  with expired as (
    select id from public.agent_messages
    where created_at < p_now - make_interval(days => p_message_retention_days)
    order by created_at
    limit p_batch_limit
  )
  delete from public.agent_messages m
  using expired
  where m.id = expired.id;
  get diagnostics v_messages = row_count;

  with expired as (
    select id from public.ai_action_receipts
    where created_at < p_now - make_interval(days => p_receipt_retention_days)
    order by created_at
    limit p_batch_limit
  )
  delete from public.ai_action_receipts r
  using expired
  where r.id = expired.id;
  get diagnostics v_receipts = row_count;

  with expired as (
    select id from public.ai_action_confirmations
    where created_at < p_now - make_interval(days => p_confirmation_retention_days)
      and (consumed_at is not null or expires_at <= p_now)
    order by created_at
    limit p_batch_limit
  )
  delete from public.ai_action_confirmations c
  using expired
  where c.id = expired.id;
  get diagnostics v_confirmations = row_count;

  -- P6-04. A conversation is scrubbed, never deleted: `title` and
  -- `active_context` are cleared once the conversation itself is past the
  -- message window and no message of it survives, so referential integrity for
  -- receipts and confirmations is untouched. The `title is not null or
  -- active_context <> '{}'` predicate is what makes a second run report zero.
  with scrubbable as (
    select c.id
    from public.agent_conversations c
    where c.created_at < p_now - make_interval(days => p_message_retention_days)
      and (c.title is not null or c.active_context is distinct from '{}'::jsonb)
      and not exists (
        select 1 from public.agent_messages m where m.conversation_id = c.id
      )
    order by c.created_at
    limit p_batch_limit
  )
  update public.agent_conversations c
  set title = null,
      active_context = '{}'::jsonb
  from scrubbable
  where c.id = scrubbable.id;
  get diagnostics v_scrubbed = row_count;

  return query select v_messages, v_receipts, v_confirmations, v_scrubbed;
end;
$$;

comment on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) is
  'Phase 6 fixed-window assistant retention purge. Service-role only. Deletes expired agent_messages, ai_action_receipts, and spent/expired ai_action_confirmations, and scrubs (never deletes) the title and active_context of message-less expired agent_conversations; never deletes agent_conversations or audit_logs.';

-- The scrub scans conversations by age; keeps it off a seq scan as the table grows.
create index if not exists agent_conversations_created_at_idx
  on public.agent_conversations (created_at);

revoke all on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) to service_role;
