-- P4.10A: conversational entity context (session memory) core — patients only.
--
-- Adds a session-scoped active_context slot to the existing owner-scoped
-- agent_conversations row. Within one conversation the assistant can keep track
-- of the entity under discussion ("open Mohamed Hassan" -> "when was his last
-- visit?") without re-asking, resolving a pronoun/"this patient" follow-up to the
-- same server-derived patient id it already authorized.
--
-- Trust boundaries (all inherited from agent_conversations, unchanged here):
--   * Session-scoped only. The context lives and dies with the conversation
--     row: it is cleared when the conversation ends (status -> archived, below)
--     and removed by the existing clinic/owner cascade when the conversation is
--     deleted. It is never persistent memory, never cross-conversation, and
--     never cross-user.
--   * No new table, RLS policy, or grant. The column is governed by the existing
--     owner-scoped "agent_owner_all_conversations" policy, so a staff member can
--     only ever read or write the active context of their own conversation in
--     their own clinic. The operator panel still has no policy on this table.
--   * Advisory identity default only. active_context never grants access. Every
--     entity-scoped tool still re-runs role, entitlement, subscription, page
--     visibility, and RLS on every turn, so a stale or forged context can only
--     return what the same user could already fetch by naming the entity
--     explicitly — or nothing (found: false) once access is lost.
--
-- The detailed slot shape { entity_type, entity_id, display_label, set_at,
-- set_by } is validated in the TypeScript layer (lib/ai/conversation-context.ts),
-- both when written (server-derived ids only, never model free text) and when
-- read (a malformed or forward-version slot degrades to "no active context",
-- never a failed turn). The database check is intentionally minimal — a JSON
-- object — so P4.10B can add entity types without a schema change.

alter table public.agent_conversations
  add column active_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(active_context) = 'object');

comment on column public.agent_conversations.active_context is
  'P4.10A session-scoped active-entity context (patients in P4.10A). One optional '
  'slot per entity type: { entity_type, entity_id, display_label, set_at, set_by }. '
  'Advisory identity default only — never an authorization input. Set exclusively '
  'from a high-confidence entity resolution, an explicit user choice, or a page '
  'context launch (all server-derived ids). Cleared on conversation end (archive) '
  'and removed with the conversation on delete. Never persistent, never '
  'cross-conversation, never cross-user; excluded from any model-training path '
  'like the rest of the conversation.';

-- Clear the active context when a conversation ends. Deletion is already handled
-- by the row cascade; this covers the archive transition so no active entity
-- outlives the live conversation, satisfying the session-scoped guarantee
-- structurally rather than by application discipline.
create or replace function public.clear_agent_conversation_context()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'archived' and old.status is distinct from 'archived' then
    new.active_context := '{}'::jsonb;
  end if;
  return new;
end;
$$;

create trigger trg_agent_conversations_clear_context
  before update on public.agent_conversations
  for each row execute function public.clear_agent_conversation_context();
