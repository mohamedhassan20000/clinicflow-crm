-- P5B: inbox AI integration — per-clinic reply mode, human escalation state,
-- and suggested-reply records for the manual inbox. No change to P5A patient
-- tool authorization, booking caps/TTL, or identity gating.

-- ---------------------------------------------------------------------------
-- Per-clinic patient AI reply mode (§6.2)
-- ---------------------------------------------------------------------------
--
-- text + check, not an enum: the roadmap treats reply mode as a per-clinic
-- policy toggle, and Basic/Professional never see AI at all. `auto` is only
-- honored when the clinic additionally carries the `ai.patient_auto`
-- entitlement (resolved in the application); the column alone never grants it.
alter table public.clinics
  add column ai_reply_mode text not null default 'off'
    check (ai_reply_mode in ('off', 'suggest', 'auto'));

-- ---------------------------------------------------------------------------
-- Conversation-level human handoff / escalation state (§6.2, §6.6)
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column ai_escalated_at timestamptz,
  add column ai_escalation_reason text
    check (
      ai_escalation_reason is null
      or ai_escalation_reason in (
        'emergency',
        'human_requested',
        'medical',
        'complaint',
        'low_confidence',
        'agent_error'
      )
    ),
  add column ai_last_replied_at timestamptz;

-- ---------------------------------------------------------------------------
-- ai_suggested_replies — one row per AI-drafted patient reply (§6.2)
-- ---------------------------------------------------------------------------
--
-- In `suggest` mode the row is `pending` and a staff member approves (sends),
-- edits, or dismisses it in the inbox. In `auto` mode the row is written as
-- `sent` with the outbound message id, so the inbox shows exactly what the AI
-- said and staff retain a full record either way. The body is the clinic's own
-- AI draft over its own conversation; it carries no more PHI than the inbox
-- thread already shows staff.
create table public.ai_suggested_replies (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null,
  inbound_message_id uuid,
  ai_request_id uuid,
  mode text not null check (mode in ('suggest', 'auto')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'dismissed', 'superseded')),
  escalate boolean not null default false,
  escalation_reason text,
  outbound_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  constraint ai_suggested_replies_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.conversations(id, clinic_id)
    on delete cascade
);

create index ai_suggested_replies_conversation_idx
  on public.ai_suggested_replies (clinic_id, conversation_id, status, created_at desc);

-- At most one pending suggestion per conversation: a new inbound turn
-- supersedes the previous pending draft before inserting its own, so staff
-- never see a stale suggestion for an already-answered message.
create unique index ai_suggested_replies_one_pending_idx
  on public.ai_suggested_replies (clinic_id, conversation_id)
  where status = 'pending';

alter table public.ai_suggested_replies enable row level security;

-- Read-only for the inbox roles, exactly matching the conversation read
-- policy. Every write goes through the reviewed service-role paths (the
-- orchestrator records suggestions; the approve/dismiss actions mutate through
-- the clinic-scoped admin client), so there is no authenticated write policy —
-- the same posture as conversations/outbound_messages.
create policy "inbox_staff_read_own_ai_suggested_replies"
on public.ai_suggested_replies for select to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'receptionist'::public.user_role]
  )
);

create trigger trg_ai_suggested_replies_updated_at
  before update on public.ai_suggested_replies
  for each row execute function public.set_updated_at();

-- The inbox subscribes to suggestion changes so a drafted or auto-sent reply
-- appears live for staff. RLS still decides which rows each browser receives.
alter publication supabase_realtime add table public.ai_suggested_replies;
