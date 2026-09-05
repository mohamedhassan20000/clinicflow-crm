-- P11Q — operational bulk send from the Inbox.
--
-- A receptionist needs to tell eleven people the doctor is off sick. Today that
-- is eleven manual sends, and the eleventh gets forgotten. This adds the
-- smallest durable record that makes one action out of eleven, and nothing more:
-- it is a staff tool for conversations that already exist, not a campaign
-- system. There is no audience builder, no scheduling, no recurrence, and no way
-- to reach anyone the clinic is not already talking to.
--
-- ## What is deliberately NOT here
--
-- The message content is stored once, on the job. The *messages* are ordinary
-- `outbound_messages` rows written by the ordinary send path, and a recipient
-- row only points at the one it produced. Delivery state (sent → delivered →
-- read → failed) is therefore not duplicated here: this table records the
-- handoff, `outbound_messages` records the delivery, and there is exactly one
-- source of truth for each. Duplicating delivery state is how the Inbox and the
-- bulk view would eventually disagree about the same message.
--
-- No clinical data is recorded. A recipient is a conversation id.

create table if not exists public.bulk_message_jobs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Audit: the staff member who pressed send. There is no existing audit_log
  -- table, so this column *is* the audit record for a bulk action.
  created_by uuid not null,
  body text not null check (length(btrim(body)) between 1 and 4096),
  -- 'completed' means every recipient succeeded. A job with even one failure
  -- reports 'completed_with_failures' instead, so no caller can mistake a
  -- partial send for a clean one.
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'completed_with_failures', 'failed')),
  total_recipients integer not null check (total_recipients between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint bulk_message_jobs_created_by_clinic_fkey
    foreign key (created_by, clinic_id)
    references public.profiles(id, clinic_id)
);

create index if not exists bulk_message_jobs_clinic_created_idx
  on public.bulk_message_jobs (clinic_id, created_at desc);

create table if not exists public.bulk_message_recipients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  job_id uuid not null references public.bulk_message_jobs(id) on delete cascade,
  conversation_id uuid not null,
  -- The ordinary outbound record this recipient produced, once the normal send
  -- path has written one. Null until then, and the evidence that makes an
  -- interrupted send distinguishable from one that never started.
  outbound_message_id uuid,
  -- 'pending'  — selected, not yet claimed.
  -- 'sending'  — claimed by exactly one worker/request. See the claim below.
  -- 'sent'     — handed to the send path. Terminal: never re-claimed, which is
  --              what makes retry incapable of double-sending.
  -- 'failed'   — the send path refused or errored. Retryable.
  -- 'skipped'  — refused before sending (no address, wrong channel). Terminal,
  --              and always carries a reason: a silently dropped recipient is
  --              the failure mode this whole feature exists to avoid.
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  -- A stable code (a SendErrorCode, or a skip reason). Never provider text.
  failure_code text check (failure_code is null or length(failure_code) <= 64),
  attempts smallint not null default 0 check (attempts >= 0),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bulk_message_recipients_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete cascade,
  -- Terminal success always names the message it produced.
  constraint bulk_message_recipients_sent_has_message_check
    check (status <> 'sent' or outbound_message_id is not null),
  constraint bulk_message_recipients_skipped_has_reason_check
    check (status <> 'skipped' or failure_code is not null)
);

-- The idempotency constraint. One row per recipient per job means a
-- double-submitted job cannot enqueue the same conversation twice, and the
-- claim below cannot hand the same recipient to two senders.
create unique index if not exists bulk_message_recipients_unique_idx
  on public.bulk_message_recipients (job_id, conversation_id);

create index if not exists bulk_message_recipients_job_status_idx
  on public.bulk_message_recipients (job_id, status);

alter table public.bulk_message_jobs enable row level security;
alter table public.bulk_message_recipients enable row level security;

-- Staff read their own clinic's jobs. Every write goes through the service role
-- so that claiming, sending and finalizing stay in one audited server path.
drop policy if exists "bulk_staff_read_own_jobs" on public.bulk_message_jobs;
create policy "bulk_staff_read_own_jobs"
on public.bulk_message_jobs for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

drop policy if exists "bulk_staff_read_own_recipients" on public.bulk_message_recipients;
create policy "bulk_staff_read_own_recipients"
on public.bulk_message_recipients for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

grant select on table public.bulk_message_jobs to authenticated;
grant select on table public.bulk_message_recipients to authenticated;
grant all on table public.bulk_message_jobs to service_role;
grant all on table public.bulk_message_recipients to service_role;

/**
 * The claim.
 *
 * This is the whole idempotency story in one statement. A recipient moves to
 * 'sending' only from 'pending' or 'failed', and only one caller can win that
 * transition because the UPDATE takes a row lock and the predicate is re-checked
 * under it. A recipient already 'sent' matches nothing and is returned to
 * nobody, so a retry — whether from a double-clicked button, a second tab, a
 * page refresh, or a process that restarted mid-job — physically cannot hand an
 * already-sent recipient to the send path again.
 *
 * Returning the row (rather than a boolean) is what lets the caller send only
 * what it actually won.
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
      updated_at = now()
  where recipient.id = p_recipient_id
    and recipient.clinic_id = p_clinic_id
    and recipient.status in ('pending', 'failed')
  returning recipient.id, recipient.conversation_id, recipient.attempts;
$$;

revoke all on function public.claim_bulk_message_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_bulk_message_recipient(uuid, uuid) to service_role;

-- Progress without polling: the Inbox already subscribes to conversations,
-- inbound_messages, outbound_messages and ai_suggested_replies. Recipients join
-- that same subscription rather than introducing a timer.
alter publication supabase_realtime add table public.bulk_message_recipients;
