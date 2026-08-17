-- AI Assistant full-capability plan, Phase 0 only: pre-existing persistence
-- hardening plus the capability-grained commercial feature vocabulary.
--
-- Deliberately out of scope here: Phase 0b's plan-slug decoupling, AI terms
-- predicate, commercial-limit resolver changes, and operator UI changes.

-- ---------------------------------------------------------------------------
-- H1 — agent_messages independently carries its parent authorization terms
-- ---------------------------------------------------------------------------

drop policy if exists "agent_owner_all_messages" on public.agent_messages;
create policy "agent_owner_all_messages"
on public.agent_messages
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1
    from public.agent_conversations c
    where c.id = agent_messages.conversation_id
      and c.clinic_id = agent_messages.clinic_id
      and c.clinic_id = public.auth_clinic_id()
      and c.user_id = auth.uid()
      and public.auth_role() = any (
        array[
          'admin'::public.user_role,
          'manager'::public.user_role,
          'doctor'::public.user_role,
          'receptionist'::public.user_role,
          'assistant'::public.user_role
        ]
      )
      and (
        c.patient_id is null
        or (
          public.auth_role() = any (
            array['doctor'::public.user_role, 'assistant'::public.user_role]
          )
          and exists (
            select 1
            from public.patients p
            where p.id = c.patient_id
              and p.clinic_id = c.clinic_id
              and p.is_deleted = false
              and p.deleted_at is null
          )
        )
      )
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1
    from public.agent_conversations c
    where c.id = agent_messages.conversation_id
      and c.clinic_id = agent_messages.clinic_id
      and c.clinic_id = public.auth_clinic_id()
      and c.user_id = auth.uid()
      and public.auth_role() = any (
        array[
          'admin'::public.user_role,
          'manager'::public.user_role,
          'doctor'::public.user_role,
          'receptionist'::public.user_role,
          'assistant'::public.user_role
        ]
      )
      and (
        c.patient_id is null
        or (
          public.auth_role() = any (
            array['doctor'::public.user_role, 'assistant'::public.user_role]
          )
          and exists (
            select 1
            from public.patients p
            where p.id = c.patient_id
              and p.clinic_id = c.clinic_id
              and p.is_deleted = false
              and p.deleted_at is null
          )
        )
      )
  )
);

-- ---------------------------------------------------------------------------
-- H2 — stable message replay when one insert gives a turn one created_at
-- ---------------------------------------------------------------------------

alter table public.agent_messages
  add column sequence bigint;

with ranked_messages as (
  select
    id,
    row_number() over (
      partition by conversation_id
      order by
        created_at,
        case role
          when 'user'::public.agent_message_role then 0
          when 'tool'::public.agent_message_role then 1
          when 'assistant'::public.agent_message_role then 2
        end,
        id
    ) as sequence
  from public.agent_messages
)
update public.agent_messages as message
set sequence = ranked.sequence
from ranked_messages as ranked
where ranked.id = message.id;

alter table public.agent_messages
  alter column sequence set not null,
  alter column sequence add generated always as identity;

select setval(
  pg_get_serial_sequence('public.agent_messages', 'sequence'),
  greatest(coalesce((select max(sequence) from public.agent_messages), 0) + 1, 1),
  false
);

create unique index agent_messages_conversation_sequence_idx
  on public.agent_messages (conversation_id, sequence);

drop index if exists public.agent_messages_conversation_idx;
create index agent_messages_conversation_idx
  on public.agent_messages (conversation_id, created_at desc, sequence desc);

comment on column public.agent_messages.sequence is
  'Stable server-generated replay tiebreaker. Historical rows are backfilled in '
  'created_at and role order; future rows use the identity sequence.';

-- ---------------------------------------------------------------------------
-- M1 — self-readable AI grants remain tenant-bound in the policy itself
-- ---------------------------------------------------------------------------

drop policy if exists "Users can read own ai permissions"
  on public.user_ai_permissions;
create policy "Users can read own ai permissions"
  on public.user_ai_permissions
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and clinic_id = public.auth_clinic_id()
  );

-- ---------------------------------------------------------------------------
-- Capability feature seed — catalog data only; Phase 0b changes no resolver
-- ---------------------------------------------------------------------------

update public.plans
set features = coalesce(features, '{}'::jsonb) || jsonb_build_object(
      'ai.read_operational', true,
      'ai.read_clinical', true,
      'ai.read_financial', true,
      'ai.write_scheduling', true,
      'ai.write_records', true,
      'ai.write_administration', true,
      'ai.write_privileged', true,
      'ai.documents', true,
      'ai.bulk_export', true
    ),
    updated_at = clock_timestamp()
where slug = 'pro_ai';
