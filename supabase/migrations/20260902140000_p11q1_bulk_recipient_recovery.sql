-- P11Q.1 — recovering a recipient whose send was interrupted.
--
-- ## The gap this closes
--
-- `claim_bulk_message_recipient` moves a row to 'sending' and the runner records
-- the outcome afterwards. If the process dies in between — a deploy, a crash, a
-- platform timeout — the row stays 'sending' forever. The claim will never offer
-- it again (it only yields 'pending' and 'failed'), which is the *safe*
-- direction: nothing is resent. But the recipient is also invisible and stuck,
-- and fixing it required editing the database by hand.
--
-- ## Why there is no timeout-based auto-reclaim
--
-- The tempting fix is "anything 'sending' for more than N minutes goes back to
-- pending". That is exactly the change that can send a patient the same message
-- twice, because the interruption may have happened *after* WhatsApp accepted
-- the message and before the row was updated. No timeout can distinguish those
-- two cases, so no timeout is used.
--
-- Instead the interruption is made *visible* ('review'), and a human decides.
-- The application supplies that human with the one piece of evidence that
-- actually settles it: whether an ordinary `outbound_messages` row exists for
-- that conversation since the claim. That is the duplicate-risk boundary, and it
-- is checked in the resend path rather than guessed at here.

-- Measurable staleness. Set by the claim, so "how long has this been in flight"
-- stops being inferred from updated_at, which other writes also move.
alter table public.bulk_message_recipients
  add column if not exists claimed_at timestamptz;

-- 'review' — claimed, then interrupted; the outcome is genuinely unknown.
-- Deliberately NOT claimable: it takes an explicit human decision to leave.
alter table public.bulk_message_recipients
  drop constraint if exists bulk_message_recipients_status_check;
alter table public.bulk_message_recipients
  add constraint bulk_message_recipients_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'review'));

-- A row needing review always says why, like a skip does.
alter table public.bulk_message_recipients
  drop constraint if exists bulk_message_recipients_review_has_reason_check;
alter table public.bulk_message_recipients
  add constraint bulk_message_recipients_review_has_reason_check
    check (status <> 'review' or failure_code is not null);

/**
 * The claim, unchanged in what it will accept.
 *
 * Still only 'pending' and 'failed'. 'review' is absent on purpose: an
 * interrupted recipient cannot be picked up by an ordinary send, a resume, or a
 * "retry failed" — only by a person who has explicitly decided to resend it.
 * The single addition is stamping `claimed_at` so staleness is measurable.
 */
create or replace function public.claim_bulk_message_recipient(
  p_clinic_id uuid,
  p_recipient_id uuid
)
returns table (
  id uuid,
  conversation_id uuid,
  attempts smallint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.bulk_message_recipients as recipient
  set status = 'sending',
      attempts = recipient.attempts + 1,
      failure_code = null,
      claimed_at = now(),
      updated_at = now()
  where recipient.id = p_recipient_id
    and recipient.clinic_id = p_clinic_id
    and recipient.status in ('pending', 'failed')
  returning recipient.id, recipient.conversation_id, recipient.attempts;
$$;

revoke all on function public.claim_bulk_message_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_bulk_message_recipient(uuid, uuid) to service_role;

/**
 * Moves genuinely stale in-flight recipients into 'review'.
 *
 * This sends nothing and decides nothing. It only converts "silently stuck" into
 * "visibly needs a decision", which is the difference between a recipient a
 * clinic can act on and one they will never learn about.
 *
 * The staleness threshold is a *floor* enforced here so no caller can flag a
 * send that is merely in progress: a job running normally has rows in 'sending'
 * for seconds, and this refuses to touch anything younger than the threshold.
 */
create or replace function public.flag_stalled_bulk_recipients(
  p_clinic_id uuid,
  p_job_id uuid,
  p_stale_seconds integer
)
returns table (id uuid, conversation_id uuid)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.bulk_message_recipients as recipient
  set status = 'review',
      failure_code = 'interrupted',
      updated_at = now()
  where recipient.clinic_id = p_clinic_id
    and recipient.job_id = p_job_id
    and recipient.status = 'sending'
    and recipient.claimed_at is not null
    and recipient.claimed_at < now() - make_interval(secs => greatest(p_stale_seconds, 60))
  returning recipient.id, recipient.conversation_id;
$$;

revoke all on function public.flag_stalled_bulk_recipients(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.flag_stalled_bulk_recipients(uuid, uuid, integer) to service_role;

/**
 * Releases one reviewed recipient back to 'pending' so the ordinary claim can
 * pick it up.
 *
 * Only ever applied to a row in 'review', and only after the caller has
 * established that no outbound message exists for it since the claim. Keeping
 * this as its own statement — rather than folding it into the resend — means the
 * transition out of 'review' is always deliberate and always auditable.
 */
create or replace function public.release_bulk_recipient_for_retry(
  p_clinic_id uuid,
  p_recipient_id uuid
)
returns table (id uuid)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.bulk_message_recipients as recipient
  set status = 'pending',
      failure_code = null,
      claimed_at = null,
      updated_at = now()
  where recipient.id = p_recipient_id
    and recipient.clinic_id = p_clinic_id
    and recipient.status = 'review'
  returning recipient.id;
$$;

revoke all on function public.release_bulk_recipient_for_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_bulk_recipient_for_retry(uuid, uuid) to service_role;
