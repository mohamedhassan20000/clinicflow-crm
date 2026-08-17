-- Phase 6: assistant retention (audit finding M2 and §12 receipt retention).
--
-- Phase 2 widened the field surface the assistant may read, so more clinical
-- narrative now flows through `agent_messages` and stays there indefinitely.
-- This migration adds the purge half of a fixed-window retention policy. It
-- adds no capability, no document behaviour, and no plan/billing surface.
--
-- Decision 6 of the plan: a fixed default window, expressed as one named
-- constant per dataset, with a scheduled purge. Clinic-configurable retention
-- is deliberately *not* implemented — the windows are function arguments rather
-- than literals inside the SQL, so making them per-clinic later is a lookup
-- change here and nowhere else.
--
-- What is deleted and what is not:
--   * agent_messages           — transcript text. Deleted past the window.
--   * agent_conversations      — NOT deleted. Its children (`ai_action_receipts`,
--                                `ai_action_confirmations`) cascade from it, so
--                                purging a conversation would silently destroy
--                                accountability records that outlive it.
--   * ai_action_receipts       — the §12 mutation ledger. Deleted past its own,
--                                deliberately much longer, window.
--   * ai_action_confirmations  — short-lived control plane. Deleted once the
--                                token is spent or expired and the grace window
--                                has passed. Never deleted while claimable.
--
-- `audit_logs` is untouched: it is the clinic's own permanent audit trail and
-- has never been AI-scoped.

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
  deleted_confirmations integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_messages integer := 0;
  v_receipts integer := 0;
  v_confirmations integer := 0;
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

  return query select v_messages, v_receipts, v_confirmations;
end;
$$;

comment on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) is
  'Phase 6 fixed-window assistant retention purge. Service-role only. Deletes expired agent_messages, ai_action_receipts, and spent/expired ai_action_confirmations; never deletes agent_conversations or audit_logs.';

-- The purge scans by age on each table; these keep it from becoming a seq scan
-- as the datasets grow.
create index if not exists agent_messages_created_at_idx
  on public.agent_messages (created_at);
create index if not exists ai_action_receipts_created_at_idx
  on public.ai_action_receipts (created_at);
create index if not exists ai_action_confirmations_created_at_idx
  on public.ai_action_confirmations (created_at);

revoke all on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.purge_ai_retention_data(
  integer, integer, integer, timestamptz, integer
) to service_role;
